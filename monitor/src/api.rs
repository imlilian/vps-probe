//! The panel and public-status HTTP surface.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Local, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::agent_ws::Agent;
use crate::auth::{
    authed, client_ip, confirm_password, current_session, hash_password, issue_session, issued_at,
    random_token, with_cookies,
};
use crate::db::{self, Db, Node, NodePatch, PingTask, Traffic, TrafficPatch};
use crate::{agent_ws, App, Shared};

/// Present only on requests carrying a valid session. Handlers taking it cannot
/// be reached unauthenticated, so the check cannot be omitted.
pub struct Admin;

impl FromRequestParts<Shared> for Admin {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, app: &Shared) -> Result<Self, Self::Rejection> {
        if authed(app, &parts.headers) {
            Ok(Admin)
        } else {
            Err(answer(StatusCode::UNAUTHORIZED, "登录已失效，请重新登录"))
        }
    }
}

/// Whether a page other than the panel sent this request. `SameSite=Lax` holds
/// a cookie back from other *sites*, but a sibling subdomain of the hub's
/// registrable domain is the same site: its script may send a request without a
/// body (`no-cors`, no preflight) and the cookie goes along, which suffices for
/// a token reset or a vacuum. Browsers name where a request came from in
/// `Sec-Fetch-Site`; only `same-origin` is the panel itself. The header is
/// absent from a client that is not a browser, from a browser too old to send
/// it, and from every browser on a plain-http address other than loopback; the
/// last two are not told apart from the panel.
fn from_other_origin(headers: &HeaderMap) -> bool {
    headers.get("sec-fetch-site").is_some_and(|site| site != "same-origin")
}

fn cross_site_write(method: &Method, headers: &HeaderMap) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) && from_other_origin(headers)
}

/// Refuses writes from another origin before any handler sees them, so a route
/// added later is covered without remembering to ask.
pub async fn same_origin_writes(request: Request, next: Next) -> Response {
    if cross_site_write(request.method(), request.headers()) {
        return answer(StatusCode::FORBIDDEN, "请求来自其他网站，已拒绝");
    }
    next.run(request).await
}

/// Marks a response whose text was written for the reader; see [`plain_errors`].
#[derive(Clone)]
struct Written;

/// An error response carrying `text` as written. Every error the hub composes
/// is built here.
pub(crate) fn answer(status: StatusCode, text: impl Into<String>) -> Response {
    let mut response = (status, text.into()).into_response();
    response.extensions_mut().insert(Written);
    response
}

/// What a failure this hub cannot explain to the reader says instead.
pub(crate) const INTERNAL: &str = "hub 内部出错，详细原因见 hub 日志";

/// Answers an error: 400 with the outermost [`crate::Shown`] message in its
/// chain, or, without one, 500 with [`INTERNAL`]. The chain is logged in full
/// either way, the underlying cause of a shown message included.
pub(crate) fn fail(e: impl Into<anyhow::Error>) -> Response {
    let e = e.into();
    match e.downcast_ref::<crate::Shown>() {
        Some(shown) => {
            info!("request refused: {e:#}");
            answer(StatusCode::BAD_REQUEST, shown.0.clone())
        }
        None => {
            warn!("request failed: {e:#}");
            answer(StatusCode::INTERNAL_SERVER_ERROR, INTERNAL)
        }
    }
}

fn bad(message: &str) -> Response {
    answer(StatusCode::BAD_REQUEST, message)
}

fn no_such_node() -> Response {
    answer(StatusCode::NOT_FOUND, "节点不存在，可能已被删除")
}

/// The last step of every response. An error the hub composed passes as it is;
/// any other -- an extractor's rejection, the body limit's 413, a bare status --
/// would carry axum's English wording or nothing, and is given a fixed text for
/// its status instead.
pub async fn plain_errors(response: Response) -> Response {
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error())
        || response.extensions().get::<Written>().is_some()
    {
        return response;
    }
    let text = match status {
        StatusCode::UNAUTHORIZED => "登录已失效，请重新登录",
        StatusCode::NOT_FOUND => "请求的内容不存在",
        StatusCode::PAYLOAD_TOO_LARGE => "提交的内容过大",
        s if s.is_server_error() => INTERNAL,
        _ => "请求格式不对",
    };
    // Only the body is replaced: a 405 keeps its `Allow`, for one.
    let (mut parts, _) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("text/plain; charset=utf-8"));
    Response::from_parts(parts, text.into())
}

// ---- read paths, shared between the panel and the public page ----

/// Everything a report may expose under `metrics`: the agent contract minus the
/// raw kernel counters, which are a wire-protocol detail disclosing a machine's
/// entire lifetime traffic, plus the four traffic figures `node_view` fills in.
/// The panel additionally sees `iface`.
pub(crate) const PUBLIC_METRICS: [&str; 18] = [
    "uptime",
    "cpu",
    "load",
    "mem_total",
    "mem_used",
    "swap_total",
    "swap_used",
    "disk_total",
    "disk_used",
    "net_rx",
    "net_tx",
    "tcp",
    "udp",
    "procs",
    "total_rx",
    "total_tx",
    "month_rx",
    "month_tx",
];

/// The addresses the panel shows for a node, each with where it comes from: at
/// most one per family, v4 first, the one the machine is reached by. The agent
/// reports its interfaces; `exits` are where the hub saw it: the address its
/// session arrived from, and the one a short second connection arrived from in
/// the other family, each in dotted form for IPv4.
///
/// Per family an address set by hand comes first, then a public one on the
/// interface. Failing both, where the interface holds only a private address of
/// that family -- NAT, or a proxy in front -- the public address the hub saw in
/// it, its exit, stands in. An exit in a family the interface does not hold is a
/// translator such as NAT64 or WARP and is left out.
///
/// Private addresses appear only when nothing public is known, as where hub and
/// node share a network and they are all there is. The session's own exit alone
/// is the fallback for an agent reporting no interface.
fn addresses<'a>(
    exits: [&'a str; 2],
    (ipv4, ipv6): (&'a str, &'a str),
    (pin4, pin6): (&'a str, &'a str),
) -> Vec<(&'a str, &'static str)> {
    let public =
        |a: &str, v6: bool| a.parse::<IpAddr>().is_ok_and(|a| a.is_ipv6() == v6 && agent_ws::public(a));
    let family = |pin: &'a str, held: &'a str, v6: bool| {
        if !pin.is_empty() {
            Some((pin, "manual"))
        } else if public(held, v6) {
            Some((held, "interface"))
        } else if held.is_empty() {
            None
        } else {
            exits.into_iter().find(|ip| public(ip, v6)).map(|exit| (exit, "exit"))
        }
    };
    let shown: Vec<_> = [family(pin4, ipv4, false), family(pin6, ipv6, true)].into_iter().flatten().collect();
    if !shown.is_empty() {
        return shown;
    }
    let held: Vec<_> = [ipv4, ipv6].into_iter().filter(|a| !a.is_empty()).map(|a| (a, "interface")).collect();
    if !held.is_empty() {
        return held;
    }
    [exits[0]].into_iter().filter(|a| !a.is_empty()).map(|a| (a, "connection")).collect()
}

/// One node as the UI consumes it: stored config, live metrics and the hub's
/// accumulated traffic in a single object.
fn node_view(
    node: &Node,
    current: Option<&Agent>,
    traffic: &Traffic,
    full: bool,
    now: DateTime<Local>,
) -> Value {
    // The three capacities arrive in every `Metrics`. The stored figure follows the
    // reports a minute at a time and as the session ends, so it lags a disk mounted
    // while the agent runs -- the agent re-reads its mount table every sample so
    // that it appears -- by up to a minute. Using the report while a node is
    // connected keeps every consumer of this view on one number: the card reads the
    // live metrics and the detail page reads these, which would otherwise show the
    // same machine two different capacities. Offline, the stored figure is the last
    // one reported. No floor is applied: a host whose swap has just been disabled
    // reports zero and means it. A node connected but not yet reporting holds
    // `Null`, where `get` returns nothing and the stored figure stands.
    let live = |key: &str, stored: i64| {
        current.and_then(|a| a.metrics.get(key).and_then(serde_json::Value::as_i64)).unwrap_or(stored)
    };
    // The live entry while connected, the stored one afterwards. Zero means
    // connected but not yet reporting, which is not a timestamp, so it falls
    // back to the stored value and "offline since" survives the gap.
    let last_seen = current.map(|a| a.last_seen).filter(|t| *t > 0).unwrap_or(node.last_seen);
    let mut view = json!({
        "id": node.id,
        "name": node.name,
        // A country rather than an address: it indicates which region a node sits
        // in, which is what a status page conveys, without locating it. The
        // address it was derived from remains behind the panel.
        "country": if node.country_pin.is_empty() { &node.country } else { &node.country_pin },
        // Named by the operator for the status page to divide the list by, so
        // public like the node's name. Empty is ungrouped.
        "group": node.group,
        // Written by the operator for visitors, unlike `remark` below.
        "public_remark": node.public_remark,
        "sort": node.sort,
        "public": node.public,
        "online": current.is_some(),
        "last_seen": last_seen,
        // Counted on the hub's clock, for the same reason as `expires_in`: a page
        // subtracting `last_seen` from its own clock is off by as much as that
        // clock is, and one eight hours fast shows a node that dropped a minute
        // ago as offline for eight hours. Null for a node never seen.
        "last_seen_ago": (last_seen > 0).then(|| (now.timestamp() - last_seen).max(0)),
        "metrics": current.map(|a| a.metrics.clone()).unwrap_or(Value::Null),
        "os": node.os,
        "kernel": node.kernel,
        "arch": node.arch,
        "virt": node.virt,
        "cpu_name": node.cpu_name,
        "cpu_cores": node.cpu_cores,
        "mem_total": live("mem_total", node.mem_total),
        "swap_total": live("swap_total", node.swap_total),
        "disk_total": live("disk_total", node.disk_total),
        "agent_version": node.agent_version,
        "price": node.price,
        "currency": node.currency,
        "billing_cycle": node.billing_cycle,
        "expires_at": node.expires_at,
        // Counted on the hub's calendar, the one renewal follows. A page counting
        // on the visitor's clock would, with the hub on UTC and the visitor on
        // UTC+8, show every online node expired for eight hours each cycle
        // before the hub rolls its date forward.
        "expires_in": node.expires_at.as_deref().and_then(|d| d.parse::<NaiveDate>().ok()).map(|d| (d - now.date_naive()).num_days()),
        "traffic_limit": node.traffic_limit,
        "traffic_mode": node.traffic_mode,
        "traffic_reset_day": node.traffic_reset_day,
        "total_rx": traffic.total_rx,
        "total_tx": traffic.total_tx,
        "month_rx": traffic.month_rx,
        "month_tx": traffic.month_tx,
        "month_used": traffic.month_used(&node.traffic_mode),
        "month_start": traffic.month_start,
        // Of the same nature as the month and lifetime figures beside it, which
        // the public page already shows, so this one is public as well.
        "day_rx": traffic.day_rx,
        "day_tx": traffic.day_tx,
    });
    // An allowlist rather than a denylist, for the panel as well: the agent ships
    // from its own repository, so a field added there would otherwise reach
    // anonymous visitors the day it is released, and a node token in the wrong
    // hands could fill the panel's frame with whatever it sends. No address,
    // hostname or private note may ever reach a visitor.
    if let Some(m) = view["metrics"].as_object_mut() {
        m.retain(|k, _| PUBLIC_METRICS.contains(&k.as_str()) || (full && k == "iface"));
        // The same figures as the top-level ones, from the same row. The public
        // page refuses a node's live view without them.
        for (key, value) in agent_ws::INJECTED.into_iter().zip([
            traffic.total_rx,
            traffic.total_tx,
            traffic.month_rx,
            traffic.month_tx,
        ]) {
            m.insert(key.into(), json!(value));
        }
    }
    // Address and private notes never leave the panel. The token is not here at
    // all: the panel reads it from `node_token` as it shows the install command.
    if full {
        let held = (node.ipv4.as_str(), node.ipv6.as_str());
        let (pin4, pin6) = (node.ipv4_pin.as_str(), node.ipv6_pin.as_str());
        let exits = [node.ip.as_str(), node.ip_other.as_str()];
        let shown = addresses(exits, held, (pin4, pin6));
        // What each family shows with its own pin cleared and the other's kept,
        // for the edit form to offer as the fallback.
        let auto = |pins, v6: bool| {
            addresses(exits, held, pins)
                .into_iter()
                .find(|(a, _)| a.contains(':') == v6)
                .map_or("", |(a, _)| a)
        };
        view["hostname"] = json!(node.hostname);
        view["ip"] = json!(node.ip);
        view["ipv4"] = json!(node.ipv4);
        view["ipv6"] = json!(node.ipv6);
        view["ipv4_pin"] = json!(node.ipv4_pin);
        view["ipv6_pin"] = json!(node.ipv6_pin);
        view["addresses"] =
            shown.iter().map(|(address, source)| json!({"address": address, "source": source})).collect();
        view["ipv4_auto"] = json!(auto(("", pin6), false));
        view["ipv6_auto"] = json!(auto((pin4, ""), true));
        view["interval"] = json!(current.and_then(Agent::interval));
        view["country_pin"] = json!(node.country_pin);
        view["country_auto"] = json!(node.country);
        view["remark"] = json!(node.remark);
        view["notify"] = json!(node.notify);
    }
    view
}

fn visible_nodes(app: &App, full: bool) -> Result<Vec<Value>, anyhow::Error> {
    // One traffic query and one lock for the whole list, since this is what every
    // visitor to the public page loads.
    let nodes = app.db.nodes()?;
    let traffic = app.db.all_traffic();
    let agents = app.agents.read().unwrap_or_else(|e| e.into_inner());
    let none = Traffic::default();
    let now = Local::now();
    Ok(nodes
        .iter()
        .filter(|n| full || n.public)
        .map(|n| node_view(n, agents.get(&n.id), traffic.get(&n.id).unwrap_or(&none), full, now))
        .collect())
}

pub async fn nodes(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let full = authed(&app, &headers);
    if !full && !app.public_page() {
        return answer(StatusCode::UNAUTHORIZED, "需要登录后查看");
    }
    // The same rendered frame the browser streams receive, for the same reason:
    // otherwise every visitor would rebuild every node's row against the
    // connection the agents write through.
    //
    // Compressed likewise, once per frame: left to the compression layer, every
    // request deflates the whole list again, about 6 ms of CPU for a thousand
    // nodes, and this route answers anyone. Already encoded, the layer passes
    // it through without adding the Vary it adds to what it compresses.
    if !full && accepts_gzip(&headers) {
        return (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CONTENT_ENCODING, "gzip"),
                (header::VARY, "accept-encoding"),
            ],
            live_gzip(&app),
        )
            .into_response();
    }
    let mut res =
        ([(header::CONTENT_TYPE, "application/json")], axum::body::Bytes::from(live_snapshot(&app, full)))
            .into_response();
    // Uncompressed by the hub and by Cloudflare, as the admin stream is: every
    // node's address and private notes beside strings an agent reports.
    if full {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store, no-transform"));
    }
    res
}

#[derive(Deserialize)]
pub struct Window {
    #[serde(default = "default_hours")]
    hours: i64,
    /// How many points the caller can draw. Absent means the full budget.
    points: Option<i64>,
    /// Which half the caller will draw, `metrics` or `ping`. Each tab draws one,
    /// and the other accounted for a third to two thirds of every response. Absent
    /// means both.
    series: Option<String>,
}

fn default_hours() -> i64 {
    6
}

/// How many history windows are built concurrently.
///
/// `span` bounds what one request costs; this bounds how many may run,
/// closing the same gap `main::RELAY_GATE` and `auth::PASSWORD_GATE` close on
/// the other two paths an anonymous caller can make expensive. This is the most
/// expensive of the three: a week of probe results is a scan of 98 ms at four
/// 60-second probes and 486 ms at eight 10-second ones, growing with the probes
/// the admin configured rather than with anything the caller sends.
///
/// The scans run on the database's read-only connection, so the agents' writes
/// do not wait on them, and they serialise on that one connection instead. Four,
/// because a fifth in flight buys no throughput and only lengthens the wait
/// behind the others: what the number sets is how long a chart can wait, four
/// scans of the slower kind being 2 s, while leaving room for several people
/// opening charts simultaneously.
///
/// Refused rather than queued, as in `auth`: a queue admits the same flood,
/// merely later, and each request waiting in it holds a blocking thread.
///
/// **This gate is ineffective without the `spawn_blocking` below.** The body of
/// this handler never awaits, so a permit taken and dropped within it is held
/// only while a worker thread is actually running the handler -- at most one per
/// worker, three on this hub. Measured at eight: 120 concurrent requests, zero
/// refusals, the panel still at 14 s. This is the same constraint
/// `PASSWORD_CHECKS` is sized against, approached from the other side: not a
/// value too high for the machine, but a handler that cannot hold more permits
/// than the machine has threads. Moving the scan off the runtime is what makes
/// "in flight" meaningful, and is what every other heavy query here already
/// does.
const HISTORY_SLOTS: usize = 4;
static HISTORY_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(HISTORY_SLOTS);

pub async fn metrics(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(w): Query<Window>,
) -> Response {
    let full = authed(&app, &headers);
    if !readable(&app, full, id) {
        return answer(StatusCode::UNAUTHORIZED, "需要登录后查看");
    }
    // After the two point lookups above, so an unauthorised caller is told so
    // rather than asked to retry later.
    let Ok(_permit) = HISTORY_GATE.try_acquire() else {
        return answer(StatusCode::SERVICE_UNAVAILABLE, "查询历史的请求太多，稍后再试");
    };
    let hours = w.hours.clamp(1, app.db.retention_days() * 24);
    let span = span(hours, w.points, Utc::now().timestamp());
    let wants = |name: &str| w.series.as_deref().is_none_or(|s| s == name);
    let (want_metrics, want_ping) = (wants("metrics"), wants("ping"));
    // Off the runtime: this reads every probe result the node has retained
    // within the window, and a worker thread blocked on that scan, or on the
    // reader while another request holds it, serves nothing else.
    //
    // It is also what makes the gate above effective: the permit is held across
    // an await, so exactly four callers are inside it at once rather than however
    // many worker threads happen to exist.
    let built = tokio::task::spawn_blocking(move || {
        // Probe names accompany the samples they label, so the page needs no
        // second request. Names only: targets and assignments remain behind
        // `Admin`. Skipped when probes were not requested, since the resources tab
        // has nothing to label and this costs a turn at the reader.
        let probes =
            if want_ping { app.db.ping_task_names(id).unwrap_or_else(|_| json!({})) } else { json!({}) };
        let metrics = if want_metrics { app.db.metrics(id, span)? } else { vec![] };
        // `loss` is per probe across the whole window, alongside the per-bucket
        // `loss` on the rows. Both are required and neither replaces the other:
        // the row figure is what a tooltip reads, while the window figure is the
        // only one that can be accurate, since the denominators it divides by are
        // gone by the time the rows are built. Additive, so a reader unaware of it
        // continues to work.
        let (ping, loss) = if want_ping { app.db.ping_records(id, span)? } else { (vec![], json!({})) };
        // `step` is the seconds each point spans, against which a row's `minutes`
        // is read; inferred from the stamps instead, it would be missing for a
        // window holding a single point. The last point is the bucket still in
        // progress and holds only the minutes elapsed.
        anyhow::Ok(json!({
            "metrics": metrics, "ping": ping, "probes": probes, "loss": loss, "step": span.step,
        }))
    })
    .await;
    match built.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
        Ok(body) => Json(body).into_response(),
        Err(e) => fail(e),
    }
}

/// The window a chart request is answered with: `hours` back from `now`,
/// widened to the point boundary at or before that.
///
/// The width is capped by the retention window alone, the same for every
/// caller, because no width costs more than the week: up to `DETAIL_DAYS` a
/// request reads minute rows, 10,080 per series at most, and past it hourly
/// rows, 8,760 per series at a year, with the minute rows not yet folded, which
/// `Db::metrics` bounds to the newest week. The scan is what a request costs --
/// the thinning below bounds the response, not the rows read -- so a width
/// reading more than the week would need a lower ceiling for anonymous callers.
///
/// Thinning exists for what the screen cannot draw rather than as a convention:
/// where the samples fit, every one is sent. A chart of a hundred points reads
/// as a hundred samples taken, which for a probe is a claim about the network.
/// Whole minutes, matching the grid the metric rows sit on, and whole hours
/// past the week, so that no hourly row straddles two points.
///
/// `points` is what the caller reports it can draw, and can only lower the
/// budget: `SAMPLES` is the hub's ceiling rather than the caller's, set at a day
/// of minutes so the day's probe window returns intact.
// ponytail: the budget is per series, so a response is SAMPLES × (1 + probes) --
// bounded by how many probes the admin created, not by the caller. Four probes
// at a day is ~90 kB gzipped; if that list ever grows long, scale SAMPLES by
// the probe count.
fn span(hours: i64, points: Option<i64>, now: i64) -> db::Span {
    const SAMPLES: i64 = 1_440;
    let budget = points.unwrap_or(SAMPLES).clamp(60, SAMPLES);
    let hourly = hours > db::DETAIL_DAYS * 24;
    let unit = if hourly { 3_600 } else { 60 };
    // Rounded up, or the budget would not be one: a window that does not divide
    // evenly would keep the finer step and exceed it. `i64::div_ceil` is still
    // unstable, and both operands are positive here.
    let step = unit * ((hours * 3_600 / unit + budget - 1) / budget).max(1);
    // Rows are bucketed by `ts / step` from the epoch, and a window opening
    // partway through a bucket would leave its first point short of the
    // `step / 60` minutes a whole one holds.
    db::Span { since: (now - hours * 3_600).div_euclid(step) * step, step, hourly }
}

/// Guards a per-node read: the panel sees everything, while the public page sees
/// only nodes explicitly published. `full` is the caller's own `authed`, passed
/// in because the handler also needs it for the window ceiling.
fn readable(app: &App, full: bool, id: i64) -> bool {
    full || (app.public_page() && app.db.node(id).ok().flatten().is_some_and(|n| n.public))
}

/// Per-connection read buffer for both WebSocket surfaces. The 128 KiB default
/// would be tens of megabytes across a few hundred agents, for frames a few
/// hundred bytes long.
pub const SOCKET_BUFFER: usize = 4 * 1024;

/// Largest frame either socket accepts, matching the 64 KiB cap on the HTTP
/// body. That limit is a tower layer and never applies here, where the default
/// ceiling is 64 MiB -- reachable with a node's own token, for content that is
/// stored and then served to every viewer of the public page.
pub const MAX_FRAME: usize = 64 * 1024;

/// How long one rendered snapshot is reused. Just under the push interval, so
/// every tick rebuilds once and no viewer receives a stale frame twice.
const SNAPSHOT_TTL_MS: i64 = 1_900;

/// One audience's node list, as every browser stream and `/api/nodes` send it.
#[derive(Default)]
pub struct Frame {
    /// The millisecond it was built.
    at: i64,
    json: Utf8Bytes,
    /// `json` gzipped, made by the first stream or `/api/nodes` request that asks for it.
    gzip: Option<axum::body::Bytes>,
}

/// Runs `read` on one audience's frame, rebuilt first once it has expired. A
/// frame is built at most once per tick however many tabs are watching: the
/// public page is anonymous, so a per-connection build would make viewer count
/// a multiplier on database work. Two slots, because the admin view carries
/// fields the public one must never expose.
fn current<T>(app: &App, full: bool, read: impl FnOnce(&mut Frame) -> T) -> T {
    let now = Utc::now().timestamp_millis();
    // Held while the frame is built, so that tabs ticking together build it
    // once; the rest wait for it off the runtime, as for the database.
    let mut cache = db::lock(&app.snapshot);
    let frame = &mut cache[usize::from(full)];
    // A cached frame's age must be non-negative. A wall clock can step backwards
    // -- NTP correcting a fresh boot -- and against a bare upper bound the
    // resulting negative reads as young, pinning the panel to a stale frame until
    // real time catches up.
    if !(0..SNAPSHOT_TTL_MS).contains(&now.saturating_sub(frame.at)) {
        let nodes = visible_nodes(app, full).unwrap_or_default();
        // `admin` is included so the panel's first fetch and its stream share one
        // cached frame. `at` is the millisecond this frame was built, and it is
        // what the detail page stamps a live sample with: the newest points then
        // sit on the same clock as the history buckets behind them -- the hub's,
        // not whichever clock the browser happens to keep.
        let json = json!({"nodes": nodes, "admin": full, "at": now}).to_string().into();
        *frame = Frame { at: now, json, gzip: None };
    }
    read(frame)
}

fn live_snapshot(app: &App, full: bool) -> Utf8Bytes {
    current(app, full, |frame| frame.json.clone())
}

/// Whether `Accept-Encoding` lists gzip with a nonzero weight. A wildcard is
/// not read as gzip: browsers name gzip itself, and any other request is still
/// compressed by the compression layer.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|coding| {
            let mut parts = coding.split(';').map(str::trim);
            let name = parts.next().unwrap_or_default();
            let weight = parts
                .find_map(|p| p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")))
                .map_or(1.0, |q| q.parse::<f32>().unwrap_or(0.0));
            (name.eq_ignore_ascii_case("gzip") || name.eq_ignore_ascii_case("x-gzip")) && weight > 0.0
        })
}

/// The public frame gzipped, for streams opened with `?gzip` and for
/// `/api/nodes`. A hundred reporting nodes are about 110 KB of JSON every two
/// seconds, 15 KB compressed, for each page left open. Compressed once per
/// frame, about a millisecond at that size, however many streams take it.
fn live_gzip(app: &App) -> axum::body::Bytes {
    current(app, false, |frame| {
        frame
            .gzip
            .get_or_insert_with(|| {
                let mut packed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                // Into a Vec, which cannot fail.
                let _ = std::io::Write::write_all(&mut packed, frame.json.as_bytes());
                packed.finish().unwrap_or_default().into()
            })
            .clone()
    })
}

/// Drops the cached frames so the next push rebuilds. Without it a node just
/// added in the panel would disappear from the list until the frame expires.
fn invalidate_snapshot(app: &App) {
    for frame in db::lock(&app.snapshot).iter_mut() {
        frame.at = 0;
    }
}

/// What one tick of a browser stream may send: the admin frame while the session
/// that opened it remains live, the public frame while the status page remains
/// open to anonymous callers, and nothing once either ceases to hold.
///
/// Both are checked every tick rather than at the handshake alone, because a
/// socket outlives both answers. The admin frame carries every node's address
/// and private notes, so one outliving its session would keep disclosing them
/// after the session was revoked -- the gap `reset_token` closes on the agent
/// side by dropping its sender. The public frame is what an operator withdraws by
/// switching the status page off, and a socket opened a minute earlier would
/// continue sending it for as long as the tab stayed open: `live_ws` refuses new
/// anonymous connections from that moment and `nodes` answers them 401, leaving
/// this the only remaining route. Whatever the handshake tested must be tested
/// here as well.
fn stream_audience(app: &App, session: Option<&str>) -> Option<bool> {
    match session {
        Some(hash) => app.db.session_valid(hash).then_some(true),
        None => app.public_page().then_some(false),
    }
}

#[derive(Deserialize)]
pub struct Stream {
    /// Present for each public frame gzipped, in a binary message; the admin
    /// frame stays text. Without it frames are text, which is what a caller that
    /// does not ask for gzip receives.
    gzip: Option<String>,
}

/// How many anonymous streams may be open at once. The fourth bound of the
/// anonymous paths, beside `HISTORY_GATE`, `main::RELAY_GATE` and
/// `auth::PASSWORD_GATE`: a stream holds a descriptor and a task for as long as
/// its page stays open, and at a hundred nodes sends about 7 KB/s of compressed
/// frames, 55 KB/s to a page that does not ask for gzip. A thousand pages are
/// 7 to 55 MB/s outbound. Beyond it a page falls back to polling `/api/nodes`,
/// whose rendered frame every viewer shares.
const PUBLIC_STREAMS: usize = 1000;
static PUBLIC_STREAM_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(PUBLIC_STREAMS);

/// A send that blocks this long has no reader left: the pages treat 10 s
/// without a frame as a lost stream and open another. A peer that vanished
/// without a FIN would otherwise keep its slot until TCP gives up, about
/// 15 minutes.
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The slot a new stream holds until it ends. A session is the operator's own
/// and is not counted, so whoever holds one can always open the panel.
fn stream_slot(session: Option<&str>) -> Result<Option<tokio::sync::SemaphorePermit<'static>>, ()> {
    if session.is_some() {
        return Ok(None);
    }
    PUBLIC_STREAM_GATE.try_acquire().map(Some).map_err(|_| ())
}

/// Whom a stream handshake speaks for: `Some(Some(digest))` for a session,
/// `Some(None)` for a visitor, `None` for one the closed status page turns away.
///
/// The digest rather than the result: signing out must reach a stream already
/// running, and only the row it names can report whether it has.
/// A sibling subdomain's script opens this with the cookie too, and a WebSocket
/// is not held back by CORS: it would read the admin frame. Such a handshake is
/// answered as an anonymous one.
fn stream_viewer(app: &App, headers: &HeaderMap) -> Option<Option<String>> {
    let session = current_session(headers)
        .filter(|_| !from_other_origin(headers))
        .filter(|hash| app.db.session_valid(hash));
    (session.is_some() || app.public_page()).then_some(session)
}

/// Live stream for the browser. Each connection runs its own timer -- simpler to
/// reason about than a fan-out channel -- over a shared snapshot, so a timer
/// costs no more than a send.
pub async fn live_ws(
    State(app): State<Shared>,
    headers: HeaderMap,
    Query(stream): Query<Stream>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(session) = stream_viewer(&app, &headers) else {
        return answer(StatusCode::UNAUTHORIZED, "需要登录后查看");
    };
    let Ok(slot) = stream_slot(session.as_deref()) else {
        return answer(StatusCode::SERVICE_UNAVAILABLE, "同时在线的访客太多，请稍后再试");
    };
    upgrade.read_buffer_size(SOCKET_BUFFER).max_message_size(MAX_FRAME).on_upgrade(move |socket| async move {
        // Held until the stream ends.
        let _slot = slot;
        stream_live(app, socket, session, stream.gzip.is_some()).await
    })
}

async fn stream_live(app: Shared, mut socket: WebSocket, session: Option<String>, gzip: bool) {
    // The panel and the public page treat 10 s without a frame as a lost
    // stream and reconnect, so the interval must stay well below that. Not one
    // second to match the agent's default report: that would double what every
    // open page costs -- a hundred nodes are 15 KB a frame compressed, 110 KB for
    // the panel, which is never compressed -- while history, the mean and peak of
    // every report in its minute, would gain nothing.
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2));
    // A delayed tick, for instance behind a vacuum holding the database, is
    // followed by one frame rather than by every tick it missed: those would
    // all carry the same snapshot, 60 of them per tab after a two-minute wait.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            // The browser sends nothing but its close frame, and that is seen only
            // by reading. Unread, the close goes unanswered: the browser waits out
            // its 60 s closing handshake while this loop keeps pushing a full frame
            // every tick to a page that has already discarded the socket.
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => continue,
            },
        }
        // Closed rather than downgraded to the public frame, which would leave the
        // panel rendering a list with every admin field missing. The close allows
        // a client to re-query /api/me and determine its current state.
        let Some(full) = stream_audience(&app, session.as_deref()) else { break };
        // The admin frame stays uncompressed, asked or not: it carries every
        // node's address and private notes beside strings an agent reports, and the
        // length of each compressed frame, every two seconds on the wire,
        // would let one rogue agent guess the rest a character at a time.
        let frame = if gzip && !full {
            Message::Binary(live_gzip(&app))
        } else {
            Message::Text(live_snapshot(&app, full))
        };
        if !matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(frame)).await, Ok(Ok(()))) {
            break;
        }
    }
}

// ---- panel write paths ----

/// Names all three causes. The hub's own address is the one input to this
/// decision that nothing about the request reveals: a hub started with
/// `--site https://198.51.100.7` refuses every provisioning call from an
/// otherwise valid https domain entry, and a tunnelled panel is refused until
/// one is given. `main` warns about the first at startup; this is for whoever
/// reads the panel rather than the journal.
const PROVISIONING_DENIED: &str = "请通过 HTTPS 域名访问面板后添加或安装节点；\
     从隧道或回环地址进面板时，要告诉 hub 节点可达的域名：\
     在面板「设置」里填站点 URL，或用 --site https://你的域名 启动；\
     这个地址必须是 https 加域名，不能是 IP、不能带路径";

/// Every browser sends `Origin` with these writes, so its absence points at a
/// proxy clearing it. The panel judges from its own address bar and offers the
/// button, which leaves this as the only account of why the hub refuses.
const ORIGIN_MISSING: &str = "请求没有带 Origin 头。浏览器都会发送它，多半是反向代理清掉了\
     （例如 proxy_set_header Origin \"\"），去掉那一行后再试";

/// Whether this origin is the hub's own machine, which is what a tunnel into the
/// panel leaves in the address bar. Nothing between that browser and the hub is
/// in the clear -- it is the loopback interface, or the tunnel's own encryption
/// -- so the entry is sound; what it lacks is an address a node could use, which
/// is why it counts only alongside `--site`.
fn loopback_origin(origin: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(origin) else { return false };
    let Some(host) = url.host_str() else { return false };
    // host_str keeps the brackets an IPv6 literal is written with.
    let ip = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>();
    matches!(url.scheme(), "http" | "https")
        && (host == "localhost" || host.ends_with(".localhost") || ip.is_ok_and(|ip| ip.is_loopback()))
}

pub(crate) fn https_domain(site: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(site).ok()?;
    (url.scheme() == "https"
        && url.domain().is_some_and(|d| d != "localhost" && !d.ends_with(".localhost"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

/// Whether a host names the hub's own machine or its own network, which is the
/// only place a plaintext identity system may live.
///
/// A name is accepted only where it cannot resolve anywhere but here. Guessing
/// the other way would be the expensive mistake: an internal hostname that
/// happens to resolve publicly would then be allowed to put the code, the
/// verifier, the client secret and the bearer token on the wire in the clear.
fn local_host(host: &str) -> bool {
    // host_str keeps the brackets an IPv6 literal is written with.
    match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        // Unique local (fc00::/7) and link local (fe80::/10), by prefix rather
        // than by predicate: those predicates are newer than the MSRV.
        Ok(IpAddr::V6(v6)) => {
            v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

/// The OIDC issuer as a URL the hub can append a discovery path to, or `None`
/// when the value is not one.
///
/// A path is allowed and kept: Authentik publishes tenants under
/// `https://host/application/o/<slug>/`, and the discovery document sits beneath
/// whatever the issuer names. A query or fragment is refused because the append
/// would place the path after it, where neither the server nor the hub would
/// read it.
///
/// `https` is required unless the provider is on the hub's own machine or
/// network. The token exchange posts the code, the verifier and the client
/// secret, and userinfo sends the bearer token: over `http` to a public
/// address, every one of those is readable by anything on the path. The GitHub
/// proxy setting is held to the same rule for the same reason, and a loopback
/// port stays available for an operator testing against a provider they just
/// started.
pub(crate) fn issuer_url(issuer: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(issuer).ok()?;
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => local_host(url.host_str()?),
        _ => false,
    };
    (scheme_ok && url.query().is_none() && url.fragment().is_none()).then_some(url)
}

/// The issuer a pasted discovery URL actually names.
///
/// The field is a base URL -- [`issuer_url`] describes the shape -- and the hub
/// appends `/.well-known/openid-configuration` to it on every fetch. Every
/// identity system shows its operator that same concatenation, as a "discovery
/// URL" or "OIDC 发现 URL" to copy, so the address that reaches this field is
/// very often the finished URL rather than the base. Appending to it then asks
/// for `…/openid-configuration/.well-known/openid-configuration`, which answers
/// 404, and the panel reports a provider that "does not serve OIDC" about one
/// that is configured correctly everywhere else.
///
/// So the suffix is removed instead of refused: the value the operator pasted
/// is the value they meant, as with [`http_address`], and there is exactly one
/// issuer a discovery URL can name. A tenant path in front of it is kept --
/// Keycloak puts realms there -- because only the suffix is the hub's own.
fn issuer_address(issuer: &str) -> String {
    let trimmed = issuer.trim().trim_end_matches('/');
    for suffix in ["/.well-known/openid-configuration", "/openid-configuration"] {
        // Case-insensitively: the spelling is copied out of a document by hand,
        // and a provider that answers to one case is the same provider.
        if trimmed.len() > suffix.len() && trimmed.to_ascii_lowercase().ends_with(suffix) {
            return trimmed[..trimmed.len() - suffix.len()].trim_end_matches('/').to_owned();
        }
    }
    trimmed.to_owned()
}

/// The address a `site_url` value names, in the one spelling the rest of the hub
/// uses: `https://host[:port]`, without a trailing slash.
///
/// The panel asks for the bare host -- the `https://` is shown in the field and
/// pinned there, so that a plaintext address cannot be typed at all -- and the
/// scheme is added here rather than demanded. A pasted full URL is normalised
/// instead of refused: the value the reader pasted is the value they meant, and
/// rejecting it would be a refusal they cannot act on.
pub(crate) fn http_address(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    format!("https://{}", value.strip_prefix("https://").unwrap_or(value).trim_end_matches('/'))
}

/// Whether the browser sending this request is on an https domain entry, which
/// is the only address the panel may build install commands from.
///
/// The browser's own `Origin` answers it. Reconstructing the entry from `Host`
/// and `X-Forwarded-Proto` instead holds only where every proxy in front
/// forwards both, and the common ones do not: the aapanel and BT templates send
/// no `X-Forwarded-Proto`, a bare `proxy_pass` sends its own upstream address as
/// `Host` (as does Apache under `ProxyPreserveHost Off`), `$host` drops a port
/// that is not 443, and a TLS edge ahead of a plaintext hop leaves
/// `X-Forwarded-Proto: http`. Each of those refuses a panel that is in fact on
/// https, and none can be told apart here from a genuine plaintext entry.
/// `Origin` crosses all of them unchanged, and a page cannot forge its own.
///
/// The hub's own address -- `--site`, or the panel's `site_url` setting, which
/// is held to the same rule for the same reason: it takes this origin's place in
/// the command, so an IP or a path there is refused however the panel is
/// reached. It also answers for the one entry this origin cannot: a panel opened
/// over a tunnel reads `http://127.0.0.1:PORT`, which names no address a node
/// could reach, while the configured address names one and the tunnel carries the
/// session under its own encryption.
///
/// The error is the message the panel shows.
fn provisioning_allowed(app: &App, headers: &HeaderMap) -> Result<(), &'static str> {
    let site = app.base_url();
    if !site.is_empty() && https_domain(&site).is_none() {
        debug!("provisioning refused: the hub's address {site:?} is not an https domain entry");
        return Err(PROVISIONING_DENIED);
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        debug!("provisioning refused: the request carries no readable Origin");
        return Err(ORIGIN_MISSING);
    };
    if https_domain(origin).is_none() && !(loopback_origin(origin) && !site.is_empty()) {
        debug!("provisioning refused: Origin {origin:?} is not an https domain entry");
        return Err(PROVISIONING_DENIED);
    }
    Ok(())
}

/// Range and sign limits every stored node must satisfy, or the reason it does
/// not. Shared because both writers must enforce them: a value one refuses must
/// not be reachable through the other.
fn node_limits(reset_day: Option<u32>, price: Option<f64>, limit: Option<i64>) -> Option<&'static str> {
    if reset_day.is_some_and(|d| !(1..=31).contains(&d)) {
        return Some("流量重置日要在 1 到 31 之间");
    }
    if price.is_some_and(|v| !v.is_finite() || v < 0.0) || limit.is_some_and(|v| v < 0) {
        return Some("价格和流量上限不能是负数");
    }
    None
}

/// The public page shows the group as a tab label or a section title, so it is held to a
/// length that fits one line on a 390 px phone.
const MAX_GROUP: usize = 13;

/// Trims a group name, or refuses it. Refused rather than truncated: the panel
/// would otherwise report saved a name that is not the one stored.
fn group_error(group: &mut String) -> Option<&'static str> {
    *group = group.trim().to_owned();
    if group.chars().count() > MAX_GROUP || group.chars().any(char::is_control) {
        return Some("分组名最多 13 个字，不能含控制字符");
    }
    None
}

/// Node and probe names, as a panel row, a public card and a chart legend show
/// them. Refused rather than truncated, as a group name is.
const MAX_NAME: usize = 64;

/// Trims a node name, or refuses it.
fn name_error(name: &mut String) -> Option<&'static str> {
    *name = name.trim().to_owned();
    if name.is_empty() {
        return Some("请填写节点名称");
    }
    if name.chars().count() > MAX_NAME {
        return Some("节点名称最多 64 个字");
    }
    None
}

/// A public remark goes to every visitor in every frame, every two seconds, where
/// a node's public view is about 1 KB; a hundred CJK characters add 300 bytes.
const MAX_PUBLIC_REMARK: usize = 100;

/// Normalizes the currency and billing cycle, or names the one that cannot be
/// stored. The currency is held to the ISO 4217 form of three letters, the only
/// one `Intl.NumberFormat` accepts. Hubs before 1.3.1 stored it unchecked, so a
/// client still guards the call against a throw. Each cycle length is stored in a
/// single spelling, see `cycle_name`.
fn billing_error(currency: Option<&mut String>, cycle: Option<&mut String>) -> Option<&'static str> {
    if let Some(code) = currency {
        *code = code.trim().to_ascii_uppercase();
        if !(code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())) {
            return Some("货币要填三个字母的代码，如 USD、CNY、HKD");
        }
    }
    if let Some(cycle) = cycle.filter(|c| *c != "once") {
        let Some(months) = crate::cycle_months(cycle) else {
            return Some("付款周期要是整月，在 1 个月到 100 年之间");
        };
        *cycle = crate::cycle_name(months);
    }
    None
}

/// Normalizes a patch, or names the first value that cannot be stored. The one
/// check both the single and the batch write pass through, so the two accept
/// exactly the same values.
fn patch_error(node: &mut NodePatch) -> Option<&'static str> {
    if let Some(message) = node.name.as_mut().and_then(name_error) {
        return Some(message);
    }
    if let Some(group) = &mut node.group {
        if let Some(message) = group_error(group) {
            return Some(message);
        }
    }
    // Refused rather than truncated, as a group name is.
    if let Some(text) = &mut node.public_remark {
        *text = text.trim().to_owned();
        if text.chars().count() > MAX_PUBLIC_REMARK || text.chars().any(char::is_control) {
            return Some("公开备注最多 100 个字，不能含控制字符");
        }
    }
    node_limits(node.traffic_reset_day, node.price, node.traffic_limit)
        .or_else(|| billing_error(node.currency.as_mut(), node.billing_cycle.as_mut()))
        .or_else(|| pins(node))
}

/// Normalizes the values set by hand, or names the one that cannot stand. Each
/// takes the place of an automatic value, so it is held to what that value would
/// have to be: the country to the rule a looked-up one passes, as both reach the
/// status page; an address to its own family, stored canonical so the panel's
/// search matches however it was typed.
fn pins(node: &mut NodePatch) -> Option<&'static str> {
    if let Some(cc) = &mut node.country_pin {
        *cc = cc.trim().to_ascii_uppercase();
        if !cc.is_empty() && !(cc.len() == 2 && cc.bytes().all(|b| b.is_ascii_uppercase())) {
            return Some("国家要填两个字母的代码，留空则自动识别");
        }
    }
    for (pin, v6) in [(&mut node.ipv4_pin, false), (&mut node.ipv6_pin, true)] {
        let Some(pin) = pin else { continue };
        let typed = pin.trim();
        let parsed = if v6 {
            typed.parse::<Ipv6Addr>().map(IpAddr::V6)
        } else {
            typed.parse::<Ipv4Addr>().map(IpAddr::V4)
        };
        *pin = match parsed {
            Ok(ip) => ip.to_string(),
            Err(_) if typed.is_empty() => String::new(),
            Err(_) if v6 => return Some("IPv6 要填一个 IPv6 地址，或者留空"),
            Err(_) => return Some("IPv4 要填一个 IPv4 地址，或者留空"),
        };
    }
    None
}

pub async fn me(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let mut answered = Json(json!({
        "authed": authed(&app, &headers),
        // Unchanged by the address: GitHub takes the callback from its own app
        // registration and never sends a `redirect_uri`, so it works wherever
        // the hub is reachable.
        "github": app.db.get("github_client_id").is_some_and(|v| !v.is_empty()),
        // Every sign-in path stands on its own: an empty setting hides that
        // button and nothing else, so a broken IdP cannot lock the owner out.
        //
        // The address is part of "configured" here rather than a separate flag,
        // because OIDC cannot work without it: a plaintext address would put the
        // authorization code on the wire, so the button is not offered at all.
        // The security page says which of the two is missing, so an operator
        // who has filled every field is not left guessing.
        "oidc": app.oidc_address_ok()
            && app.db.get("oidc_issuer").is_some_and(|v| !v.is_empty())
            && app.db.get("oidc_client_id").is_some_and(|v| !v.is_empty()),
        // The button's label, defaulted here so the panel carries no fallback of
        // its own.
        "oidc_name": app
            .db
            .get("oidc_provider_name")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "OIDC".into()),
        "site_name": app.db.get("site_name").unwrap_or_else(|| "Monitor".into()),
        "public_page": app.public_page(),
        // How far back a chart may reach, so the page offers only windows the hub
        // answers in full; `metrics` narrows a wider one without saying so.
        "history_days": app.db.retention_days(),
        // The caller's own address, for the footer line that says who is reading
        // -- and nothing else: no lookup, no third party, no record. Behind a
        // proxy this is the forwarded address, by the same rule the throttles
        // use; canonicalised, so an IPv4-mapped IPv6 peer reads as the address
        // that visitor actually has.
        "ip": client_ip(&app, &headers, peer.ip()).to_string(),
        // Whether this browser may provision is not answered here: a GET carries
        // no `Origin`, so the panel applies `provisioning_allowed`'s rule itself.
        //
        // The hub's own public URL when it knows one, which is what belongs in an
        // install command and in the OAuth callback -- not whichever address this
        // browser used, which behind a proxy may be a loopback port. Empty when
        // it knows of none, in which case the browser's address is the only one
        // available and the panel falls back to its own origin.
        "site": app.base_url(),
        // Whether that address came from the command line rather than the panel.
        // The setting is then inert, and the field that writes it says so instead
        // of taking an edit that changes nothing.
        "site_fixed": !app.site.is_empty(),
    }))
    .into_response();
    // It carries `authed` and now an address: a shared cache holding either one
    // would hand them to the next visitor.
    answered
        .headers_mut()
        .insert(header::CACHE_CONTROL, header::HeaderValue::from_static("private, no-store"));
    answered
}

pub async fn create_node(
    _: Admin,
    State(app): State<Shared>,
    headers: HeaderMap,
    body: Result<Json<Node>, JsonRejection>,
) -> Response {
    if let Err(refusal) = provisioning_allowed(&app, &headers) {
        return answer(StatusCode::FORBIDDEN, refusal);
    }
    let Ok(Json(mut node)) = body else { return bad("节点数据格式不对") };
    if let Some(message) = name_error(&mut node.name)
        .or_else(|| node_limits(Some(node.traffic_reset_day), Some(node.price), Some(node.traffic_limit)))
        .or_else(|| group_error(&mut node.group))
        .or_else(|| billing_error(Some(&mut node.currency), Some(&mut node.billing_cycle)))
    {
        return bad(message);
    }
    let token = random_token();
    match app.db.create_node(&node, &token) {
        // Usable immediately: the install dialog reads the token as it opens, so
        // adding and deploying require no reissue in between.
        Ok(id) => {
            invalidate_snapshot(&app);
            Json(json!({"id": id})).into_response()
        }
        Err(e) => fail(e),
    }
}

// ---- automatic registration ----

/// How long a registration window stays open.
///
/// Provisioning a batch of machines takes minutes, and the window expires on its
/// own rather than depending on someone returning to close it.
const REGISTER_WINDOW: i64 = 3600;

/// How many nodes one window may register.
///
/// Without it, whoever holds the key for the hour could fill the node table. A
/// hundred is well beyond a plausible batch and well short of a problem.
const REGISTER_LIMIT: i64 = 100;

/// The header in which `install.sh` sends the token the machine already holds.
const HELD_TOKEN: &str = "x-node-token";

/// Exchanges a registration key for a node token, so a batch of machines can be
/// installed with one command rather than one panel visit each.
///
/// No session stands behind this route: the caller is `install.sh` on a machine
/// that has never contacted the hub. A key issued by the panel, valid only within
/// [`REGISTER_WINDOW`], serves in place of a session.
///
/// `provisioning_allowed` does not guard it, because a shell script sends no
/// `Origin` and the proxy headers that remain cannot state what address the
/// caller used. Which addresses may be registered against is enforced in
/// `install.sh`, where that address is known: it refuses plaintext to anything
/// but loopback unless `--insecure` is given, the same switch under which the
/// binary it is about to run as root was already fetched in the clear. The
/// window this key belongs to is still opened from an https domain entry alone.
///
/// One request costs at most a lookup on the token's unique index, two setting
/// reads, a `COUNT`, and one transaction inserting the `node` and `traffic` rows
/// plus a `ping_node` row per `auto_join` probe, at most 64. It makes no outbound
/// request, and the router's 64 KiB body limit bounds the name. Requests in flight
/// are not gated: each step is a point read or one small transaction under the
/// database lock, as with the token lookup of the agent handshake, and an address
/// locked out below reaches none of them. 120 concurrent callers with the window
/// closed move the panel's median from 1.1 ms to 2.1-2.8 ms, with or without a
/// held token, on three cores.
pub async fn agent_register(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    // Plain text in, plain text out. The caller is a shell script, as with this
    // route's neighbours: `/install.sh` and `/agent/{arch}` return a script and a
    // binary. A bare token is one `$(curl ...)` away, requiring no JSON parser in
    // a POSIX `sh`.
    name: String,
) -> Response {
    let ip = client_ip(&app, &headers, peer.ip());
    // Counted separately from the sign-in page: a batch install started with a
    // stale key is a misconfigured deploy rather than an attack on the panel, and
    // a shared counter would lock the operator out of their own hub for LOCKOUT.
    if app.registrations.locked(ip) {
        return answer(StatusCode::TOO_MANY_REQUESTS, "too many attempts, try again later");
    }
    // A rerun on a registered machine sends the token it already holds and
    // receives it back while that token still opens a node, so the rerun adds no
    // second node. Ahead of the window and the key: it creates nothing, returns
    // only what the caller already holds -- which the 401 of the agent handshake
    // reveals as well -- and must still succeed once the window has closed. A
    // token whose node was deleted, or which was reissued, falls through.
    if let Some(held) = headers.get(HELD_TOKEN).and_then(|v| v.to_str().ok()).filter(|t| !t.is_empty()) {
        match app.db.node_by_token(held) {
            Ok(Some(_)) => return held.to_owned().into_response(),
            Ok(None) => {}
            // Read as "no node", a failed lookup would register a second node for
            // a machine whose node is intact.
            Err(e) => return script_fail(e),
        }
    }
    // One answer for both "no window is open" and "that key is wrong": the
    // difference is only useful to someone who has neither.
    let closed = || {
        answer(StatusCode::FORBIDDEN, "registration is closed; open a new window from the panel's node list")
    };
    let until = register_until(&app);
    let Some(key) = app.db.get("register_key").filter(|k| !k.is_empty() && Utc::now().timestamp() < until)
    else {
        return closed();
    };
    if agent_ws::bearer(&headers) != Some(key.as_str()) {
        // Only an incorrect key counts against the address. With the window
        // closed there is no secret to guess, and counting then would let anyone
        // lock an address they name in `X-Forwarded-For` out of the sign-in page.
        app.registrations.record_failure(ip);
        return closed();
    }
    match app.db.nodes_created_since(until - REGISTER_WINDOW) {
        Ok(n) if n >= REGISTER_LIMIT => {
            return answer(
                StatusCode::FORBIDDEN,
                "this window has registered enough nodes; open a new window from the panel's node list",
            )
        }
        Err(e) => return script_fail(e),
        Ok(_) => {}
    }

    // The name comes from a machine not yet vouched for, and is shown to every
    // visitor until the operator renames the node. Trimmed last: a name made of
    // markup characters and spaces must come out empty, not as a blank, and
    // `create_node` names an empty one after the node's id.
    let name = db::reported_text(&name, MAX_NAME).trim().to_owned();
    // Field defaults live in `Node`'s serde attributes and nowhere else.
    // `Node::default()` is a different set of values -- private, reset day 0 --
    // and a node registered here must match one added through the panel.
    let node = match serde_json::from_value::<Node>(json!({ "name": name })) {
        Ok(node) => node,
        Err(e) => return script_fail(e),
    };
    let token = random_token();
    match app.db.create_node(&node, &token) {
        Ok(_) => {
            app.registrations.clear(ip);
            invalidate_snapshot(&app);
            token.into_response()
        }
        Err(e) => script_fail(e),
    }
}

/// [`fail`] for `install.sh`, whose own output is English and which prints the
/// reply in one line after its own.
fn script_fail(e: impl Into<anyhow::Error>) -> Response {
    warn!("registration failed: {:#}", e.into());
    answer(StatusCode::INTERNAL_SERVER_ERROR, "the hub hit an internal error; its log has the details")
}

/// Opens a registration window with a fresh key. Any previous key stops working
/// the moment this returns.
pub async fn open_register(_: Admin, State(app): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(refusal) = provisioning_allowed(&app, &headers) {
        return answer(StatusCode::FORBIDDEN, refusal);
    }
    let key = random_token();
    let until = (Utc::now().timestamp() + REGISTER_WINDOW).to_string();
    match app.db.set("register_key", &key).and_then(|()| app.db.set("register_until", &until)) {
        Ok(()) => Json(json!({"register_key": key, "register_left": REGISTER_WINDOW})).into_response(),
        Err(e) => fail(e),
    }
}

/// Seconds the registration window has left, 0 when none is open. What the
/// panel counts down from, rather than the stored deadline: compared with the
/// browser's clock, a deadline is off by as much as that clock is. A browser
/// eight hours fast -- Windows and Linux sharing a machine in UTC+8 -- would hide
/// the command of an open window, and one eight hours slow would show it for
/// eight hours after the key stopped working.
fn register_left(app: &App) -> i64 {
    (register_until(app) - Utc::now().timestamp()).clamp(0, REGISTER_WINDOW)
}

/// The stored deadline, 0 when none was ever set. One reading for the gate in
/// `agent_register` and the panel's countdown, so the two cannot disagree.
fn register_until(app: &App) -> i64 {
    app.db.get("register_until").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0)
}

/// Closes the window early, before the hour elapses.
pub async fn close_register(_: Admin, State(app): State<Shared>) -> Response {
    match app.db.set("register_key", "").and_then(|()| app.db.set("register_until", "0")) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

pub async fn update_node(
    _: Admin,
    State(app): State<Shared>,
    Path(id): Path<i64>,
    body: Result<Json<NodePatch>, JsonRejection>,
) -> Response {
    let Ok(Json(mut node)) = body else { return bad("节点数据格式不对") };
    if let Some(message) = patch_error(&mut node) {
        return bad(message);
    }
    match app.db.update_node(id, &node) {
        Ok(true) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        Ok(false) => no_such_node(),
        Err(e) => fail(e),
    }
}

/// What a batch may set: the settings the panel applies across a selection.
/// An allowlist, so a field added to [`NodePatch`] later, possibly one that
/// describes a single machine, is refused here until it is listed.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct BatchPatch {
    group: Option<String>,
    notify: Option<bool>,
}

#[derive(Deserialize)]
pub struct NodeBatch {
    ids: Vec<i64>,
    #[serde(default)]
    patch: BatchPatch,
}

/// Applies one patch to every selected node, all or none.
pub async fn update_nodes(
    _: Admin,
    State(app): State<Shared>,
    body: Result<Json<NodeBatch>, JsonRejection>,
) -> Response {
    let Ok(Json(NodeBatch { mut ids, patch })) = body else {
        return bad("批量修改只支持分组和通知");
    };
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return bad("没有选中节点");
    }
    let mut patch = NodePatch { group: patch.group, notify: patch.notify, ..Default::default() };
    if let Some(message) = patch_error(&mut patch) {
        return bad(message);
    }
    match app.db.update_nodes(&ids, &patch) {
        Ok(true) => {
            invalidate_snapshot(&app);
            Json(json!({"updated": ids.len()})).into_response()
        }
        Ok(false) => answer(StatusCode::NOT_FOUND, "有节点已被删除，没有做任何修改；刷新后重新选择"),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
pub struct Order {
    ids: Vec<i64>,
}

/// The list must name every node exactly once, checked inside the transaction
/// that renumbers rather than here: re-reading the node list first would only
/// race the write it guards.
pub async fn reorder_nodes(_: Admin, State(app): State<Shared>, Json(order): Json<Order>) -> Response {
    match app.db.reorder_nodes(&order.ids) {
        Ok(()) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => fail(e),
    }
}

pub async fn delete_node(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    match app.db.delete_node(id) {
        Ok(true) => {}
        Ok(false) => return no_such_node(),
        Err(e) => return fail(e),
    }
    // The token is checked only at the handshake, so deleting the row does not
    // end a connection already open on it; dropping the sender does. Dropped
    // after the delete, so the reconnect that follows finds no token to accept.
    // The same reasoning applies in `reset_token` below.
    app.agents.write().unwrap_or_else(|e| e.into_inner()).remove(&id);
    // Its held reading as well, which no node would book.
    app.readings.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    invalidate_snapshot(&app);
    Json(json!({"ok": true})).into_response()
}

/// Issues a fresh token, invalidating the old one immediately.
///
/// Always an explicit action: rotate a token believed to have leaked, then
/// reinstall the agent. Reading the install command does not pass through here.
pub async fn reset_token(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    let token = random_token();
    match app.db.reset_token(id, &token) {
        Ok(true) => {}
        Ok(false) => return no_such_node(),
        Err(e) => return fail(e),
    }
    // The token is checked only at the handshake, so a session opened with the
    // old one would continue reporting. Dropping the sender ends that loop; the
    // agent reconnects and is refused. Its own teardown leaves the entry
    // untouched, because the session tag no longer matches.
    app.agents.write().unwrap_or_else(|e| e.into_inner()).remove(&id);
    // The node shows offline at once rather than when the frame expires.
    invalidate_snapshot(&app);
    // The token alone: the panel builds the command, and one place needs to know
    // its form.
    Json(json!({"token": token})).into_response()
}

/// A node's token, for the install command the panel shows. Not part of the
/// node list, where it would share an answer with strings agents report: a
/// proxy compressing that answer would let one rogue agent guess it a character
/// at a time from the compressed length.
pub async fn node_token(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    match app.db.node(id) {
        Ok(Some(node)) => {
            ([(header::CACHE_CONTROL, "no-store")], Json(json!({"token": node.token}))).into_response()
        }
        Ok(None) => no_such_node(),
        Err(e) => fail(e),
    }
}

pub async fn patch_traffic(
    _: Admin,
    State(app): State<Shared>,
    Path(id): Path<i64>,
    Json(p): Json<TrafficPatch>,
) -> Response {
    if [p.total_rx, p.total_tx, p.month_rx, p.month_tx].into_iter().flatten().any(|v| v < 0) {
        return bad("流量不能是负数");
    }
    match app.db.set_traffic(id, &p) {
        Ok(true) => {
            invalidate_snapshot(&app);
            Json(json!({"ok": true})).into_response()
        }
        Ok(false) => no_such_node(),
        Err(e) => fail(e),
    }
}

pub async fn ping_tasks(_: Admin, State(app): State<Shared>) -> Response {
    match app.db.ping_tasks() {
        Ok(tasks) => Json(json!({"tasks": tasks})).into_response(),
        Err(e) => fail(e),
    }
}

/// As `reorder_nodes`. Nothing is pushed to the agents: the list they run is in
/// id order, see `ping_tasks_for`.
pub async fn reorder_ping_tasks(_: Admin, State(app): State<Shared>, Json(order): Json<Order>) -> Response {
    match app.db.reorder_ping_tasks(&order.ids) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => fail(e),
    }
}

/// A probe target the agent can resolve: `host:port`, with an IPv6 literal
/// bracketed as a URL writes one.
///
/// A bare `contains(':')` admitted three forms that never connect: a bare IPv6
/// address, which is all colons; `:443` with no host; and `host:` with no port.
/// The agent's `lookup_host` errors on each, `tcp_ping` returns -1, and the chart
/// draws a probe at 100% loss indefinitely with nothing in any log identifying
/// the target as the cause.
fn valid_target(target: &str) -> bool {
    let (host, port) = match target.strip_prefix('[') {
        Some(rest) => match rest.split_once("]:") {
            Some(pair) => pair,
            None => return false,
        },
        // Unbracketed, so the last colon is the port separator; anything still
        // containing a colon is an IPv6 address that required brackets.
        None => match target.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, port),
            _ => return false,
        },
    };
    !host.is_empty() && port.parse::<u16>().is_ok_and(|p| p > 0)
}

pub async fn save_ping_task(_: Admin, State(app): State<Shared>, Json(mut task): Json<PingTask>) -> Response {
    // Trimmed into the stored value rather than a discarded copy: what reaches
    // the agent is `task.target`, and a trailing space from a paste passes
    // `valid_target` while `lookup_host` rejects the stored string outright,
    // leaving the probe reporting -1 indefinitely. The name is trimmed for the
    // same reason, as it travels to the public page as a chart label.
    task.name = task.name.trim().to_owned();
    task.target = task.target.trim().to_owned();
    if task.name.is_empty() || task.target.is_empty() {
        return bad("请填写名称和目标");
    }
    if task.name.chars().count() > MAX_NAME {
        return bad("名称最多 64 个字");
    }
    // A TCP probe requires an explicit port; a bare host would silently never
    // connect.
    if !valid_target(&task.target) {
        return bad("目标要写成「主机:端口」，例如 1.1.1.1:443 或 [2606:4700:4700::1111]:443");
    }
    // Refused rather than clamped, for the reason `setting_error` gives for
    // `retention_days`: the agent clamps this again on arrival, so an
    // out-of-range value never fails but silently becomes a different number
    // while the panel still displays what was entered. Below the floor that
    // number is 5 seconds, the fastest probe available, run by every node the
    // task is assigned to; the panel reaches 0 simply by having its interval
    // field cleared.
    if !(Db::MIN_PROBE_INTERVAL..=3_600).contains(&task.interval) {
        return bad(&format!("间隔要在 {} 到 3600 秒之间", Db::MIN_PROBE_INTERVAL));
    }
    match app.db.save_ping_task(&task) {
        Ok(id) => {
            agent_ws::push_ping_tasks(&app, None);
            Json(json!({"id": id})).into_response()
        }
        Err(e) => fail(e),
    }
}

/// The probes ticked for one node, and `base`, those it had when the editor
/// opened; see `Db::set_node_ping_tasks`.
#[derive(Deserialize)]
pub struct NodeProbes {
    tasks: Vec<i64>,
    base: Vec<i64>,
}

pub async fn set_node_ping_tasks(
    _: Admin,
    State(app): State<Shared>,
    Path(id): Path<i64>,
    body: Result<Json<NodeProbes>, JsonRejection>,
) -> Response {
    let Ok(Json(probes)) = body else { return bad("监控列表格式不对") };
    match app.db.set_node_ping_tasks(id, &probes.tasks, &probes.base) {
        Ok(true) => {
            agent_ws::push_ping_tasks(&app, Some(id));
            Json(json!({"ok": true})).into_response()
        }
        Ok(false) => no_such_node(),
        Err(e) => fail(e),
    }
}

pub async fn delete_ping_task(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    match app.db.delete_ping_task(id) {
        Ok(()) => {
            agent_ws::push_ping_tasks(&app, None);
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => fail(e),
    }
}

/// Settings the panel may read. Secrets are deliberately excluded: the client can
/// set the GitHub or OIDC secret but never read it back.
const READABLE_SETTINGS: &[&str] = &[
    "site_name",
    // The hub's own address, for the deployment that has a domain and no wish to
    // reinstall for it. Held to `https_domain`'s rule, so it can only ever name
    // an https domain entry.
    "site_url",
    "public_page",
    "github_client_id",
    "github_allowed_users",
    "oidc_issuer",
    "oidc_client_id",
    "oidc_allowed_users",
    "oidc_provider_name",
    "retention_days",
    "github_proxy",
    "update_notice",
    "favicon",
    "touch_icon",
    "origin_cdn_only",
];

// ---- the database itself ----

/// The largest single request the two upload routes accept, and the reason they
/// sit outside the router's 64 KiB body limit. It is twice the 4 MiB the panel
/// sends, so the chunk size remains the panel's concern alone and requires no
/// negotiated handshake.
///
/// **This, not the two ceilings below, is what a reverse proxy must pass.** A
/// backup of any size arrives 4 MiB at a time, so `client_max_body_size` no
/// longer tracks the size of the database.
pub const MAX_CHUNK: usize = 8 * 1024 * 1024;

/// Whole-file ceilings, one per route, checked against the declared `total` on
/// the first request rather than by counting bytes as they arrive, so an
/// oversized upload is refused before a byte is sent.
///
/// The backup ceiling bounds how long a restore holds the connection every read
/// and write passes through, while the panel and the public page wait and the
/// agents' reports queue: a 1.5 GiB copy measured 20.5 s from the page cache, so
/// 1 GiB is 14 s, or 27 s at the ~40 MB/s measured from disk -- within the 90 s
/// an agent waits before reconnecting. It clears what history can reach: at 300
/// nodes with four probes, a week of minute rows and a year of hourly ones come
/// to about 720 MiB.
pub const MAX_RESTORE: u64 = 1024 * 1024 * 1024;

/// One request of an upload: `total` is the whole file, `offset` where this piece
/// belongs within it.
///
/// There is no upload id, session or server-side bookkeeping: the state of an
/// upload is the length of the file on disk. A piece continues an upload only if
/// it begins exactly where the last ended, `offset = 0` truncates whatever an
/// interrupted attempt left behind, and nothing is ever left to collect.
#[derive(Deserialize)]
pub struct Chunk {
    offset: u64,
    total: u64,
}

/// The password a destructive request re-enters, as the panel sends it: the hex
/// of its UTF-8 bytes, which carries a password holding any character at all
/// through a header value unchanged.
///
/// A header rather than a query parameter. The hub logs no URLs, but whatever
/// proxy stands in front of it logs the request line, and an access log is not
/// where a password belongs. Anything undecodable reads as an empty password:
/// what is wrong with it is [`crate::auth::confirm_password`]'s to say.
fn reentered_password(headers: &HeaderMap) -> String {
    headers
        .get("x-confirm-password")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| hex::decode(value).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

/// Appends one piece to `path`, returning the file's length afterwards; the
/// caller compares that against `total` to determine completion.
///
/// A piece lands whole or not at all -- a failure truncates back to where it
/// began -- so retrying one always aligns on the same offset.
///
/// ponytail: strictly sequential, one round trip per chunk. Concurrent pieces
/// would require pwrite, a commit step and a hash to prove there are no gaps,
/// and would save about a second on a 6.7 MB backup.
async fn receive(path: &str, chunk: &Chunk, max: u64, body: axum::body::Body) -> Result<u64, anyhow::Error> {
    if chunk.total == 0 || chunk.total > max {
        refuse!("文件必须在 1 字节到 {} MiB 之间", max / 1024 / 1024);
    }
    if chunk.offset > chunk.total {
        refuse!("分片位置越过了文件末尾");
    }

    let mut options = std::fs::OpenOptions::new();
    // Only the first piece may create the file, and it truncates: whatever an
    // interrupted upload left behind is overwritten rather than accumulated.
    if chunk.offset == 0 {
        options.write(true).create(true).truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            refuse!("这次上传已经不在了，请从头开始")
        }
        Err(e) => return Err(e.into()),
    };

    let already = file.metadata()?.len();
    if already != chunk.offset {
        refuse!("分片接不上：已经收到 {already} 字节，这一片却从 {} 开始", chunk.offset);
    }

    match append(&mut file, chunk, body).await {
        Ok(received) => Ok(chunk.offset + received),
        Err(e) => {
            // Undo a partially written piece so a retry aligns again.
            let _ = file.set_len(chunk.offset);
            Err(e)
        }
    }
}

/// Streams one request body onto the end of `file`. The byte count is checked
/// here as well as by the route's body limit: these are the only paths on the hub
/// that write a caller's bytes to disk, so they do not depend on a layer that
/// could be reordered away.
async fn append(
    file: &mut std::fs::File,
    chunk: &Chunk,
    body: axum::body::Body,
) -> Result<u64, anyhow::Error> {
    use anyhow::Context;
    use std::io::Write;
    use std::pin::Pin;

    let mut stream = body.into_data_stream();
    let mut received = 0u64;
    while let Some(piece) =
        std::future::poll_fn(|cx| futures_core::Stream::poll_next(Pin::new(&mut stream), cx)).await
    {
        // The client went away mid-piece, as a cancelled upload does.
        let piece = piece.context(crate::Shown("上传中断了，请重新上传".into()))?;
        received += piece.len() as u64;
        if chunk.offset + received > chunk.total {
            refuse!("这一片超出了声明的文件大小");
        }
        file.write_all(&piece)?;
    }
    Ok(received)
}

/// A scratch file beside the database, so the copy lands on the same filesystem
/// the database has room on. The random component keeps two concurrent calls
/// apart, since `VACUUM INTO` refuses a file that is not empty.
fn scratch_path(app: &App, kind: &str) -> String {
    format!("{}.{kind}-{}.tmp", app.db.file(), &random_token()[..16])
}

/// The data page's figures.
///
/// Off the runtime, like the three routes below: `stats` counts every row of
/// both tiers of history -- all WITHOUT ROWID, so each count is a full index
/// scan -- 127 ms at 2.2M rows with the file cached, growing with
/// `retention_days`, and uncached, as long as reading the file takes.
pub async fn db_stats(_: Admin, State(app): State<Shared>) -> Response {
    match tokio::task::spawn_blocking(move || app.db.stats()).await {
        Ok(Ok(stats)) => Json(stats).into_response(),
        Ok(Err(e)) => fail(e),
        Err(e) => fail(anyhow::anyhow!(e)),
    }
}

/// Returns a compact copy of the whole database.
///
/// The copy is written beside the live file and then unlinked while still open,
/// so it exists only for the duration of this response: a client that
/// disconnects partway through leaves nothing behind, and nothing on disk
/// outlives the download.
pub async fn db_backup(_: Admin, State(app): State<Shared>) -> Response {
    let path = scratch_path(&app, "backup");
    // Off the runtime: this reads the entire database, through a connection of
    // its own, so the agents' writes continue meanwhile.
    let copied = {
        let (app, path) = (app.clone(), path.clone());
        tokio::task::spawn_blocking(move || app.db.backup_into(&path)).await
    };
    if let Err(e) = copied.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
        let _ = std::fs::remove_file(&path);
        return fail(e);
    }
    let opened = tokio::fs::File::open(&path).await;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&path);
    match opened {
        Ok(file) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
                (header::CONTENT_LENGTH, size.to_string()),
                // The entire credential store: no shared cache may retain a copy.
                (header::CACHE_CONTROL, "no-store".to_owned()),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"monitor-{}.db\"", Local::now().format("%Y%m%d-%H%M%S")),
                ),
            ],
            axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file)),
        )
            .into_response(),
        Err(e) => fail(e),
    }
}

/// Replaces the live database with an uploaded backup, one chunk per request.
///
/// The upload streams to a file beside the database and is validated in full
/// before a single page is copied; see `Db::check_backup`. Afterwards every
/// session in the restored file is dropped and the caller is issued a new one: a
/// backup carries the session rows it held when taken, and restoring it must not
/// revive logged-out sessions.
pub async fn db_restore(
    _: Admin,
    State(app): State<Shared>,
    Query(chunk): Query<Chunk>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    // Asked for once, on the piece that creates the file. `receive` refuses a
    // piece that does not begin exactly where the last one ended and truncates
    // on offset zero, so the first byte of an upload can only ever be written by
    // a request that passed here: there is no later piece to slip in through.
    if chunk.offset == 0 {
        let ip = client_ip(&app, &headers, peer.ip());
        if let Some(refusal) = confirm_password(&app, ip, &reentered_password(&headers)) {
            return refusal;
        }
    }
    // One fixed path, which is what allows the file's own length to constitute
    // the entire protocol.
    // ponytail: one upload in flight per hub. Two started simultaneously land on
    // this same name, and equal-sized chunks align their offsets, so they splice
    // rather than collide. The cost is a failed upload; distinguishing them would
    // require the upload id the protocol deliberately omits.
    let path = format!("{}.upload", app.db.file());
    let received = match receive(&path, &chunk, MAX_RESTORE, body).await {
        Ok(received) => received,
        Err(e) => return fail(e),
    };
    if received < chunk.total {
        return Json(json!({"received": received})).into_response();
    }

    // Moved off the upload name before a byte is read. Splicing costs an upload;
    // what it must not cost is the live database, which without this it could:
    // the other upload would continue appending through its own handle while
    // `check_backup` reads the file and the page copy follows, and SQLite cannot
    // observe a write it did not make. A file that passed every gate would then
    // be copied over in a different state. Afterwards the other upload's next
    // chunk finds nothing and is told to restart, which is the error it already
    // has for an upload that disappeared.
    //
    // ponytail: the rename itself is not covered by a test. What it changes is
    // which path is open during the read, and reaching that would require a
    // second upload landing inside the copy. What is verified afterwards is that
    // neither name is left behind, in
    // `a_finished_restore_leaves_no_scratch_file_behind`.
    let source = scratch_path(&app, "restoring");
    if let Err(e) = std::fs::rename(&path, &source) {
        let _ = std::fs::remove_file(&path);
        return fail(e);
    }

    let outcome = restore(&app, &source).await;
    // SQLite writes a -wal and a -shm beside any file it opens in WAL mode, and a
    // plain copy of a running hub's database is exactly that. They are removed
    // when the connection closes cleanly; these three lines cover the case where
    // it does not.
    for leftover in [source.clone(), format!("{source}-wal"), format!("{source}-shm")] {
        let _ = std::fs::remove_file(leftover);
    }
    match outcome {
        Ok(()) => {
            // Agents authenticate at the handshake, and the tokens they hold may
            // now belong to different nodes, or to none. Dropping the senders ends
            // those loops; each reconnects against the restored database.
            app.agents.write().unwrap_or_else(|e| e.into_inner()).clear();
            // Held readings belong to the database just replaced.
            app.readings.lock().unwrap_or_else(|e| e.into_inner()).clear();
            invalidate_snapshot(&app);
            let cookie = match app.db.drop_all_sessions().and_then(|()| issue_session(&app, &headers)) {
                Ok(cookie) => cookie,
                Err(e) => return fail(e),
            };
            // A backup can carry a `site_url` into a hub that is being read over
            // plain http, which is the one write `save_settings` refuses to make:
            // every cookie from then on is `Secure`, and the browser reading this
            // page drops it. The restore stands -- the file is the operator's own
            // -- so what is left is to name the cause, since the symptom ("the
            // password is right and I am still not signed in") points nowhere
            // near it. Answered as a field rather than a refusal because the
            // database has already been replaced by the time this runs.
            let warning = (!app.base_url().is_empty() && !crate::request_is_https(&headers)).then_some(
                "恢复成功了，但备份里的站点 URL 是 https 而这次恢复走的是 http：会话 cookie 因此带上了 Secure，用 http 打开面板会登不进去。改用 https 域名打开面板，或把站点 URL 清空",
            );
            with_cookies(Json(json!({"ok": true, "warning": warning})), [cookie])
        }
        Err(e) => fail(e),
    }
}

async fn restore(app: &Shared, path: &str) -> Result<(), anyhow::Error> {
    // Both halves read the whole file, off the runtime: `PRAGMA integrity_check`
    // on a 1 GiB upload is not runtime work, and the copy that follows holds
    // the connection the agents write through.
    let (app, source) = (app.clone(), path.to_owned());
    tokio::task::spawn_blocking(move || {
        app.db.check_backup(&source)?;
        app.db.restore_from(&source)?;
        // A statement about where this hub is reachable from, which the file
        // cannot carry to a different machine; the operator confirms it again.
        app.db.set("origin_cdn_only", "off")
    })
    .await?
}

/// Drops history beyond the retention window and rebuilds the file around what
/// remains, which is the only way SQLite returns the space to the filesystem.
pub async fn db_vacuum(_: Admin, State(app): State<Shared>) -> Response {
    let keep = app.db.retention_days();
    let app = app.clone();
    // A rebuild of the whole file, holding the connection the agents write
    // through, so it belongs on a blocking thread.
    let done = tokio::task::spawn_blocking(move || {
        let pruned = app.db.prune(keep)?;
        app.db.vacuum().map(|freed| json!({"pruned": pruned, "freed": freed}))
    })
    .await;
    match done.map_err(|e| anyhow::anyhow!(e)).and_then(|r| r) {
        Ok(result) => Json(result).into_response(),
        Err(e) => fail(e),
    }
}

/// How long a release lookup stands before the panel asks GitHub again, and how
/// long a failed one does. The short retry keeps one unreachable moment from
/// hiding an update for the rest of the day; the long one keeps a panel left
/// open on a screen to four lookups a day, well inside the 60 per hour an
/// unauthenticated caller is allowed.
const RELEASES_FRESH: i64 = 6 * 3600;
const RELEASES_RETRY: i64 = 600;

/// The most a `versions.json` may weigh. It is two short version strings; this
/// cap only keeps a redirected proxy page from being parsed as one.
const MAX_VERSIONS_JSON: usize = 4096;

/// What is running here, and what is published. The agent's own version travels
/// in its hello and is already in the node list, so the panel compares the two
/// itself and names the nodes to upgrade.
///
/// Admin-only, and deliberately not part of `/api/me`: that route answers
/// anonymous callers, to whom the running hub version is not disclosed. Nothing
/// is fetched until an administrator opens the panel, so a hub whose panel is
/// never opened makes no outbound request.
pub async fn versions(_: Admin, State(app): State<Shared>) -> Json<Value> {
    // Poisoning is ignored on purpose. The lock holds a version number kept for
    // display, so a write interrupted by a panic leaves nothing a reader has to
    // trust; refusing to read it would take the panel down with it.
    let cached = app.releases.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let latest = if fresh_enough(&cached, Utc::now().timestamp()) {
        cached
    } else {
        let read = latest_versions(&app).await;
        *app.releases.lock().unwrap_or_else(|e| e.into_inner()) = read.clone();
        read
    };
    Json(json!({
        "hub": env!("CARGO_PKG_VERSION"),
        // Empty where GitHub could not be reached, which the panel renders as no
        // update rather than as an error: a hub on a network that cannot reach
        // github.com is a supported deployment, not a fault to report.
        "hub_latest": latest.hub,
        "agent_latest": latest.agent,
        // Whether the navigation marks an update. It governs the mark alone: the
        // lookup runs either way, so the update page still answers when opened.
        "notice": app.db.get("update_notice").as_deref() != Some("off"),
    }))
}

/// The versions a release publishes for each component, read from its
/// `versions.json` -- the only artifact that says which hub and which agent a
/// tag carries, since the tag itself is just a sequence number. Falls back to
/// the tag for both on any miss: a release cut before the file existed, or a
/// hub that cannot reach GitHub at all, answers exactly as it did before.
async fn latest_versions(app: &App) -> crate::Releases {
    let url = crate::proxied(
        app,
        format!("https://github.com/{}/releases/latest/download/versions.json", crate::REPO),
    );
    let parsed = crate::fetch_asset(app, &url, "versions file", MAX_VERSIONS_JSON)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<ReleaseVersions>(&body).ok());
    match parsed {
        // Any empty field means the file is not saying; the tag is the better
        // answer than a half-filled panel.
        Some(v) if !v.hub.is_empty() && !v.agent.is_empty() => {
            crate::Releases { read_at: Utc::now().timestamp(), hub: v.hub, agent: v.agent }
        }
        _ => {
            let tag = latest_tag(app, crate::REPO).await;
            crate::Releases {
                read_at: Utc::now().timestamp(),
                hub: tag.clone().unwrap_or_default(),
                agent: tag.unwrap_or_default(),
            }
        }
    }
}

/// The two fields of `versions.json`, as CI writes it from the two manifests.
#[derive(Deserialize)]
struct ReleaseVersions {
    hub: String,
    agent: String,
}

/// Whether the cached lookup still answers. One that returned nothing is held
/// for [`RELEASES_RETRY`] instead, so a single unreachable moment does not hide
/// an update for the rest of the day.
fn fresh_enough(cached: &crate::Releases, now: i64) -> bool {
    let holds =
        if cached.hub.is_empty() || cached.agent.is_empty() { RELEASES_RETRY } else { RELEASES_FRESH };
    // A negative age is a clock set back since the lookup, not a fresh one.
    cached.read_at != 0 && (0..holds).contains(&(now - cached.read_at))
}

/// The tag of a repository's latest release, without its leading `v`, or None
/// where GitHub could not be read, which costs only the update notice.
async fn latest_tag(app: &App, repo: &str) -> Option<String> {
    let tag = latest_release(app, repo).await.ok()?.tag_name;
    Some(tag.strip_prefix('v').unwrap_or(&tag).to_owned())
}

/// The latest release of `owner/repo`. Unauthenticated: 60 requests per hour from
/// this address. GitHub returns 403 without a User-Agent. Never through the
/// panel's GitHub proxy, which most mirrors provide for release downloads alone.
async fn latest_release(app: &App, repo: &str) -> reqwest::Result<Release> {
    app.http
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header(header::USER_AGENT, "probe-hub")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

/// The one field of a release the hub still reads. The assets were listed for
/// the theme archive, which the panel no longer installs.
#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

/// Every live session, with the caller's own marked.
///
/// `id` is the stored SHA-256 of the session token rather than the token itself:
/// it identifies a row without being presentable as a cookie.
pub async fn sessions(_: Admin, State(app): State<Shared>, headers: HeaderMap) -> Response {
    let mine = current_session(&headers);
    match app.db.sessions() {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(hash, expires_at)| {
                    json!({
                        "current": mine.as_deref() == Some(hash.as_str()),
                        "created_at": issued_at(expires_at),
                        "id": hash,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => fail(e),
    }
}

/// Deleting a row that no longer exists is not an error: two panels open on the
/// same list both achieve the requested sign-out.
pub async fn delete_session(_: Admin, State(app): State<Shared>, Path(id): Path<String>) -> Response {
    match app.db.drop_session(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => fail(e),
    }
}

pub async fn settings(
    _: Admin,
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Json<Value> {
    let mut out = serde_json::Map::new();
    // The address this request is taken for under the saved `origin_cdn_only`,
    // so the admin can see whether the switch recognizes them: behind a CDN the
    // proxy's own address means it does not.
    out.insert("your_address".into(), json!(client_ip(&app, &headers, peer.ip()).to_string()));
    for key in READABLE_SETTINGS {
        out.insert((*key).to_owned(), json!(app.db.get(key).unwrap_or_default()));
    }
    // The one readable key with a default that also rejects the empty string:
    // `setting_error` below refuses "" and `save_settings` writes nothing when any
    // key fails, so answering "" for a hub where this was never set would have
    // the entire settings form rejected, naming a field that was never edited.
    // `retention_days()` already holds the default `prune` and the data page read,
    // so it answers here as well.
    out.insert("retention_days".into(), json!(app.db.retention_days().to_string()));
    // The other key with a meaning the stored row does not always carry: any
    // value but "on" closes the page, so a hub that never wrote this one is
    // closed (`public_page`). Echoing the raw row would answer "", which every
    // reader here has to remember to interpret -- and the panel, which treats
    // "not off" as on, would show an open switch over a closed page, then write
    // that "on" back when some unrelated field was saved.
    out.insert("public_page".into(), json!(if app.public_page() { "on" } else { "off" }));
    out.insert(
        "github_secret_set".into(),
        json!(app.db.get("github_client_secret").is_some_and(|v| !v.is_empty())),
    );
    // Same shape for the OIDC secret, which is optional: a public client with
    // PKCE has none, and the token exchange then sends no secret at all.
    out.insert(
        "oidc_secret_set".into(),
        json!(app.db.get("oidc_client_secret").is_some_and(|v| !v.is_empty())),
    );
    // Whether there is a password at all, which decides two things in the panel:
    // a change asks for the current one only when it exists, and a restore needs
    // it to confirm. Never the hash itself, which is why this is a flag.
    out.insert("password_set".into(), json!(app.db.get("admin_password_hash").is_some()));
    // A password the hub generated and printed is not one the operator chose, so
    // it may be replaced without being produced. See `new_password`.
    out.insert("password_generated".into(), json!(app.db.get("password_generated").as_deref() == Some("on")));
    // Read-only here. A window is opened and closed through its own route, so the
    // key is always one the hub generated, and `save_settings` continues to refuse
    // both stored names.
    out.insert("register_key".into(), json!(app.db.get("register_key").unwrap_or_default()));
    out.insert("register_left".into(), json!(register_left(&app)));
    crate::notify::settings(&app, &mut out);
    Json(Value::Object(out))
}

/// Why one setting cannot be stored, or `None` when it can.
///
/// Separate from the write below because every key is validated before any is
/// written: changing the password drops every session, and a 400 raised
/// afterwards -- on a later key, in whatever order the map iterates -- carries no
/// Set-Cookie, signing the admin out of every device through a password change
/// the UI reported as rejected.
fn setting_error(key: &str, value: &Value) -> Option<String> {
    // Settings are stored as text. A caller sending the natural JSON type --
    // `{"public_page": false}`, `{"retention_days": 7}` -- is refused rather than
    // skipped, which would write nothing while the response reported success.
    let Some(value) = value.as_str() else { return Some(format!("设置 {key} 的值格式不对")) };
    match key {
        // Housekeeping clamps whatever it reads, so an unparsable value would be
        // stored, echoed back, and silently mean the default indefinitely.
        "retention_days"
            if !value.parse::<i64>().is_ok_and(|d| (1..=db::MAX_RETENTION_DAYS).contains(&d)) =>
        {
            Some(format!("历史保留天数要在 1 到 {} 之间", db::MAX_RETENTION_DAYS))
        }
        // The hub fetches this URL itself, so it must be one: a scheme it cannot
        // speak turns every agent download into a 502 that says nothing about the
        // setting responsible.
        //
        // https only. What returns from this host is the agent binary, which
        // `install.sh` writes to /opt/probe and starts on every node provisioned
        // here; over http:// anyone on the path between the hub and the mirror
        // chooses that binary, while the node still sees a valid TLS connection to
        // the hub.
        "github_proxy" if !(value.is_empty() || value.starts_with("https://")) => {
            Some("GitHub 代理必须以 https:// 开头：agent 程序经它下载，再安装到每个节点".into())
        }
        "favicon" | "touch_icon" if !value.is_empty() => {
            crate::frontend::site_icon(value).err().map(Into::into)
        }
        "admin_password" if value.len() < 12 => Some("密码至少 12 位".into()),
        "admin_password" => None,
        // The hub's own address, as the panel knows it. `https_domain` is the
        // rule the install commands already apply to `--site`, so a value saved
        // here is by construction one the rest of the panel can use: an https
        // domain entry, no path, no port, no userinfo. A path is refused because
        // this address is prefixed to `/api/...`, and a plaintext one because the
        // sign-in it exists for carries the authorization code and the session
        // cookie.
        "site_url" if !value.trim().is_empty() && https_domain(&http_address(value)).is_none() => Some(
            "站点 URL 只填域名（例如 hub.example.com），也可以是 host:端口；不能是 IP、不能带路径、? 或 #"
                .into(),
        ),
        // Empty turns OIDC off. A value has to be a base URL the hub can append
        // `/.well-known/openid-configuration` to, so it needs a scheme it can
        // speak and nothing after the path: a query or fragment there would be
        // swallowed by that append without a word. A path is allowed -- Authentik
        // puts one in its issuer.
        //
        // Held to that rule after [`issuer_address`], since the discovery URL an
        // operator pastes is stored as the base it names: refusing `https://host`
        // for what `/its/own/suffix` would have left of it refuses a value this
        // save would have corrected.
        "oidc_issuer" if !value.is_empty() && issuer_url(&issuer_address(value)).is_none() => {
            Some("身份系统地址要以 https:// 开头（本机或内网可以用 http://），且不能带 ? 或 #".into())
        }
        // The bindings are stored as `name:sub` pairs, so a colon inside a name
        // would be read as the start of a `sub` and the name would stop matching
        // the moment it was first bound. Refused at the door rather than left to
        // fail as a sign-in nobody can explain. A comma is the list's own
        // separator, so a name cannot contain one either -- that needs no check,
        // only a name the operator can actually type.
        "oidc_allowed_users" if value.contains(':') => {
            Some("用户名里不能有冒号：绑定记录用它分隔用户名与用户标识".into())
        }
        // The sign-in button's own label. A long one wraps the button and pushes
        // the emergency password form off the card.
        "oidc_provider_name" if value.chars().count() > 16 => Some("按钮名称最多 16 个字".into()),
        "origin_cdn_only" if !matches!(value, "" | "on" | "off") => {
            Some("源站只允许 CDN 访问：取值是 on 或 off".into())
        }
        k if k.starts_with("notify_") => crate::notify::setting_error(k, value),
        k if READABLE_SETTINGS.contains(&k) || k == "github_client_secret" || k == "oidc_client_secret" => {
            None
        }
        _ => Some(format!("没有这个设置项：{key}")),
    }
}

pub async fn save_settings(
    _: Admin,
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(settings) = body.as_object() else { return bad("设置格式不对") };
    let mut map = settings.clone();
    // Replacing the password is the other way into the account, so it asks for
    // the one it replaces: a session proves a browser signed in once, not that
    // its holder is the owner. Not when a generated password is what stands in
    // the way -- that one was printed once and may never have been read, so
    // demanding it would lock out exactly the operator who never saw it.
    let generated = app.db.get("password_generated").as_deref() == Some("on");
    if map.contains_key("admin_password") && app.db.get("admin_password_hash").is_some() && !generated {
        let given =
            map.remove("current_password").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        if let Some(refusal) = confirm_password(&app, client_ip(&app, &headers, peer.ip()), &given) {
            return refusal;
        }
    }
    for (key, value) in &map {
        if let Some(message) = setting_error(key, value) {
            return bad(&message);
        }
    }
    // An address saved from a plaintext request would lock its own author out:
    // every cookie issued afterwards carries `Secure`, and the browser discards
    // such a cookie on the http page they are reading. They would then be unable
    // to reach this setting to undo it -- the one failure a panel must not let a
    // reader talk themselves into. A hub started with `--site` is exempt: the
    // setting is inert there and writing it changes nothing.
    let address = map.get("site_url").and_then(|v| v.as_str()).unwrap_or_default();
    if app.site.is_empty() && !address.trim().is_empty() && !crate::request_is_https(&headers) {
        return bad("请用 https 域名访问面板后再设置站点 URL：从 http 保存会让会话 cookie 带上 Secure，
             而浏览器在 http 页面上会丢弃它，你就再也登不进来了");
    }
    // Set when the password changed: the change signs every session out, and the
    // caller receives a replacement rather than being logged out by it.
    let mut reissued = String::new();
    for (key, value) in &map {
        let value = value.as_str().unwrap_or_default();
        if key == "admin_password" {
            match hash_password(value).and_then(|h| {
                app.db.replace_password(&h)?;
                // The operator's own from here on, so the next change asks for
                // it; see `new_password`.
                app.db.set("password_generated", "off")?;
                issue_session(&app, &headers)
            }) {
                Ok(cookie) => reissued = cookie,
                Err(e) => return fail(e),
            }
            continue;
        }
        let saved = match key.as_str() {
            "github_allowed_users" => app.db.set_github_allowed(value),
            // Both savers also prune bindings, so neither may go through `set`.
            "oidc_allowed_users" => app.db.set_oidc_allowed(value),
            // Stored as `https://host`, without a trailing slash: it is prefixed
            // to `/api/...`, where `https://host/` + `/api/me` is a different
            // URL. The panel asks for the bare host, but a pasted full URL
            // arrives here too and is normalised rather than refused.
            "site_url" => app.db.set("site_url", &http_address(value)),
            // Stored without the discovery suffix an operator has almost
            // certainly pasted, and without a trailing slash, which would
            // otherwise produce `//.well-known` -- a path no provider serves.
            // See `issuer_address`.
            "oidc_issuer" => app.db.set("oidc_issuer", &issuer_address(value)),
            _ => app.db.set(key, value),
        };
        if let Err(e) = saved {
            return fail(e);
        }
    }
    with_cookies(Json(json!({"ok": true})), [reissued])
}

#[cfg(test)]
mod tests {
    use super::*;
    // Sessions remain hashed; only node tokens are stored in the clear.
    use crate::auth::sha256;
    use crate::db::{Db, Span};

    /// What a browser on `https://monitor.example.com` sends with a panel write.
    fn panel_headers() -> HeaderMap {
        HeaderMap::from_iter([
            (header::ORIGIN, "https://monitor.example.com".parse().unwrap()),
            (header::HeaderName::from_static("sec-fetch-site"), "same-origin".parse().unwrap()),
        ])
    }

    /// A sibling subdomain is the same site, so `SameSite=Lax` lets its bodiless
    /// POST carry the session; only `Sec-Fetch-Site` tells it from the panel.
    #[test]
    fn a_write_from_another_origin_is_refused() {
        let from = |site: &str| {
            HeaderMap::from_iter([(header::HeaderName::from_static("sec-fetch-site"), site.parse().unwrap())])
        };
        for site in ["same-site", "cross-site", "none"] {
            assert!(cross_site_write(&Method::POST, &from(site)), "{site}");
            assert!(cross_site_write(&Method::DELETE, &from(site)), "{site}");
        }
        assert!(!cross_site_write(&Method::POST, &from("same-origin")));
        assert!(!cross_site_write(&Method::POST, &HeaderMap::new()), "not a browser, or one too old to say");
        assert!(
            !cross_site_write(&Method::GET, &from("cross-site")),
            "reads are answered to the page that cannot read them"
        );
        // A WebSocket handshake is a GET that the page can read.
        assert!(from_other_origin(&from("same-site")));
        assert!(!from_other_origin(&from("same-origin")));
        assert!(!from_other_origin(&HeaderMap::new()));
    }

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn peer() -> ConnectInfo<std::net::SocketAddr> {
        ConnectInfo("198.51.100.7:40000".parse().unwrap())
    }

    /// Taken by every test that calls `metrics`. `HISTORY_GATE` is process-wide,
    /// and a test holding all of its permits would refuse a parallel one with a
    /// 503. Tokio's mutex, since the guard is held across awaits.
    static HISTORY_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A lookup nobody can refresh must not hide an update all day, and a panel
    /// left open on a screen must not ask GitHub on every load.
    #[test]
    fn a_release_lookup_is_held_for_six_hours_and_a_failed_one_for_ten_minutes() {
        let now = Utc::now().timestamp();
        let read = |read_at, hub: &str, agent: &str| crate::Releases {
            read_at,
            hub: hub.into(),
            agent: agent.into(),
        };
        assert!(!fresh_enough(&crate::Releases::default(), now), "nothing has been read yet");
        assert!(fresh_enough(&read(now - 5 * 3600, "1.2.0", "1.1.0"), now));
        assert!(!fresh_enough(&read(now - 7 * 3600, "1.2.0", "1.1.0"), now));
        assert!(fresh_enough(&read(now - 300, "", ""), now), "a failure is held briefly");
        assert!(!fresh_enough(&read(now - 1200, "1.2.0", ""), now), "half an answer is a failure");
        assert!(
            !fresh_enough(&read(now + 3600, "1.2.0", "1.1.0"), now),
            "read before the clock was set back"
        );
    }

    /// What the panel reads out of a release's `versions.json`, and what happens
    /// when the file is missing, malformed or half-empty: the tag falls back for
    /// both components, which is what a hub predating the file must keep seeing.
    #[test]
    fn a_versions_file_parses_and_falls_back_when_it_does_not() {
        let versions = |body: &str| serde_json::from_str::<ReleaseVersions>(body).ok();
        let read = |body: &str| {
            versions(body).filter(|v| !v.hub.is_empty() && !v.agent.is_empty()).map(|v| (v.hub, v.agent))
        };
        assert_eq!(read(r#"{"hub":"0.3.2","agent":"0.4.0"}"#), Some(("0.3.2".into(), "0.4.0".into())));
        assert_eq!(read(r#"{"hub":"0.3.2","agent":"0.3.1"}"#), Some(("0.3.2".into(), "0.3.1".into())));
        // Not JSON, missing fields, or a field with nothing to say: each is the
        // pre-versions.json world, answered by the tag.
        assert_eq!(read("<html>404</html>"), None, "a proxy's error page is not a versions file");
        assert_eq!(read(r#"{"hub":"0.3.2"}"#), None, "agent missing");
        assert_eq!(read(r#"{"hub":"","agent":"0.4.0"}"#), None, "hub empty");
        assert_eq!(read(r#"{"hub":"0.3.2","agent":""}"#), None, "agent empty");
        assert_eq!(read("null"), None);
    }

    fn app_with_site(site: &str) -> App {
        let mut state = app();
        state.site = site.into();
        state
    }

    /// The footer says who is reading. That address is the caller's own, and the
    /// answer carrying it must never be stored by anything between the two of
    /// them: `authed` was already reason enough, an address leaves no room.
    #[tokio::test]
    async fn me_names_the_caller_and_refuses_to_be_cached() {
        let answered = me(State(std::sync::Arc::new(app())), peer(), HeaderMap::new()).await;
        assert_eq!(
            answered.headers()[header::CACHE_CONTROL],
            "private, no-store",
            "an answer carrying a visitor's address is not cacheable"
        );
        let body = axum::body::to_bytes(answered.into_body(), 64 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["ip"], "198.51.100.7", "the peer's own address");
        assert_eq!(body["authed"], false, "and nothing else about the visitor");
    }

    /// The panel builds install commands, the OIDC callback and both sign-in
    /// cards from this address, so it reports what the hub actually knows --
    /// from the flag or the setting -- and whether the flag is what fixed it.
    #[tokio::test]
    async fn me_reports_the_address_and_whether_the_flag_fixed_it() {
        let read = |app: App| async move {
            let answered = me(State(std::sync::Arc::new(app)), peer(), HeaderMap::new()).await;
            let body = axum::body::to_bytes(answered.into_body(), 64 * 1024).await.unwrap();
            serde_json::from_slice::<Value>(&body).unwrap()
        };
        let configured = |app: App| {
            app.db.set("oidc_issuer", "https://id.example.com").unwrap();
            app.db.set("oidc_client_id", "monitor").unwrap();
            app.db.set("github_client_id", "gh").unwrap();
            app
        };

        // Nothing configured: the panel falls back to the browser's own address.
        let bare = read(configured(app())).await;
        assert_eq!(bare["site"], "", "no address known");
        assert_eq!(bare["site_fixed"], false);
        assert_eq!(bare["oidc"], false, "no address, no OIDC");

        // The setting answers for the deployment that has a domain and no flag.
        let by_setting = configured(app());
        by_setting.db.set("site_url", "https://panel.example.com").unwrap();
        let answered = read(by_setting).await;
        assert_eq!(answered["site"], "https://panel.example.com");
        assert_eq!(answered["site_fixed"], false, "the panel may still change it");
        assert_eq!(answered["oidc"], true);

        // The flag wins, and the panel is told so that it can lock the field.
        let mut by_flag = configured(app());
        by_flag.site = "https://flag.example.com".into();
        by_flag.db.set("site_url", "https://panel.example.com").unwrap();
        let answered = read(by_flag).await;
        assert_eq!(answered["site"], "https://flag.example.com");
        assert_eq!(answered["site_fixed"], true);

        // A plaintext address takes OIDC away and leaves GitHub alone: GitHub
        // takes its callback from the OAuth app and never sends a redirect_uri,
        // so the address plays no part in it.
        let mut clear = configured(app());
        clear.site = "http://hub.example.com".into();
        let answered = read(clear).await;
        assert_eq!(answered["oidc"], false, "the code would cross the wire in the clear");
        assert_eq!(answered["github"], true, "unaffected: it sends no redirect_uri");
    }

    /// The panel's address field is the one setting that can lock its own author
    /// out: every cookie issued after it carries `Secure`, and a browser on the
    /// http page they are reading discards such a cookie. So it is refused from
    /// a request that did not arrive over https.
    #[tokio::test]
    async fn the_address_is_not_saved_from_a_plaintext_request() {
        let app = std::sync::Arc::new(app());
        let put = |headers: HeaderMap, body: Value| {
            save_settings(Admin, State(app.clone()), peer(), headers, Json(body))
        };
        let https = || {
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-proto", "https".parse().unwrap());
            headers
        };

        let refused = put(HeaderMap::new(), json!({"site_url": "hub.example.com"})).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST, "http is not where this is set");
        assert_eq!(app.db.get("site_url"), None, "a refused save leaves nothing behind");

        assert_eq!(
            put(https(), json!({"site_url": " https://hub.example.com/ "})).await.status(),
            StatusCode::OK
        );
        assert_eq!(app.db.get("site_url").as_deref(), Some("https://hub.example.com"), "normalised");

        // Clearing it is allowed from anywhere: the risk is in setting an
        // address, not in going back to following the browser.
        assert_eq!(put(HeaderMap::new(), json!({"site_url": ""})).await.status(), StatusCode::OK);
        assert_eq!(app.db.get("site_url").as_deref(), Some(""), "cleared");

        // A hub whose address the flag already fixed is exempt: the setting is
        // inert there, and writing it changes nothing about the cookies.
        let flagged = std::sync::Arc::new(app_with_site("https://flag.example.com"));
        let put_flagged =
            |body: Value| save_settings(Admin, State(flagged.clone()), peer(), HeaderMap::new(), Json(body));
        assert_eq!(put_flagged(json!({"site_url": "hub.example.com"})).await.status(), StatusCode::OK);
    }

    /// A peer behind a proxy is the address the proxy forwarded, by the same
    /// rule the throttles key on -- otherwise every visitor of a proxied hub
    /// would read as `127.0.0.1` in the footer.
    #[tokio::test]
    async fn me_reads_the_forwarded_address_when_the_proxy_is_local() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        let local = ConnectInfo("127.0.0.1:5555".parse().unwrap());
        let answered = me(State(std::sync::Arc::new(app())), local, headers).await;
        let body = axum::body::to_bytes(answered.into_body(), 64 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["ip"], "203.0.113.9");
    }

    #[tokio::test]
    async fn provisioning_follows_the_browsers_own_origin() {
        let app = std::sync::Arc::new(app_with_site("https://monitor.example.com"));
        let good = panel_headers();
        assert!(provisioning_allowed(&app, &good).is_ok());

        // The four shapes a reverse proxy puts in Host and X-Forwarded-Proto
        // while the browser is on https: no X-Forwarded-Proto at all, the proxy's
        // own upstream address as Host, a plaintext hop behind a TLS edge, and a
        // port dropped by `$host`. Reading them instead of the origin refuses
        // each one.
        let mut proxied = good.clone();
        proxied.insert(header::HOST, "127.0.0.1:28080".parse().unwrap());
        proxied.insert("x-forwarded-proto", "http".parse().unwrap());
        assert!(provisioning_allowed(&app, &proxied).is_ok());

        for origin in [
            "http://monitor.example.com",
            "https://198.51.100.1",
            "null",
            // A registered name resolving wherever its owner points it, which is
            // not the loopback entry below however it is spelled.
            "http://127.0.0.1.example.com",
        ] {
            let mut headers = good.clone();
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert_eq!(provisioning_allowed(&app, &headers), Err(PROVISIONING_DENIED), "{origin}");
        }

        // A panel opened over a tunnel reads as loopback. It names no address a
        // node could reach, so it provisions alongside --site and not without it.
        for origin in ["http://127.0.0.1:9911", "http://localhost:9911", "http://[::1]:9911"] {
            let mut headers = good.clone();
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(provisioning_allowed(&app, &headers).is_ok(), "{origin}");
            assert!(provisioning_allowed(&app_with_site(""), &headers).is_err(), "{origin} without --site");
        }
        // No origin at all: every caller that is not a browser, and a browser
        // behind a proxy that clears the header, which the message names.
        let mut headers = good.clone();
        headers.remove(header::ORIGIN);
        assert_eq!(provisioning_allowed(&app, &headers), Err(ORIGIN_MISSING));

        // Both panel paths refuse, and neither leaves anything behind.
        headers = good.clone();
        headers.insert(header::ORIGIN, "http://monitor.example.com".parse().unwrap());
        let node = serde_json::from_value(json!({"name":"blocked"})).unwrap();
        assert_eq!(
            create_node(Admin, State(app.clone()), headers.clone(), Ok(Json(node))).await.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(open_register(Admin, State(app.clone()), headers).await.status(), StatusCode::FORBIDDEN);
        assert!(app.db.nodes().unwrap().is_empty());
        assert!(app.db.get("register_key").is_none());

        // --site takes the origin's place in the command, so one that is not an
        // https domain refuses every entry.
        for site in [
            "http://monitor.example.com",
            "https://198.51.100.1",
            "https://user@monitor.example.com",
            "https://monitor.example.com/path",
            "https://localhost",
            "https://hub.localhost",
        ] {
            assert!(https_domain(site).is_none());
            assert_eq!(provisioning_allowed(&app_with_site(site), &good), Err(PROVISIONING_DENIED), "{site}");
        }
    }

    /// Whatever this accepts is pushed to every assigned agent and passed directly
    /// to `lookup_host`. Forms it cannot resolve return -1 indefinitely, which the
    /// chart draws as a probe losing every packet, so the check must match what
    /// the error message claims.
    #[test]
    fn a_probe_target_must_be_something_the_agent_can_resolve() {
        // Each of these causes `lookup_host` to return an error, verified against
        // it: a bare IPv6 address is all colons, and the other two omit the half
        // the message requires.
        for bad in
            ["2606:4700:4700::1111", ":443", "example.com:", "1.1.1.1", "1.1.1.1:0", "[::1]:x", "[::1]"]
        {
            assert!(!valid_target(bad), "{bad}");
        }
        for good in ["1.1.1.1:443", "[2606:4700:4700::1111]:443", "example.com:80", "[::1]:1"] {
            assert!(valid_target(good), "{good}");
        }
    }

    /// The check above is meaningful only if it runs on the stored string: what
    /// reaches the agent is the stored value, and `lookup_host` rejects
    /// `"1.1.1.1:443 "` outright -- the permanent -1 `valid_target` exists to
    /// prevent, reachable through a check that passed.
    #[tokio::test]
    async fn a_probe_target_is_stored_as_the_string_that_was_checked() {
        let app = std::sync::Arc::new(app());
        let save = |name: &str, target: &str| {
            let task = PingTask {
                id: 0,
                name: name.to_owned(),
                target: target.to_owned(),
                interval: 60,
                nodes: vec![],
                ..Default::default()
            };
            save_ping_task(Admin, State(app.clone()), Json(task))
        };
        assert_eq!(save(" 探测 ", "1.1.1.1:443 ").await.status(), StatusCode::OK);
        let stored = &app.db.ping_tasks().unwrap()[0];
        assert_eq!(stored.target, "1.1.1.1:443", "the agent gets this string, not the one that was checked");
        assert_eq!(stored.name, "探测", "and it labels an anonymous chart");
        // Trimming must not turn a blank entry into a saved row.
        assert_eq!(save("   ", "   ").await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.ping_tasks().unwrap().len(), 1);
    }

    /// The same rule as `retention_days`, applied to the other value this hub
    /// clamps downstream: an out-of-range value must fail, or it silently becomes
    /// a different one. Below the floor that value is 5 seconds, the fastest probe
    /// available, and the panel reaches 0 simply by clearing its interval field,
    /// since `Number("")` is 0.
    #[tokio::test]
    async fn a_probe_interval_out_of_range_is_refused_rather_than_clamped() {
        let app = std::sync::Arc::new(app());
        let save = |interval| {
            let task = PingTask {
                id: 0,
                name: "probe".into(),
                target: "1.1.1.1:443".into(),
                interval,
                nodes: vec![],
                ..Default::default()
            };
            save_ping_task(Admin, State(app.clone()), Json(task))
        };
        for refused in [0, -1, 4, 3_601, i64::MAX] {
            assert_eq!(save(refused).await.status(), StatusCode::BAD_REQUEST, "{refused}");
        }
        let long = PingTask {
            name: "名".repeat(MAX_NAME + 1),
            target: "1.1.1.1:443".into(),
            interval: 60,
            ..Default::default()
        };
        assert_eq!(
            save_ping_task(Admin, State(app.clone()), Json(long)).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert!(app.db.ping_tasks().unwrap().is_empty(), "a refused interval must not store a probe");

        // Both ends of the range still save, storing exactly what was sent.
        for ok in [5, 60, 3_600] {
            assert_eq!(save(ok).await.status(), StatusCode::OK, "{ok}");
        }
        let stored: Vec<i64> = app.db.ping_tasks().unwrap().iter().map(|t| t.interval).collect();
        assert_eq!(stored, vec![5, 60, 3_600]);
    }

    /// The entire chunked-upload protocol: an upload is only ever as long as what
    /// has landed, so a piece continues it, restarts it, or is refused.
    #[tokio::test]
    async fn a_chunk_continues_an_upload_only_where_the_last_one_ended() {
        let tmp = crate::TempDir::new("chunk");
        let path = tmp.0.join("upload");
        let path = path.to_str().unwrap();
        let piece = |offset, total| Chunk { offset, total };
        let body = |bytes: &'static [u8]| axum::body::Body::from(bytes);

        // Two pieces in order, with the length indicating where the next begins.
        assert_eq!(receive(path, &piece(0, 6), 1024, body(b"abc")).await.unwrap(), 3);
        assert_eq!(receive(path, &piece(3, 6), 1024, body(b"def")).await.unwrap(), 6);
        assert_eq!(std::fs::read(path).unwrap(), b"abcdef");

        // A gap, a rewind and an overshoot all produce the same refusal.
        assert!(receive(path, &piece(9, 12), 1024, body(b"xyz")).await.is_err());
        assert!(receive(path, &piece(3, 12), 1024, body(b"xyz")).await.is_err());
        assert!(receive(path, &piece(6, 7), 1024, body(b"toolong")).await.is_err());
        // None of them modified the file, so the upload can continue.
        assert_eq!(std::fs::metadata(path).unwrap().len(), 6);

        // The ceiling is checked against the declared total, before any bytes
        // arrive.
        assert!(receive(path, &piece(0, 4096), 1024, body(b"a")).await.is_err());
        assert!(receive(path, &piece(0, 0), 1024, body(b"")).await.is_err());

        // Starting over truncates whatever an interrupted attempt left behind.
        assert_eq!(receive(path, &piece(0, 2), 1024, body(b"hi")).await.unwrap(), 2);
        assert_eq!(std::fs::read(path).unwrap(), b"hi");
    }

    /// Both scratch names a restore uses sit beside the live database, and one left
    /// behind is what the next upload fails on: `receive` refuses a first chunk
    /// that does not align with an existing file.
    ///
    /// This does not cover the rename in `db_restore`, which changes which path is
    /// open during the copy and would require a second upload landing inside it.
    /// It covers the part that outlives the request, which is what a later edit
    /// could silently drop.
    #[tokio::test]
    async fn a_finished_restore_leaves_no_scratch_file_behind() {
        let _password = crate::auth::PASSWORD_TESTS.lock().await;
        let tmp = crate::TempDir::new("restore");
        let dir = tmp.0.clone();
        let live = dir.join("live.db").to_string_lossy().into_owned();
        let app = std::sync::Arc::new(App::for_test(Db::open(&live).unwrap()));
        node(&app, "kept", true);
        app.db.set("origin_cdn_only", "on").unwrap();
        // Set before the backup is taken, so the restored file carries one too:
        // the second chunk arrives without a password, and only the first is
        // ever asked.
        app.db.set("admin_password_hash", &hash_password("a-long-enough-password").unwrap()).unwrap();
        // In the backup, and so restored with it unless the restore drops it.
        app.db.create_session(&sha256("backed-up"), Utc::now().timestamp() + 3_600).unwrap();

        // What a restore actually receives: a backup of a hub database.
        let copy = format!("{live}.copy");
        app.db.backup_into(&copy).unwrap();
        let bytes = std::fs::read(&copy).unwrap();
        std::fs::remove_file(&copy).unwrap();
        // Not in the backup: it stays until the last chunk has arrived.
        node(&app, "added", true);

        // In two chunks, as the panel sends any backup larger than one.
        let (total, half) = (bytes.len() as u64, bytes.len() / 2);
        let mut confirm = HeaderMap::new();
        confirm.insert("x-confirm-password", hex::encode("a-long-enough-password").parse().unwrap());
        let mut done = None;
        for (offset, piece) in [(0, &bytes[..half]), (half as u64, &bytes[half..])] {
            let piece = axum::body::Body::from(piece.to_vec());
            // Only the first piece carries it; the panel sends it the same way.
            let headers = if offset == 0 { confirm.clone() } else { HeaderMap::new() };
            done = Some(
                db_restore(Admin, State(app.clone()), Query(Chunk { offset, total }), peer(), headers, piece)
                    .await,
            );
            let expected = if offset == 0 { 2 } else { 1 };
            assert_eq!(app.db.nodes().unwrap().len(), expected, "restored on the last chunk alone");
        }
        assert_eq!(done.unwrap().status(), StatusCode::OK);
        assert_eq!(app.db.nodes().unwrap().len(), 1, "the backup went in");
        assert!(!app.db.session_valid(&sha256("backed-up")), "a session from the backup does not come back");
        assert_eq!(
            app.db.get("origin_cdn_only").as_deref(),
            Some("off"),
            "the premise is the operator's to restate"
        );

        // The database and its journal are the only files that may remain.
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|name| !matches!(name.as_str(), "live.db" | "live.db-wal" | "live.db-shm"))
            .collect();
        assert!(left.is_empty(), "left beside the database: {left:?}");
    }

    /// A restore replaces every node, setting and session, and nothing undoes it.
    /// A session only says some browser signed in within the fortnight, so the
    /// password is asked for again -- and a refusal writes nothing at all, which
    /// is what keeps a stolen cookie from meaning a wiped hub.
    #[tokio::test]
    async fn a_restore_writes_nothing_until_the_password_is_confirmed() {
        let _password = crate::auth::PASSWORD_TESTS.lock().await;
        let tmp = crate::TempDir::new("confirm");
        let live = tmp.0.join("live.db").to_string_lossy().into_owned();
        let app = std::sync::Arc::new(App::for_test(Db::open(&live).unwrap()));
        app.db.set("admin_password_hash", &hash_password("a-long-enough-password").unwrap()).unwrap();
        node(&app, "kept", true);
        let upload = format!("{}.upload", app.db.file());

        // One first piece of a three-byte upload. What the body holds never
        // matters: the check is ahead of it.
        let try_piece = |headers: HeaderMap| {
            db_restore(
                Admin,
                State(app.clone()),
                Query(Chunk { offset: 0, total: 3 }),
                peer(),
                headers,
                axum::body::Body::from("abc"),
            )
        };
        let with_password = |password: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("x-confirm-password", hex::encode(password).parse().unwrap());
            headers
        };

        assert_eq!(try_piece(HeaderMap::new()).await.status(), StatusCode::FORBIDDEN, "asked for");
        assert_eq!(
            try_piece(with_password("not-the-password")).await.status(),
            StatusCode::FORBIDDEN,
            "and refused when wrong"
        );
        assert!(!std::path::Path::new(&upload).exists(), "a refused restore must not start a file");
        assert_eq!(app.db.nodes().unwrap().len(), 1, "and changes nothing");

        // With the right password the check is behind us: what answers now is
        // the upload not being a database, which is a different refusal.
        let refused = try_piece(with_password("a-long-enough-password")).await;
        assert_ne!(refused.status(), StatusCode::FORBIDDEN);
        assert!(!std::path::Path::new(&upload).exists(), "nor does a failed one linger");
    }

    /// A connected agent holding one report. The receiver is returned because
    /// dropping it closes the channel, which is the signal `reset_token` is tested
    /// for.
    fn connect(app: &App, id: i64, metrics: Value) -> tokio::sync::mpsc::Receiver<String> {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let mut agent = crate::agent_ws::Agent::new(7, tx);
        agent.metrics = metrics;
        agent.last_seen = Utc::now().timestamp();
        app.agents.write().unwrap().insert(id, agent);
        rx
    }

    /// A probe assigned to `nodes`. The window query draws only a node's current
    /// assignments, so a fixture holding ping records requires one.
    fn task(app: &App, nodes: Vec<i64>) -> i64 {
        app.db
            .save_ping_task(&PingTask {
                id: 0,
                name: "probe".into(),
                target: "1.1.1.1:443".into(),
                interval: 60,
                nodes,
                ..Default::default()
            })
            .unwrap()
    }

    fn node(app: &App, name: &str, public: bool) -> i64 {
        app.db
            .create_node(
                &Node { name: name.into(), public, remark: "secret note".into(), ..Default::default() },
                &format!("token-of-{name}"),
            )
            .unwrap()
    }

    /// A chart request costs roughly the same whatever it spans. This path
    /// requires no session, so an unbounded window would be megabytes of JSON any
    /// caller could have the hub build.
    #[test]
    fn a_history_window_costs_the_same_however_wide_it_is() {
        let app = app();
        let id = node(&app, "n", true);
        let now = Utc::now().timestamp();
        // A month of history at the rate the hub writes it, folded as the hourly
        // pass would. Two probes, because the budget is per series and a
        // single-probe fixture would conceal that.
        const PROBES: i64 = 2;
        for _ in 0..PROBES {
            task(&app, vec![id]);
        }
        for i in 0..30 * 1440 {
            app.db.insert_metric(id, now - i * 60, &json!({"cpu": 1.0})).unwrap();
            for task in 1..=PROBES {
                app.db.insert_pings(id, &[(task, now - i * 60, 42)]).unwrap();
            }
        }
        app.db.roll_up(now, 365).unwrap();

        // Including windows that do not divide evenly, which are where a step
        // rounded the wrong way overruns, and both sides of the hourly tier.
        for hours in [1, 6, 13, 23, 24, 168, 169, 720, 8_760] {
            let span = span(hours, None, now);
            assert_eq!(span.hourly, hours > 168, "{hours}h");
            if span.hourly {
                assert_eq!(span.step % 3_600, 0, "{hours}h: an hourly row straddles two points");
            }
            let metrics = app.db.metrics(id, span).unwrap();
            let (ping, _) = app.db.ping_records(id, span).unwrap();
            // Against the budget itself rather than whatever the step produced:
            // derived from the step, this would only demonstrate that division
            // works. One bucket of slack, as the window rarely divides evenly.
            let cap = 1_441;
            assert!(metrics.len() <= cap, "{hours}h returned {} metric rows", metrics.len());
            assert!(
                ping.len() <= cap * PROBES as usize,
                "{hours}h returned {} ping rows for {PROBES} probes",
                ping.len()
            );
            // Thinned, but neither empty nor reaching outside the window.
            assert!(!metrics.is_empty() && !ping.is_empty(), "{hours}h returned nothing");
            assert!(
                metrics.iter().all(|m| m["ts"].as_i64().unwrap() >= span.since),
                "{hours}h reached back too far"
            );
            // Begun on a point boundary, so the first point is a whole one where
            // the history reaches past it: this node reported every minute.
            if hours < 720 {
                assert_eq!(metrics[0]["minutes"], span.step / 60, "{hours}h opened partway through a point");
            }
        }

        // A day returns every minute it holds: thinning exists only for what the
        // screen cannot draw.
        let step = |hours, points| span(hours, points, now).step;
        assert_eq!(step(24, Some(2_000)), 60, "a day of minutes fits under the ceiling");
        assert_eq!(step(6, Some(2_000)), 60, "and so does six hours");
        assert_eq!(step(720, None), 3_600, "a month is its hours");

        // A caller may request less than the budget, never more: the ceiling
        // belongs to the hub, since this path takes no credentials.
        assert!(step(24, Some(390)) > step(24, None));
        assert_eq!(step(24, Some(100_000)), step(24, None));
        assert_eq!(step(24, Some(0)), step(24, Some(60)));

        // Requesting one half leaves the other empty rather than sending it: on
        // the day window that half was two thirds of the response.
        let series = |q: &str| serde_urlencoded::from_str::<Window>(q).unwrap().series;
        assert_eq!(series("hours=24&series=ping").as_deref(), Some("ping"));
        assert!(series("hours=24").is_none(), "no series means both, which is what curl gets");
    }

    /// What a thinned bucket may return. Keeping one row and discarding the rest
    /// would integrate the seven-day chart to twice the traffic the minutes hold,
    /// and draw a probe losing half its packets as an unbroken line.
    #[test]
    fn a_thinned_bucket_answers_with_its_mean_and_says_what_it_lost() {
        let app = app();
        let id = node(&app, "n", true);
        // Anchored on a bucket boundary, one whole bucket in the past. Anchored on
        // `now`, the rows would straddle the boundary depending on the second the
        // suite runs at.
        let base = Utc::now().timestamp() / 120 * 120 - 120;
        // One bucket: a quiet minute and a busy one, then a probe that answered
        // once and timed out three times.
        // The quiet minute predates the peak column, whose default is 0.
        app.db.insert_metric(id, base + 10, &json!({"cpu": 0.0, "net_rx": 0, "net_tx": 3_000})).unwrap();
        app.db
            .insert_metric(
                id,
                base + 70,
                &json!({"cpu": 40.0, "net_rx": 1_000, "net_rx_max": 4_000, "net_tx": 1_000, "net_tx_max": 2_000}),
            )
            .unwrap();
        for _ in 0..3 {
            task(&app, vec![id]);
        }
        for (i, latency) in [30, -1, -1, -1].into_iter().enumerate() {
            app.db.insert_pings(id, &[(1, base + 10 + i as i64 * 20, latency)]).unwrap();
        }
        // A second probe that never answered, and a third that answered cleanly.
        app.db.insert_pings(id, &[(2, base + 10, -1)]).unwrap();
        app.db.insert_pings(id, &[(3, base + 10, 12)]).unwrap();

        let m = &app.db.metrics(id, Span::minutes(base, 120)).unwrap()[0];
        assert_eq!(m["cpu"], 20.0, "the bucket is its mean, not one row of it");
        assert_eq!(m["net_rx"], 500);
        assert_eq!(m["net_rx_max"], 4_000, "the bucket peaks where its busiest minute did");
        assert_eq!(m["net_tx_max"], 3_000, "a row without a peak counts as its own mean");
        assert_eq!(m["ts"], base, "stamped with the bucket, so every series shares a grid");

        // Keyed by task rather than index: the order is the panel's, which
        // `a_probe_chart_follows_the_panel_order` covers.
        let (rows, window_loss) = app.db.ping_records(id, Span::minutes(base, 120)).unwrap();
        let probe = |task: i64| {
            rows.iter().find(|r| r["task_id"] == task).unwrap_or_else(|| panic!("no probe {task}"))
        };
        assert_eq!(probe(1)["latency"], 30, "the median of what answered, not of the timeouts");
        assert_eq!(probe(1)["loss"], 75);
        assert_eq!(probe(2)["latency"], json!(null), "a bucket that was all timeout has no latency");
        assert_eq!(probe(2)["loss"], 100);
        // One answer, so there is nothing for a band to span.
        assert!(probe(1).get("band").is_none(), "{:?}", probe(1));
        // A clean bucket carries no loss key, which is why the percentage rounds
        // up: the key's absence denotes no loss, so no loss must be the only way
        // to produce it.
        assert!(probe(3).get("loss").is_none(), "{:?}", probe(3));
        // Each probe has one bucket here, so the window and bucket figures agree
        // -- precisely the fixture shape that concealed the difference between
        // them. The test below separates the two.
        assert_eq!(window_loss["2"], 100.0);
        assert!(window_loss.get("3").is_none(), "a probe that lost nothing is left out");

        // One timeout in a bucket too large for it to reach a whole percent:
        // truncating would report the same as a clean bucket.
        let wide = node(&app, "wide", true);
        let wide_probe = task(&app, vec![wide]);
        let wide_base = base / 180 * 180;
        for i in 0..180 {
            app.db.insert_pings(wide, &[(wide_probe, wide_base + i, if i == 0 { -1 } else { 20 })]).unwrap();
        }
        let (rows, _) = app.db.ping_records(wide, Span::minutes(wide_base, 180)).unwrap();
        assert_eq!(rows.len(), 1, "the fixture has to be one bucket for this to mean anything");
        let row = &rows[0];
        assert_eq!(row["loss"], 1, "a bucket that lost one of 180 has not lost none");

        // What the band conveys: the median reading and the two extremes the
        // bucket reached. Drawing 20 alone would render a 40 ms swing as a flat
        // point.
        let jitter = node(&app, "jitter", true);
        let jitter_probe = task(&app, vec![jitter]);
        for (i, latency) in [10, 20, 50, 20, 20].into_iter().enumerate() {
            app.db.insert_pings(jitter, &[(jitter_probe, wide_base + i as i64, latency)]).unwrap();
        }
        let row = &app.db.ping_records(jitter, Span::minutes(wide_base, 180)).unwrap().0[0];
        assert_eq!(row["latency"], 20, "the middle answer, not the mean of 24");
        assert_eq!(row["band"], json!([10, 50]));

        // An even count has no single middle value, so it is the mean of the two
        // straddling it. Every neighbouring pair differs, so selecting one rank
        // either way would yield 20 or 30 rather than 25.
        let even = node(&app, "even", true);
        let even_probe = task(&app, vec![even]);
        for (i, latency) in [40, 10, 30, 20].into_iter().enumerate() {
            app.db.insert_pings(even, &[(even_probe, wide_base + i as i64, latency)]).unwrap();
        }
        assert_eq!(app.db.ping_records(even, Span::minutes(wide_base, 180)).unwrap().0[0]["latency"], 25);
        // An odd count is its middle reading, with the ranks around it far apart.
        let odd = node(&app, "odd", true);
        let odd_probe = task(&app, vec![odd]);
        for (i, latency) in [20, 900, 30].into_iter().enumerate() {
            app.db.insert_pings(odd, &[(odd_probe, wide_base + i as i64, latency)]).unwrap();
        }
        assert_eq!(app.db.ping_records(odd, Span::minutes(wide_base, 180)).unwrap().0[0]["latency"], 30);

        // Several buckets: each row is stamped with its own bucket's start.
        let grid = node(&app, "grid", true);
        let grid_probe = task(&app, vec![grid]);
        // Three whole buckets in the past, whatever second the suite runs at.
        let since = wide_base - 3 * 180;
        for i in 0..3 {
            app.db.insert_pings(grid, &[(grid_probe, since + i * 180 + 7, 20)]).unwrap();
        }
        let rows = app.db.ping_records(grid, Span::minutes(since, 180)).unwrap().0;
        let stamps: Vec<_> = rows.iter().map(|r| r["ts"].clone()).collect();
        assert_eq!(stamps, [since, since + 180, since + 360].map(|t| json!(t)));
    }

    /// What a window lost is the proportion of its samples lost, and only the hub
    /// can determine it: `close_bucket` divides within each bucket and keeps the
    /// quotient, so the denominators are gone by the time a reader sees the rows.
    /// Averaging the bucket percentages would weight a bucket holding one sample
    /// equally with one holding twelve, and unequal buckets are the ordinary case
    /// rather than an edge one. The window's first and last are partial by
    /// construction, and a probe that starts, stops, loses its node or skips a
    /// round on a slow resolver produces more.
    #[test]
    fn a_probe_reports_the_share_of_the_window_it_lost_not_the_mean_of_its_buckets() {
        let app = app();
        let id = node(&app, "n", true);
        let probe = task(&app, vec![id]);
        let base = Utc::now().timestamp() / 60 * 60 - 120;
        // A full minute at five seconds per round with no loss, then a minute
        // holding one sample, which was lost, before the probe stopped.
        for i in 0..12 {
            app.db.insert_pings(id, &[(probe, base + i * 5, 20)]).unwrap();
        }
        app.db.insert_pings(id, &[(probe, base + 60, -1)]).unwrap();

        let (rows, loss) = app.db.ping_records(id, Span::minutes(base, 60)).unwrap();
        let per_bucket: Vec<i64> = rows.iter().map(|r| r["loss"].as_i64().unwrap_or(0)).collect();
        assert_eq!(per_bucket, vec![0, 100], "the buckets are right about themselves");

        // Their mean is 50%, while one round of thirteen did not answer.
        let window = loss.get(probe.to_string()).and_then(|v| v.as_f64()).expect("this probe lost one");
        assert!((window - 100.0 / 13.0).abs() < 1e-9, "{window}");
        assert!(window < 8.0, "the window lost {window}%, not the 50% its buckets average to");
    }

    #[test]
    fn the_public_view_hides_private_nodes_and_sensitive_fields() {
        let app = app();
        let open = node(&app, "open", true);
        node(&app, "hidden", false);
        app.db.save_facts(open, &json!({"hostname": "vps-1"}), "198.51.100.9", "").unwrap();

        // A live report, so the public view has metrics to strip. `hostname` is
        // what a node token in the wrong hands can insert, and what the agent
        // repository could add to the contract.
        let _held = connect(
            &app,
            open,
            json!({"boot_id": "abc", "net_rx_total": 134_000_000_000i64, "cpu": 1.0, "iface": "eth1",
                   "hostname": "db-prod-01", "ip": "203.0.113.7", "total_rx": 1}),
        );

        let public = visible_nodes(&app, false).unwrap();
        assert_eq!(public.len(), 1, "a node marked private must not be listed");
        assert_eq!(public[0]["name"], "open");
        // Disclosing the token would let any visitor impersonate the node.
        for hidden in ["ip", "addresses", "ipv4_auto", "ipv6_auto", "remark", "hostname", "token", "interval"]
        {
            assert!(public[0].get(hidden).is_none(), "{hidden} must not be public");
        }
        assert!(
            !serde_json::to_string(&public).unwrap().contains("token-of-open"),
            "no node's token may appear anywhere in a public payload"
        );
        // Raw kernel counters would disclose the machine's lifetime traffic, and
        // anything the contract does not name is not published at all, the report
        // coming from a machine holding one node's token.
        for hidden in ["boot_id", "net_rx_total", "net_tx_total", "hostname", "ip"] {
            assert!(public[0]["metrics"].get(hidden).is_none(), "{hidden} must not be public");
        }
        assert_eq!(public[0]["metrics"]["cpu"], 1.0, "the rest of the report still goes out");
        assert!(public[0]["metrics"].get("iface").is_none(), "the interface list is the panel's");

        let admin = visible_nodes(&app, true).unwrap();
        assert_eq!(admin.len(), 2);
        assert_eq!(admin[0]["ip"], "198.51.100.9");
        assert_eq!(admin[0]["remark"], "secret note");
        assert!(
            !serde_json::to_string(&admin).unwrap().contains("token-of-open"),
            "the token is read on its own, never beside what agents report"
        );
        // The panel reads `iface` and nothing else the contract leaves out.
        assert_eq!(admin[0]["metrics"]["iface"], "eth1");
        for hidden in ["boot_id", "net_rx_total", "hostname", "ip"] {
            assert!(admin[0]["metrics"].get(hidden).is_none(), "{hidden} is not part of the panel's frame");
        }
        // The traffic inside `metrics` is the hub's, whatever the report claimed.
        for view in [&public[0], &admin[0]] {
            assert_eq!(view["metrics"]["total_rx"], view["total_rx"]);
            assert_eq!(view["metrics"]["month_tx"], view["month_tx"]);
        }
    }

    /// One address per family, marked with where it came from.
    #[test]
    fn a_node_shows_the_address_it_is_reached_by() {
        let rows = |ip, held, pins| -> Vec<String> {
            addresses([ip, ""], held, pins).into_iter().map(|(a, source)| format!("{a} {source}")).collect()
        };
        let none = ("", "");
        // A public interface is the machine; a different exit in front of it is a
        // proxy and stays out.
        assert_eq!(
            rows("2001:db8::2", ("203.0.113.7", "2001:db8::2"), none),
            ["203.0.113.7 interface", "2001:db8::2 interface"]
        );
        assert_eq!(rows("198.51.100.1", ("203.0.113.7", ""), none), ["203.0.113.7 interface"]);
        // NAT: the exit replaces the private interface address, which nobody
        // outside can use.
        assert_eq!(rows("203.0.113.7", ("10.10.2.250", ""), none), ["203.0.113.7 exit"]);
        assert_eq!(rows("203.0.113.7", ("100.64.0.9", ""), none), ["203.0.113.7 exit"]);
        // An LXC guest behind NAT with a public /128, reached over v4 by a current
        // agent...
        assert_eq!(
            rows("203.0.113.7", ("10.10.1.5", "2401:b60:1c::5"), none),
            ["203.0.113.7 exit", "2401:b60:1c::5 interface"]
        );
        // ...and over v6 by an older one reporting the ULA ahead of it.
        assert_eq!(rows("2401:b60:1c::5", ("10.10.1.5", "fd42:43af::1"), none), ["2401:b60:1c::5 exit"]);
        // NAT66: a private v4 and a ULA v6, the session over v4 and a second
        // connection over v6. Each exit stands in for its own family's address,
        // and the one in a family the interface lacks is a translator again.
        let both = |held| -> Vec<String> {
            addresses(["203.0.113.7", "2001:db8:1::9"], held, none)
                .into_iter()
                .map(|(a, source)| format!("{a} {source}"))
                .collect()
        };
        assert_eq!(both(("10.0.0.5", "fd00::5")), ["203.0.113.7 exit", "2001:db8:1::9 exit"]);
        assert_eq!(both(("10.0.0.5", "")), ["203.0.113.7 exit"]);
        assert_eq!(both(("10.0.0.5", "2401:b60:1c::5")), ["203.0.113.7 exit", "2401:b60:1c::5 interface"]);
        // Behind a transparent proxy the exit is the proxy's; the home line can
        // only be set by hand.
        let home = ("192.168.1.5", "2409:8a1e::5");
        assert_eq!(rows("198.51.100.77", home, none), ["198.51.100.77 exit", "2409:8a1e::5 interface"]);
        assert_eq!(
            rows("198.51.100.77", home, ("203.0.113.50", "")),
            ["203.0.113.50 manual", "2409:8a1e::5 interface"]
        );
        // A pin wins over a public interface too, and may name a private address
        // for use on the LAN.
        assert_eq!(
            rows("", ("203.0.113.7", "2001:db8::5"), ("", "2001:db8::9")),
            ["203.0.113.7 interface", "2001:db8::9 manual"]
        );
        assert_eq!(rows("203.0.113.7", ("10.0.0.2", ""), ("10.0.0.2", "")), ["10.0.0.2 manual"]);
        // No interface in the exit's family: a translator (NAT64, WARP) that does
        // not lead to the machine.
        assert_eq!(rows("104.28.1.1", ("", "2001:db8::5"), none), ["2001:db8::5 interface"]);
        // An address reported under the other family's name is not that family's.
        assert_eq!(rows("203.0.113.7", ("2001:db8::5", ""), none), ["203.0.113.7 exit"]);
        // Nothing public anywhere: hub and node share a network, and the private
        // addresses are all there is.
        assert_eq!(rows("192.168.1.2", ("192.168.1.5", ""), none), ["192.168.1.5 interface"]);
        assert_eq!(
            rows("fd00::2", ("10.0.0.2", "fd00::5"), none),
            ["10.0.0.2 interface", "fd00::5 interface"]
        );
        assert_eq!(
            rows("198.18.0.1", ("192.168.1.5", ""), none),
            ["192.168.1.5 interface"],
            "a TUN proxy's fake-IP range is not public"
        );
        // With no interface reported the connection is all there is, and nothing
        // says it is not the machine's own.
        assert_eq!(rows("203.0.113.7", none, none), ["203.0.113.7 connection"]);
        assert_eq!(rows("", ("10.0.0.2", ""), none), ["10.0.0.2 interface"]);
        assert!(rows("", none, none).is_empty());

        // The panel gets the list, and per family what shows with the pin
        // cleared.
        let app = app();
        let id = node(&app, "n", true);
        app.db
            .save_facts(id, &json!({"ipv4": "10.10.1.5", "ipv6": "2401:b60:1c::5"}), "203.0.113.7", "")
            .unwrap();
        let patch: NodePatch = serde_json::from_value(json!({"ipv4_pin": "198.51.100.50"})).unwrap();
        app.db.update_node(id, &patch).unwrap();
        let view = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(
            view["addresses"],
            json!([{"address": "198.51.100.50", "source": "manual"}, {"address": "2401:b60:1c::5", "source": "interface"}])
        );
        assert_eq!(
            (&view["ipv4_auto"], &view["ipv6_auto"]),
            (&json!("203.0.113.7"), &json!("2401:b60:1c::5"))
        );

        // Private addresses show only when nothing public is known, so the pin
        // the other family keeps decides: v4 falls back to nothing while the v6
        // pin stands.
        let lan = node(&app, "lan", true);
        app.db
            .save_facts(lan, &json!({"ipv4": "192.168.1.5", "ipv6": "fd00::5"}), "192.168.1.2", "")
            .unwrap();
        let patch: NodePatch = serde_json::from_value(json!({"ipv6_pin": "2001:db8::9"})).unwrap();
        app.db.update_node(lan, &patch).unwrap();
        let view = visible_nodes(&app, true).unwrap().into_iter().find(|v| v["id"] == lan).unwrap();
        assert_eq!((&view["ipv4_auto"], &view["ipv6_auto"]), (&json!(""), &json!("fd00::5")));
    }

    #[tokio::test]
    async fn rotating_a_token_closes_the_session_the_old_one_opened() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        let mut rx = connect(&app, id, Value::Null);

        let response = reset_token(Admin, axum::extract::State(app.clone()), Path(id)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let issued = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        let read = node_token(Admin, axum::extract::State(app.clone()), Path(id)).await;
        assert_eq!(
            axum::body::to_bytes(read.into_body(), 1024).await.unwrap(),
            issued,
            "the panel reads the new token"
        );
        // The agent loop selects on this receiver, so a closed channel is how it
        // learns to stop. `try_recv`, because `recv().await` on a channel
        // incorrectly left open would hang the suite rather than fail it.
        assert!(
            matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)),
            "the old agent's channel must be closed"
        );
        assert!(app.agents.read().unwrap().is_empty(), "the node must read as offline at once");
    }

    /// A batch writes to every selected node or to none, accepts only what a
    /// selection can share, and a group reaches the status page.
    #[tokio::test]
    async fn a_batch_edit_applies_to_all_selected_nodes_or_none() {
        let app = std::sync::Arc::new(app());
        let state = || axum::extract::State(app.clone());
        let (a, b, c) = (node(&app, "a", true), node(&app, "b", true), node(&app, "c", true));
        let batch = |ids: Vec<i64>, patch: Value| {
            Ok(Json(NodeBatch { ids, patch: serde_json::from_value(patch).unwrap() }))
        };
        let group = |id| app.db.node(id).unwrap().unwrap().group;

        let r =
            update_nodes(Admin, state(), batch(vec![a, b, a], json!({"group": " 香港 ", "notify": true})))
                .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!((group(a), group(b), group(c)), ("香港".into(), "香港".into(), String::new()));
        assert!(app.db.node(b).unwrap().unwrap().notify);

        // One id gone: nothing is written, not even to the nodes still there.
        let r = update_nodes(Admin, state(), batch(vec![a, 999], json!({"group": "东京"}))).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert_eq!(group(a), "香港", "a refused batch leaves every node as it was");

        // Only the listed fields deserialize, so the extractor refuses the rest.
        for refused in [
            json!({"name": "x"}),
            json!({"ipv4_pin": "1.2.3.4"}),
            json!({"public": false}),
            json!({"public_remark": "x"}),
        ] {
            assert!(serde_json::from_value::<BatchPatch>(refused.clone()).is_err(), "{refused}");
        }
        // Counted in characters, not bytes: thirteen of them take 39 bytes.
        let r = update_nodes(Admin, state(), batch(vec![a], json!({"group": "港".repeat(MAX_GROUP)}))).await;
        assert_eq!(r.status(), StatusCode::OK);
        let r =
            update_nodes(Admin, state(), batch(vec![a], json!({"group": "港".repeat(MAX_GROUP + 1)}))).await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            update_nodes(Admin, state(), batch(vec![], json!({"notify": false}))).await.status(),
            StatusCode::BAD_REQUEST
        );

        assert!(live_snapshot(&app, false).as_str().contains(r#""group":"香港""#), "the group is public");
    }

    /// The public note reaches visitors trimmed, and one too long for every
    /// frame, or one carrying a line break, is refused rather than cut.
    #[tokio::test]
    async fn a_public_remark_is_bounded_and_reaches_visitors() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        let put = |text: String| {
            let patch = serde_json::from_value(json!({ "public_remark": text })).unwrap();
            update_node(Admin, axum::extract::State(app.clone()), Path(id), Ok(Json(patch)))
        };

        assert_eq!(put("港".repeat(MAX_PUBLIC_REMARK + 1)).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(put("一行\n两行".into()).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(put(" CN2 GIA ".into()).await.status(), StatusCode::OK);
        let public = &visible_nodes(&app, false).unwrap()[0];
        assert_eq!((&public["public_remark"], &public["remark"]), (&json!("CN2 GIA"), &Value::Null));
        // Counted in characters, not bytes.
        assert_eq!(put("港".repeat(MAX_PUBLIC_REMARK)).await.status(), StatusCode::OK);
    }

    /// Days to expiry are counted on the hub's calendar and are public, like the
    /// date itself; no date counts nothing.
    #[test]
    fn days_to_expiry_follow_the_hubs_calendar() {
        let app = app();
        let id = node(&app, "a", true);
        let expires_in = || visible_nodes(&app, false).unwrap()[0]["expires_in"].clone();
        assert_eq!(expires_in(), Value::Null);
        let today = Local::now().date_naive();
        for days in [3, 0, -1] {
            app.db.set_expiry(id, &(today + chrono::Duration::days(days)).to_string()).unwrap();
            assert_eq!(expires_in(), json!(days));
        }
    }

    /// A write naming a node that no longer exists, such as one deleted from
    /// another tab, is refused rather than reported as saved.
    #[tokio::test]
    async fn writes_to_a_missing_node_are_not_found() {
        let app = std::sync::Arc::new(app());
        let state = || axum::extract::State(app.clone());
        let patch = Ok(Json(NodePatch { notify: Some(true), ..Default::default() }));
        assert_eq!(update_node(Admin, state(), Path(9), patch).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(delete_node(Admin, state(), Path(9)).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(reset_token(Admin, state(), Path(9)).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(node_token(Admin, state(), Path(9)).await.status(), StatusCode::NOT_FOUND);
        let traffic = Json(TrafficPatch { total_rx: Some(1), ..Default::default() });
        assert_eq!(patch_traffic(Admin, state(), Path(9), traffic).await.status(), StatusCode::NOT_FOUND);
    }

    /// Deleting a node must reach the connection it opened, for the same reason
    /// rotating its token does, and a node created afterwards inherits nothing.
    #[tokio::test]
    async fn deleting_a_node_closes_its_session_so_the_next_id_does_not_inherit_it() {
        let app = std::sync::Arc::new(app());
        let old = node(&app, "old", true);
        let mut rx = connect(&app, old, json!({"cpu": 42.0}));

        assert_eq!(
            delete_node(Admin, axum::extract::State(app.clone()), Path(old)).await.status(),
            StatusCode::OK
        );
        assert!(
            matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)),
            "the deleted node's agent must be told to go"
        );

        let fresh = node(&app, "fresh", true);
        assert_ne!(fresh, old, "a deleted node's id is not issued again");
        let nodes = visible_nodes(&app, true).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["online"], json!(false), "a node nobody deployed is not online");
        assert_eq!(nodes[0]["metrics"], Value::Null, "and it has nobody else's metrics");
    }

    /// Values set by hand take the place of automatic ones, so each is held to
    /// what the automatic value would have to be, and of the three only the
    /// country reaches the status page. The create path stores none of them.
    #[tokio::test]
    async fn values_set_by_hand_are_checked_and_only_the_country_goes_public() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        app.db.save_facts(id, &json!({}), "198.51.100.77", "198.51.100.77").unwrap();
        app.db.set_country(id, "SG", "198.51.100.77").unwrap();
        let put = |patch: Value| {
            update_node(
                Admin,
                axum::extract::State(app.clone()),
                Path(id),
                Ok(Json(serde_json::from_value(patch).unwrap())),
            )
        };
        for bad in [
            json!({"country_pin": "CHN"}),
            json!({"country_pin": "中国"}),
            json!({"country_pin": "C1"}),
            json!({"ipv4_pin": "2409:8a1e::5"}),
            json!({"ipv4_pin": "203.0.113.9:22"}),
            json!({"ipv4_pin": "203.0.113.256"}),
            json!({"ipv6_pin": "203.0.113.9"}),
            json!({"ipv6_pin": "[2409:8a1e::5]:22"}),
        ] {
            assert_eq!(put(bad.clone()).await.status(), StatusCode::BAD_REQUEST, "accepted {bad}");
        }
        let typed =
            json!({"country_pin": " cn ", "ipv4_pin": " 203.0.113.9 ", "ipv6_pin": "2409:8A1E:0::0088"});
        assert_eq!(put(typed).await.status(), StatusCode::OK);
        let stored = app.db.node(id).unwrap().unwrap();
        assert_eq!(
            (stored.country_pin.as_str(), stored.ipv4_pin.as_str(), stored.ipv6_pin.as_str()),
            ("CN", "203.0.113.9", "2409:8a1e::88"),
            "stored canonical"
        );

        let public = visible_nodes(&app, false).unwrap()[0].to_string();
        assert!(public.contains(r#""country":"CN""#), "the pin replaces the looked-up country: {public}");
        assert!(
            !public.contains("203.0.113.9") && !public.contains("2409:8a1e::88") && !public.contains("SG")
        );
        let full = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(
            (full["country_auto"].as_str(), full["ipv4_pin"].as_str()),
            (Some("SG"), Some("203.0.113.9"))
        );

        // A hello leaves the pins alone; empty returns each to automatic.
        app.db.save_facts(id, &json!({}), "198.51.100.88", "198.51.100.88").unwrap();
        assert_eq!(app.db.node(id).unwrap().unwrap().ipv4_pin, "203.0.113.9");
        assert_eq!(
            put(json!({"country_pin": "", "ipv4_pin": " ", "ipv6_pin": ""})).await.status(),
            StatusCode::OK
        );
        let stored = app.db.node(id).unwrap().unwrap();
        assert!(stored.country_pin.is_empty() && stored.ipv4_pin.is_empty() && stored.ipv6_pin.is_empty());
        assert_eq!(
            visible_nodes(&app, false).unwrap()[0]["country"],
            "",
            "back to the lookup, which the new address left owing"
        );
    }

    /// Both writers enforce the same limits, so nothing the update path refuses
    /// is reachable through the create path, which takes a whole `Node`.
    #[tokio::test]
    async fn both_write_paths_refuse_the_same_out_of_range_values() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        for bad in [
            json!({"name": "x", "traffic_reset_day": 99}),
            json!({"name": "x", "price": -5.0}),
            json!({"name": "x", "traffic_limit": -1}),
            json!({"name": "x", "currency": "USDT"}),
            json!({"name": "x", "currency": "港币"}),
            json!({"name": "x", "billing_cycle": "0m"}),
            json!({"name": "x", "billing_cycle": "1201m"}),
            json!({"name": "x", "billing_cycle": "weekly"}),
            json!({"name": "名".repeat(MAX_NAME + 1)}),
        ] {
            let created = create_node(
                Admin,
                axum::extract::State(app.clone()),
                panel_headers(),
                Ok(Json(serde_json::from_value(bad.clone()).unwrap())),
            )
            .await;
            assert_eq!(created.status(), StatusCode::BAD_REQUEST, "create accepted {bad}");
            let updated = update_node(
                Admin,
                axum::extract::State(app.clone()),
                Path(id),
                Ok(Json(serde_json::from_value(bad.clone()).unwrap())),
            )
            .await;
            assert_eq!(updated.status(), StatusCode::BAD_REQUEST, "update accepted {bad}");
        }
        assert_eq!(app.db.nodes().unwrap().len(), 1, "nothing was created");
    }

    /// A length with a name is stored under it, so a client that knows the
    /// names still labels it.
    #[tokio::test]
    async fn currency_and_cycle_are_stored_in_one_spelling() {
        let app = std::sync::Arc::new(app());
        let id = node(&app, "n", true);
        for (sent, currency, cycle) in [
            (json!({"currency": " hkd ", "billing_cycle": "60m"}), "HKD", "60m"),
            (json!({"billing_cycle": "12m"}), "HKD", "yearly"),
            (json!({"billing_cycle": "once"}), "HKD", "once"),
        ] {
            let put = update_node(
                Admin,
                State(app.clone()),
                Path(id),
                Ok(Json(serde_json::from_value(sent).unwrap())),
            );
            assert_eq!(put.await.status(), StatusCode::OK);
            let stored = app.db.node(id).unwrap().unwrap();
            assert_eq!((stored.currency.as_str(), stored.billing_cycle.as_str()), (currency, cycle));
        }
    }

    /// A stream outlives the request that opened it, so everything the handshake
    /// tested must be re-read rather than captured -- both answers, not one. The
    /// admin frame carries every node's address and private notes, and the public frame
    /// is what switching the status page off is meant to withdraw; a socket
    /// surviving either decision would continue sending what was withdrawn.
    #[test]
    fn a_stream_re_reads_both_answers_its_handshake_tested() {
        let app = app();
        // A fresh hub publishes nothing; this test starts from the
        // published state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        let hash = sha256("live-token");
        app.db.create_session(&hash, Utc::now().timestamp() + 3_600).unwrap();

        assert_eq!(stream_audience(&app, Some(&hash)), Some(true), "a live session gets the admin frame");
        assert_eq!(stream_audience(&app, None), Some(false), "an anonymous stream gets the public one");

        // Signing out, another device revoking this one, a password change and a
        // restore all manifest as this row disappearing.
        app.db.drop_session(&hash).unwrap();
        assert_eq!(stream_audience(&app, Some(&hash)), None, "a revoked session must end its stream");

        // The other half. `live_ws` refuses a new anonymous connection from here
        // and `nodes` answers 401, so a stream that continued was the only
        // remaining route, for as long as the tab stayed open.
        app.db.create_session(&hash, Utc::now().timestamp() + 3_600).unwrap();
        app.db.set("public_page", "off").unwrap();
        assert_eq!(stream_audience(&app, None), None, "closing the status page must end anonymous streams");
        assert_eq!(stream_audience(&app, Some(&hash)), Some(true), "a signed-in operator still gets theirs");
    }

    #[tokio::test]
    async fn a_closed_status_page_and_a_sibling_origin_see_no_admin_data() {
        let app = std::sync::Arc::new(app());
        // A fresh hub publishes nothing; this test starts from the
        // published state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        app.db.create_session(&sha256("live-token"), Utc::now().timestamp() + 3_600).unwrap();
        let signed_in = |site: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::COOKIE, format!("{}=live-token", crate::auth::COOKIE).parse().unwrap());
            headers.insert("sec-fetch-site", site.parse().unwrap());
            headers
        };
        let operator = Some(Some(sha256("live-token")));
        assert_eq!(stream_viewer(&app, &signed_in("same-origin")), operator);
        assert_eq!(
            stream_viewer(&app, &signed_in("same-site")),
            Some(None),
            "a sibling's script is a visitor"
        );
        assert_eq!(stream_viewer(&app, &HeaderMap::new()), Some(None));

        app.db.set("public_page", "off").unwrap();
        assert_eq!(stream_viewer(&app, &signed_in("same-origin")), operator);
        assert_eq!(stream_viewer(&app, &signed_in("same-site")), None);
        assert_eq!(stream_viewer(&app, &HeaderMap::new()), None);
        assert_eq!(nodes(State(app.clone()), HeaderMap::new()).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(nodes(State(app), signed_in("same-origin")).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn only_the_admin_node_list_is_marked_no_transform() {
        let app = std::sync::Arc::new(app());
        // A fresh hub publishes nothing; this test starts from the
        // published state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        app.db.create_session(&sha256("live-token"), Utc::now().timestamp() + 3_600).unwrap();
        let mut signed_in = HeaderMap::new();
        signed_in.insert(header::COOKIE, format!("{}=live-token", crate::auth::COOKIE).parse().unwrap());
        let cache = |res: Response| res.headers().get(header::CACHE_CONTROL).cloned();
        assert_eq!(cache(nodes(State(app.clone()), signed_in).await).unwrap(), "no-store, no-transform");
        assert_eq!(cache(nodes(State(app), HeaderMap::new()).await), None, "the public list compresses");
    }

    /// The public list a browser asks for gzipped is the stream's compressed
    /// frame, the same bytes for every request until the frame expires.
    #[tokio::test]
    async fn the_public_node_list_reuses_the_compressed_frame() {
        let app = std::sync::Arc::new(app());
        // A fresh hub publishes nothing; this test starts from the
        // published state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        node(&app, "listed", true);
        let ask = |encoding: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, encoding.parse().unwrap());
            headers
        };
        let res = nodes(State(app.clone()), ask("br, gzip, deflate")).await;
        assert_eq!(res.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(res.headers()[header::VARY], "accept-encoding");
        let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        assert_eq!(body, live_gzip(&app), "the frame the streams send");

        for refused in ["identity", "gzip;q=0", "br", "*"] {
            let res = nodes(State(app.clone()), ask(refused)).await;
            assert!(res.headers().get(header::CONTENT_ENCODING).is_none(), "{refused}");
        }
        assert!(nodes(State(app.clone()), ask("GZIP; q=0.5"))
            .await
            .headers()
            .contains_key(header::CONTENT_ENCODING));

        // The admin list is never compressed, asked or not.
        app.db.create_session(&sha256("live-token"), Utc::now().timestamp() + 3_600).unwrap();
        let mut signed_in = ask("gzip");
        signed_in.insert(header::COOKIE, format!("{}=live-token", crate::auth::COOKIE).parse().unwrap());
        assert!(nodes(State(app), signed_in).await.headers().get(header::CONTENT_ENCODING).is_none());
    }

    #[test]
    fn the_shared_snapshot_keeps_the_two_audiences_apart() {
        let app = app();
        let open = node(&app, "open", true);
        node(&app, "hidden", false);
        app.db.save_facts(open, &json!({"hostname": "vps-1"}), "198.51.100.9", "").unwrap();

        let public = live_snapshot(&app, false);
        let admin = live_snapshot(&app, true);
        // Caching must never let one audience's payload reach the other.
        assert!(!public.as_str().contains("198.51.100.9"), "the public frame must carry no address");
        assert!(!public.as_str().contains("hidden"), "the public frame must carry no private node");
        assert!(admin.as_str().contains("198.51.100.9") && admin.as_str().contains("hidden"));

        // Two reads over unchanged data prove nothing, since a rebuild returns the
        // same bytes, so the data is modified first.
        node(&app, "late", true);
        assert_eq!(live_snapshot(&app, false), public, "the frame is reused, not rebuilt per viewer");

        let mut unpacked = String::new();
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&live_gzip(&app)[..]), &mut unpacked)
            .unwrap();
        assert_eq!(unpacked, public.as_str(), "the gzipped frame is the same frame");
        assert_eq!(live_gzip(&app).as_ptr(), live_gzip(&app).as_ptr(), "compressed once per frame");
    }

    /// The page draws its realtime trace on the hub's clock: the frame says
    /// when it was built, and a reused frame keeps saying the same.
    #[test]
    fn the_frame_says_when_it_was_built() {
        let app = app();
        node(&app, "open", true);

        let first: Value = serde_json::from_str(live_snapshot(&app, false).as_str()).unwrap();
        let at = first["at"].as_i64().expect("the frame carries the millisecond it was built");
        let now = Utc::now().timestamp_millis();
        assert!((now - at).abs() < 5_000, "stamped when it was built, not when it is read");
        assert_eq!(first["nodes"][0]["name"], "open", "and the frame is still the node list");

        // Reused inside the TTL: the same bytes, so the same moment.
        let held: Value = serde_json::from_str(live_snapshot(&app, false).as_str()).unwrap();
        assert_eq!(held["at"], json!(at), "a reused frame keeps the moment it was built");

        // A rebuild carries a later one. The stamp has millisecond resolution, so
        // the clock has to move before the second frame is built.
        std::thread::sleep(std::time::Duration::from_millis(3));
        app.snapshot.lock().unwrap()[0].at = 0;
        let rebuilt: Value = serde_json::from_str(live_snapshot(&app, false).as_str()).unwrap();
        assert!(rebuilt["at"].as_i64().unwrap() > at, "a rebuilt frame is stamped again");
    }

    #[test]
    fn a_clock_stepping_backwards_does_not_pin_a_stale_frame() {
        let app = app();
        node(&app, "first", true);
        live_snapshot(&app, false);

        // NTP correcting a fresh boot leaves the cached stamp in the future, which
        // does not constitute a young frame.
        app.snapshot.lock().unwrap()[0].at = Utc::now().timestamp_millis() + 60_000;
        node(&app, "added-after", true);
        assert!(live_snapshot(&app, false).as_str().contains("added-after"));
    }

    /// The panel sends only a name, and expects the node just added to appear in
    /// the frame it is already streaming.
    #[tokio::test]
    async fn a_node_added_from_the_panel_needs_only_a_name_and_shows_up_at_once() {
        let app = std::sync::Arc::new(app());
        node(&app, "existing", true);
        assert!(!live_snapshot(&app, true).as_str().contains("added"));

        let added: Node = serde_json::from_value(json!({"name": "added"})).unwrap();
        // The defaults the panel relies on by omitting them, `public` above all:
        // the alternative would publish a node that was never published.
        assert!(added.public);
        assert_eq!(added.billing_cycle, "monthly");
        assert_eq!(added.traffic_reset_day, 1);

        let created = create_node(Admin, State(app.clone()), panel_headers(), Ok(Json(added))).await;
        assert_eq!(created.status(), StatusCode::OK);
        // Frames are cached for nearly two seconds, so without dropping the cache
        // the node just added would disappear from the list.
        assert!(live_snapshot(&app, true).as_str().contains("added"));

        // A name consisting only of spaces is refused and leaves no node behind.
        let blank = Json(serde_json::from_value::<Node>(json!({"name": "   "})).unwrap());
        let refused = create_node(Admin, State(app.clone()), panel_headers(), Ok(blank)).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.nodes().unwrap().len(), 2);
    }

    /// Every gate on the anonymous route, in the order a batch install encounters
    /// them: closed, wrong key, open, expired, closed manually.
    #[tokio::test]
    async fn registration_only_works_inside_a_window_the_panel_opened() {
        let app = std::sync::Arc::new(app());
        let register = |key: Option<&str>, name: &str| {
            let mut headers = HeaderMap::new();
            if let Some(key) = key {
                headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
            }
            agent_register(
                State(app.clone()),
                ConnectInfo("198.51.100.7:40000".parse().unwrap()),
                headers,
                name.to_owned(),
            )
        };

        // Nothing was opened, so no key is correct.
        assert_eq!(register(Some("guess"), "a").await.status(), StatusCode::FORBIDDEN);
        assert!(app.db.nodes().unwrap().is_empty());

        assert_eq!(open_register(Admin, State(app.clone()), panel_headers()).await.status(), StatusCode::OK);
        let key = app.db.get("register_key").unwrap();
        assert!(register_left(&app) > REGISTER_WINDOW - 5, "the panel counts down from the full hour");
        assert_eq!(register(Some("guess"), "a").await.status(), StatusCode::FORBIDDEN);
        assert_eq!(register(None, "a").await.status(), StatusCode::FORBIDDEN);
        assert!(app.db.nodes().unwrap().is_empty());

        let issued = register(Some(&key), "  web-01\n").await;
        assert_eq!(issued.status(), StatusCode::OK);
        let token = axum::body::to_bytes(issued.into_body(), usize::MAX).await.unwrap().to_vec();
        let token = String::from_utf8(token).unwrap();
        // The purpose of the route: what returned is a token an agent can connect
        // with, not merely a 200.
        let id = app.db.node_by_token(&token).unwrap().expect("token opens a node");
        let node = app.db.nodes().unwrap().into_iter().find(|n| n.id == id).unwrap();
        assert_eq!(node.name, "web-01");
        // Registered nodes take the panel's defaults rather than `Node::default()`.
        assert!(node.public);
        assert_eq!(node.traffic_reset_day, 1);

        // An hour later the same key is worthless, which is what makes leaving the
        // window open harmless.
        app.db.set("register_until", &(Utc::now().timestamp() - 1).to_string()).unwrap();
        assert_eq!(register_left(&app), 0);
        assert_eq!(register(Some(&key), "b").await.status(), StatusCode::FORBIDDEN);

        // Reopened, then closed manually: the key from the open window stops
        // working.
        open_register(Admin, State(app.clone()), panel_headers()).await;
        let key = app.db.get("register_key").unwrap();
        assert_eq!(close_register(Admin, State(app.clone())).await.status(), StatusCode::NO_CONTENT);
        assert_eq!(register(Some(&key), "c").await.status(), StatusCode::FORBIDDEN);
        assert_eq!(app.db.nodes().unwrap().len(), 1);
    }

    /// A rerun of the batch command on a registered machine keeps its node, also
    /// after the window closed, until that node is deleted from the panel.
    #[tokio::test]
    async fn a_rerun_keeps_its_node_until_the_node_is_deleted() {
        let app = std::sync::Arc::new(app());
        let register = |key: &str, held: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
            // curl omits a header whose value is empty, so a machine holding no
            // token sends none.
            if !held.is_empty() {
                headers.insert(HELD_TOKEN, held.parse().unwrap());
            }
            agent_register(
                State(app.clone()),
                ConnectInfo("198.51.100.7:40000".parse().unwrap()),
                headers,
                "web-01".to_owned(),
            )
        };
        let text = |r: Response| async {
            String::from_utf8(axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec())
                .unwrap()
        };

        open_register(Admin, State(app.clone()), panel_headers()).await;
        let key = app.db.get("register_key").unwrap();
        let token = text(register(&key, "").await).await;
        let id = app.db.node_by_token(&token).unwrap().expect("token opens a node");

        assert_eq!(text(register(&key, &token).await).await, token);
        close_register(Admin, State(app.clone())).await;
        assert_eq!(text(register(&key, &token).await).await, token, "the token outlives its window");
        assert_eq!(app.db.nodes().unwrap().len(), 1);

        // Deleted: the held token no longer answers, so a closed window refuses
        // rather than handing back a token the agent would be refused with.
        app.db.delete_node(id).unwrap();
        assert_eq!(register(&key, &token).await.status(), StatusCode::FORBIDDEN);
        open_register(Admin, State(app.clone()), panel_headers()).await;
        let key = app.db.get("register_key").unwrap();
        let fresh = text(register(&key, &token).await).await;
        assert_ne!(fresh, token);
        assert!(app.db.node_by_token(&fresh).unwrap().is_some());
        assert_eq!(app.db.nodes().unwrap().len(), 1);
    }

    /// The name comes from an unvouched machine: markup characters are dropped,
    /// and what that leaves is trimmed. None at all, the machine's hostname
    /// withheld by `install.sh`, names the node after its id.
    #[tokio::test]
    async fn a_registered_name_loses_markup_and_is_never_blank() {
        let app = std::sync::Arc::new(app());
        open_register(Admin, State(app.clone()), panel_headers()).await;
        let key = app.db.get("register_key").unwrap();
        for (sent, stored) in
            [("", "节点 1"), ("< >", "节点 2"), ("<b>web</b>", "bweb/b"), ("Tom's \"VPS\"", "Toms VPS")]
        {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
            let reply = agent_register(
                State(app.clone()),
                ConnectInfo("198.51.100.7:40000".parse().unwrap()),
                headers,
                sent.to_owned(),
            )
            .await;
            let token = String::from_utf8(
                axum::body::to_bytes(reply.into_body(), usize::MAX).await.unwrap().to_vec(),
            )
            .unwrap();
            let id = app.db.node_by_token(&token).unwrap().expect("token opens a node");
            assert_eq!(app.db.node(id).unwrap().unwrap().name, stored, "sent {sent:?}");
        }
    }

    /// The ceiling on the anonymous route: a leaked key cannot fill the table.
    #[tokio::test]
    async fn one_window_stops_registering_at_the_limit() {
        let app = std::sync::Arc::new(app());
        open_register(Admin, State(app.clone()), panel_headers()).await;
        let key = app.db.get("register_key").unwrap();
        for i in 0..REGISTER_LIMIT {
            node(&app, &format!("n{i}"), true);
        }
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
        let refused = agent_register(
            State(app.clone()),
            ConnectInfo("198.51.100.7:40000".parse().unwrap()),
            headers,
            "one-too-many".to_owned(),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(app.db.nodes().unwrap().len() as i64, REGISTER_LIMIT);
    }

    #[test]
    fn a_node_view_carries_traffic_even_while_offline() {
        let app = app();
        let id = node(&app, "n", true);
        app.db.accumulate(id, "b", (100, 100), Local::now(), None).unwrap();
        app.db.accumulate(id, "b", (900, 500), Local::now(), None).unwrap();
        app.db.touch_seen(id, 1_700_000_000, &serde_json::Value::Null).unwrap();

        let view = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(view["online"], false);
        assert_eq!(view["metrics"], Value::Null);
        assert_eq!(view["total_rx"], 800, "traffic is stored, not derived from the live state");
        assert_eq!(view["total_tx"], 400);
        // The live entry went with the connection, so "offline since" must come
        // from the node row.
        assert_eq!(view["last_seen"], 1_700_000_000);
        let ago = view["last_seen_ago"].as_i64().unwrap();
        assert!((Utc::now().timestamp() - 1_700_000_000 - ago).abs() <= 1, "counted on the hub's clock");

        node(&app, "never", true);
        assert_eq!(visible_nodes(&app, true).unwrap()[1]["last_seen_ago"], Value::Null, "never seen");
    }

    /// The stored capacities trail the reports by up to a minute, and a disk is
    /// mounted on a running machine at any moment, which the agent detects by
    /// re-reading its mount table every sample. Drawn from the stored copy, the
    /// card and the detail page would show the same host two different sizes.
    #[test]
    fn a_capacity_that_changed_since_the_last_write_is_the_reported_one() {
        let app = app();
        let id = node(&app, "n", true);
        // What the last write stored: 30 GB of disk, 1 GB of swap.
        app.db
            .touch_seen(
                id,
                1,
                &json!({"mem_total": 1_000, "swap_total": 1i64 << 30, "disk_total": 30i64 << 30}),
            )
            .unwrap();

        let offline = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(
            offline["disk_total"],
            30i64 << 30,
            "with nobody connected the stored facts are all there is"
        );

        // A 5 GB volume is mounted and swap is disabled, before the next write.
        let _held = connect(
            &app,
            id,
            json!({"mem_total": 1_000, "swap_total": 0, "disk_total": 35i64 << 30, "cpu": 1.0}),
        );
        let live = &visible_nodes(&app, true).unwrap()[0];
        assert_eq!(live["disk_total"], 35i64 << 30, "the report is the truth while the agent is connected");
        assert_eq!(live["swap_total"], 0, "swapoff means zero, not the gigabyte that was there at connect");
        assert_eq!(live["disk_total"], live["metrics"]["disk_total"], "one number, not two");
        assert_eq!(app.db.node(id).unwrap().unwrap().disk_total, 30i64 << 30, "and no extra write to get it");
    }

    /// Only anonymous streams are counted, and a slot comes back when its
    /// stream ends. `PUBLIC_STREAM_GATE` is touched by no other test.
    #[test]
    fn anonymous_streams_past_the_gate_are_refused_and_a_session_is_not() {
        let held: Vec<_> = (0..PUBLIC_STREAMS).map(|_| stream_slot(None).expect("up to the limit")).collect();
        assert!(stream_slot(None).is_err(), "the stream past the limit must be refused");
        assert!(stream_slot(Some("hash")).is_ok(), "a session opens its stream with every slot taken");
        drop(held);
        assert!(stream_slot(None).is_ok(), "a finished stream gives its slot back");
    }

    /// `span` bounds one window; this bounds how many are built concurrently.
    /// Each holds the reader for its entire scan, and the path takes no
    /// credentials. `PASSWORD_GATE` refuses the same way; `RELAY_GATE` queues
    /// briefly instead, as a batch install is one burst of legitimate requests.
    #[tokio::test]
    async fn history_queries_past_the_gate_are_refused_rather_than_queued() {
        let _serial = HISTORY_TESTS.lock().await;
        let app = std::sync::Arc::new(app());
        // A fresh hub publishes nothing; this test starts from the
        // published state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        let id = node(&app, "n", true);
        let ask = || {
            metrics(
                State(app.clone()),
                HeaderMap::new(),
                Path(id),
                Query(Window { hours: 1, points: None, series: None }),
            )
        };

        let held: Vec<_> =
            (0..HISTORY_SLOTS).map(|_| HISTORY_GATE.try_acquire().expect("up to the limit")).collect();
        assert_eq!(ask().await.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(held);
        assert_eq!(ask().await.status(), StatusCode::OK, "a finished query gives its slot back");

        // An unauthorised caller is told so rather than asked to retry later: the
        // gate sits behind the visibility check deliberately.
        app.db.set("public_page", "off").unwrap();
        let held: Vec<_> =
            (0..HISTORY_SLOTS).map(|_| HISTORY_GATE.try_acquire().expect("up to the limit")).collect();
        assert_eq!(ask().await.status(), StatusCode::UNAUTHORIZED);
        drop(held);
    }

    /// A settings write lands whole or not at all. Changing the password drops
    /// every session and places the replacement cookie on the response, so a 400
    /// raised afterwards -- on a later key, in whatever order the map iterates --
    /// would sign the admin out of every device without explanation.
    #[tokio::test]
    async fn a_settings_write_is_all_or_nothing() {
        let _password = crate::auth::PASSWORD_TESTS.lock().await;
        let app = std::sync::Arc::new(app());
        let old = hash_password("the-old-password").unwrap();
        app.db.set("admin_password_hash", &old).unwrap();
        let save =
            |body: Value| save_settings(Admin, State(app.clone()), peer(), HeaderMap::new(), Json(body));

        // BTreeMap order places the password first, which is the failing case.
        let refused = save(json!({
            "admin_password": "a-long-enough-one",
            "current_password": "the-old-password",
            "retention_days": "abc",
        }))
        .await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.get("admin_password_hash").as_deref(), Some(old.as_str()));

        // A correctly named key carrying the wrong type is refused rather than
        // discarded while the response reports success.
        let refused = save(json!({"public_page": false})).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app.db.get("public_page"), None);

        let saved = save(json!({"public_page": "off", "retention_days": "7"})).await;
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(app.db.get("retention_days").as_deref(), Some("7"));
    }

    /// The install script and the sign-in page keep separate counters: five
    /// machines started with a stale key is a misconfigured deploy, and a shared
    /// counter would lock the operator out of the panel for the lockout window.
    #[tokio::test]
    async fn a_wrong_registration_key_does_not_lock_the_sign_in_page() {
        let app = std::sync::Arc::new(app());
        app.db.set("register_key", "the-key").unwrap();
        app.db.set("register_until", &(Utc::now().timestamp() + 60).to_string()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        let peer: std::net::SocketAddr = "198.51.100.7:9000".parse().unwrap();

        // The attempt after the last permitted one answers 429 rather than 403.
        for _ in 0..5 {
            let refused =
                agent_register(State(app.clone()), ConnectInfo(peer), headers.clone(), "n".into()).await;
            assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        }
        assert!(app.registrations.locked(peer.ip()), "the register route counts its own failures");
        assert!(!app.throttle.locked(peer.ip()), "and the panel's sign-in page is not one of them");
    }

    #[test]
    fn per_node_reads_follow_the_public_flag_and_the_public_page_switch() {
        let app = app();
        // A fresh hub publishes nothing; this test starts from the published
        // state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        let open = node(&app, "open", true);
        let hidden = node(&app, "hidden", false);

        assert!(readable(&app, false, open), "a published node is readable by anyone");
        assert!(!readable(&app, false, hidden), "a private node is not");
        assert!(!readable(&app, false, 9999), "an unknown id is not");
        assert!(readable(&app, true, hidden), "the panel sees a private node");

        // Switching the public page off closes even a published node.
        app.db.set("public_page", "off").unwrap();
        assert!(!readable(&app, false, open));
        assert!(readable(&app, true, open), "and never closes it for the panel");
    }

    /// The retention window is the ceiling for every caller: no width reads more
    /// than the week of minute rows, so wider windows need no separate bound for
    /// anonymous callers, and a window past what is kept would only draw
    /// history that is not there.
    #[tokio::test]
    async fn a_history_window_stops_at_the_retention_window() {
        let _serial = HISTORY_TESTS.lock().await;
        let app = std::sync::Arc::new(app());
        // A fresh hub publishes nothing; this test starts from the
        // published state it then narrows or closes.
        app.db.set("public_page", "on").unwrap();
        let id = node(&app, "n", true);
        let now = Utc::now().timestamp();
        // One sample per day for a month, so a row's presence identifies its
        // window. The minute of slack keeps day seven clear of the 168-hour cutoff:
        // exactly on the boundary, a second elapsing between these inserts and the
        // query below would drop it and leave the count one short.
        for day in 0..30 {
            app.db.insert_metric(id, now - day * 86_400 + 60, &json!({"cpu": 1.0})).unwrap();
        }
        let ask = |hours| {
            let query = format!("hours={hours}&series=metrics");
            let app = app.clone();
            async move {
                let answer = metrics(
                    State(app),
                    HeaderMap::new(),
                    Path(id),
                    Query(serde_urlencoded::from_str::<Window>(&query).unwrap()),
                )
                .await;
                axum::body::to_bytes(answer.into_body(), usize::MAX).await.unwrap()
            }
        };
        let rows =
            |body: &[u8]| serde_json::from_slice::<Value>(body).unwrap()["metrics"].as_array().unwrap().len();
        let step = |body: &[u8]| serde_json::from_slice::<Value>(body).unwrap()["step"].clone();

        // Before the first rollup nothing is folded, and a window past the week
        // reads the newest week of minute rows rather than every one.
        app.db.set("retention_days", "30").unwrap();
        assert_eq!(rows(&ask(720).await), 8, "unfolded minute rows past the week are not read");
        app.db.roll_up(now, 90).unwrap();

        app.db.set("retention_days", "7").unwrap();
        let week = ask(168).await;
        assert_eq!(rows(&week), 8, "a week reaches back seven days");
        assert_eq!(step(&week), 420, "in seven-minute points, a week of minutes at the 1,440-point budget");
        assert_eq!(ask(2_160).await, week, "a window past the retention window is narrowed to it");

        // Past the week, from the hourly tier and the minute rows after it.
        app.db.set("retention_days", "30").unwrap();
        let month = ask(2_160).await;
        assert_eq!(rows(&month), 30, "a month reaches back thirty days");
        assert_eq!(step(&month), 3_600, "in whole hours, as no hourly row may straddle two points");
    }

    #[tokio::test]
    async fn changing_the_password_kills_other_sessions_but_not_the_caller() {
        let app = std::sync::Arc::new(app());
        let stale = random_token();
        app.db.create_session(&sha256(&stale), Utc::now().timestamp() + 3_600).unwrap();

        // No password is stored yet, so this is the first one: there is nothing
        // to confirm it against and the change stands on the session alone.
        let body = Json(json!({"admin_password": "a-long-enough-password"}));
        let response =
            save_settings(Admin, axum::extract::State(app.clone()), peer(), HeaderMap::new(), body).await;

        assert!(!app.db.session_valid(&sha256(&stale)), "sessions must not outlive the old password");

        // The caller receives a replacement rather than being logged out by its
        // own password change.
        let cookie = response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .expect("a replacement session")
            .to_str()
            .unwrap();
        let token = cookie.split(';').next().unwrap().split('=').nth(1).unwrap();
        assert!(app.db.session_valid(&sha256(token)), "the replacement session must work");
    }

    /// The password is the second way into the account, so replacing it asks for
    /// the one being replaced. Without that, a stolen session is enough to lock
    /// the owner out of their own hub and keep it.
    #[tokio::test]
    async fn replacing_an_existing_password_asks_for_the_current_one() {
        let _password = crate::auth::PASSWORD_TESTS.lock().await;
        let app = std::sync::Arc::new(app());
        let old = hash_password("the-old-password").unwrap();
        app.db.set("admin_password_hash", &old).unwrap();
        let put =
            |body: Value| save_settings(Admin, State(app.clone()), peer(), HeaderMap::new(), Json(body));
        let stored = || app.db.get("admin_password_hash");

        let refused = put(json!({"admin_password": "a-long-enough-password"})).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN, "no current password given");
        assert_eq!(stored().as_deref(), Some(old.as_str()), "a refused change must leave the old one");

        let refused =
            put(json!({"admin_password": "a-long-enough-password", "current_password": "wrong"})).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(stored().as_deref(), Some(old.as_str()));

        // The current password travels beside the new one and is not itself a
        // setting: the write below must not report it as an unknown key.
        let changed =
            put(json!({"admin_password": "a-long-enough-password", "current_password": "the-old-password"}))
                .await;
        assert_eq!(changed.status(), StatusCode::OK);
        assert_ne!(stored().as_deref(), Some(old.as_str()), "the replacement is stored");
    }

    /// The password a new hub prints is not one the operator chose, and may
    /// never have been read. It can be replaced without being produced; what the
    /// operator picks is theirs, and every change after that asks for it.
    #[tokio::test]
    async fn a_generated_password_can_be_replaced_without_being_produced() {
        let _password = crate::auth::PASSWORD_TESTS.lock().await;
        let app = std::sync::Arc::new(app());
        app.db.set("admin_password_hash", &hash_password("a-printed-one").unwrap()).unwrap();
        app.db.set("password_generated", "on").unwrap();
        let put =
            |body: Value| save_settings(Admin, State(app.clone()), peer(), HeaderMap::new(), Json(body));

        assert_eq!(put(json!({"admin_password": "a-password-of-my-own"})).await.status(), StatusCode::OK);
        assert_eq!(app.db.get("password_generated").as_deref(), Some("off"), "the mark is cleared");

        // It is the operator's own now, so a second change is asked for it.
        assert_eq!(
            put(json!({"admin_password": "a-third-long-password"})).await.status(),
            StatusCode::FORBIDDEN
        );
    }

    /// The panel hides the delete button on the caller's own row, so the mark is
    /// all that prevents an admin from signing themselves out.
    #[tokio::test]
    async fn the_session_list_marks_the_caller_and_hides_expired_rows() {
        let app = std::sync::Arc::new(app());
        let (mine, theirs, stale) = (random_token(), random_token(), random_token());
        let now = Utc::now().timestamp();
        app.db.create_session(&sha256(&mine), now + 3_600).unwrap();
        app.db.create_session(&sha256(&theirs), now + 7_200).unwrap();
        app.db.create_session(&sha256(&stale), now - 1).unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("monitor_session={mine}").parse().unwrap());
        let body = axum::body::to_bytes(
            sessions(Admin, axum::extract::State(app.clone()), headers).await.into_body(),
            usize::MAX,
        )
        .await
        .unwrap();
        let rows: Vec<Value> = serde_json::from_slice(&body).unwrap();

        assert_eq!(rows.len(), 2, "an expired session is not a session");
        assert_eq!(rows[0]["id"], sha256(&theirs), "newest first");
        assert_eq!(rows[0]["current"], false);
        assert_eq!(rows[1]["id"], sha256(&mine));
        assert_eq!(rows[1]["current"], true, "the caller's own row must be marked");
        assert_eq!(rows[1]["created_at"].as_i64().unwrap(), now + 3_600 - 14 * 86_400);

        delete_session(Admin, axum::extract::State(app.clone()), Path(sha256(&theirs))).await;
        assert!(!app.db.session_valid(&sha256(&theirs)), "the deleted device is signed out");
        assert!(app.db.session_valid(&sha256(&mine)), "and nobody else is");
    }

    #[tokio::test]
    async fn a_short_password_is_refused_and_changes_nothing() {
        let app = std::sync::Arc::new(app());
        let live = random_token();
        app.db.create_session(&sha256(&live), Utc::now().timestamp() + 3_600).unwrap();

        let body = Json(json!({"admin_password": "short"}));
        let response =
            save_settings(Admin, axum::extract::State(app.clone()), peer(), HeaderMap::new(), body).await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app.db.get("admin_password_hash").is_none(), "the password must not have changed");
        assert!(app.db.session_valid(&sha256(&live)), "a rejected change must not log anyone out");
    }

    /// Housekeeping clamps whatever it finds, so an unparsable value is not an
    /// error downstream: it silently means the default, in a field still
    /// displaying what was entered.
    #[tokio::test]
    async fn a_retention_window_that_would_never_apply_is_refused() {
        let app = std::sync::Arc::new(app());
        let put = |v: &str| {
            save_settings(
                Admin,
                State(app.clone()),
                peer(),
                HeaderMap::new(),
                Json(json!({"retention_days": v.to_owned()})),
            )
        };
        for junk in ["", "abc", "0", "-1", "9999"] {
            assert_eq!(put(junk).await.status(), StatusCode::BAD_REQUEST, "{junk:?}");
        }
        assert!(app.db.get("retention_days").is_none(), "a refused window must not be stored");
        assert_eq!(put("7").await.status(), StatusCode::OK);
        assert_eq!(app.db.get("retention_days").as_deref(), Some("7"));
    }

    /// What `settings` returns must be what `save_settings` accepts. The panel
    /// echoes the whole form back and the write is all-or-nothing, so one key
    /// returned in a form the write refuses fails the entire page, naming a field
    /// that was never edited.
    #[tokio::test]
    async fn a_fresh_hub_answers_settings_that_it_will_take_back() {
        let app = std::sync::Arc::new(app());
        let Json(read) = settings(Admin, State(app.clone()), peer(), HeaderMap::new()).await;
        assert_eq!(read["retention_days"], "30", "the default belongs in the answer, not in each caller");
        assert_eq!(read["your_address"], "198.51.100.7");

        // Exactly what the panel sends, on a hub where nothing was ever set.
        let echoed = json!({
            "site_name": read["site_name"],
            "retention_days": read["retention_days"],
            "github_proxy": read["github_proxy"],
            "public_page": "on",
            "notify_grace": read["notify_grace"],
            "notify_traffic": read["notify_traffic"],
            "notify_expiry": read["notify_expiry"],
            "notify_login": read["notify_login"],
            "notify_telegram_chat": read["notify_telegram_chat"],
            "notify_telegram_text": read["notify_telegram_text"],
            "notify_webhook_body": read["notify_webhook_body"],
        });
        assert_eq!(
            save_settings(Admin, State(app.clone()), peer(), HeaderMap::new(), Json(echoed)).await.status(),
            StatusCode::OK,
            "a fresh hub's own settings must survive a round trip"
        );
        assert_eq!(app.db.retention_days(), 30, "and the stored window is the one that was shown");
    }

    /// The switch has to show what the hub does. Reading back the stored row
    /// answers "" for a hub that never wrote it, and both directions went wrong
    /// from there: the panel, which treated "not off" as on, drew an open switch
    /// over a closed page, and saving the form -- which sends every field --
    /// wrote that "on" down, publishing a page nobody asked to publish.
    #[tokio::test]
    async fn the_public_page_switch_reports_what_the_hub_does() {
        let app = std::sync::Arc::new(app());
        let Json(fresh) = settings(Admin, State(app.clone()), peer(), HeaderMap::new()).await;
        assert_eq!(fresh["public_page"], "off", "a hub that never wrote the key serves closed");

        app.db.set("public_page", "on").unwrap();
        let Json(opened) = settings(Admin, State(app.clone()), peer(), HeaderMap::new()).await;
        assert_eq!(opened["public_page"], "on");

        // Anything that is not "on" closes it, and the answer says so rather than
        // handing back a value whose meaning the caller has to work out.
        app.db.set("public_page", "").unwrap();
        let Json(cleared) = settings(Admin, State(app), peer(), HeaderMap::new()).await;
        assert_eq!(cleared["public_page"], "off");
    }

    #[tokio::test]
    async fn settings_never_hand_back_a_secret() {
        let app = app();
        app.db.set("github_client_secret", "super-secret").unwrap();
        app.db.set("github_client_id", "public-id").unwrap();
        app.db.set("notify_telegram_token", "123:bot-secret").unwrap();
        app.db.set("notify_webhook_url", "https://hooks.example/url-secret").unwrap();
        app.db.set("notify_webhook_headers", "Authorization: header-secret").unwrap();

        let Json(body) =
            settings(Admin, axum::extract::State(std::sync::Arc::new(app)), peer(), HeaderMap::new()).await;
        assert_eq!(body["github_client_id"], "public-id");
        assert_eq!(body["github_secret_set"], true);
        assert_eq!(body["notify_webhook_url_set"], true);
        assert!(body.get("github_client_secret").is_none());
        for secret in ["super-secret", "bot-secret", "url-secret", "header-secret"] {
            assert!(!body.to_string().contains(secret), "{secret}");
        }
    }

    /// The issuer is where `/.well-known/openid-configuration` is appended to, so
    /// what it accepts is the shape of a base URL -- with the path Authentik
    /// needs, and without the query or fragment that append would swallow.
    #[test]
    fn an_issuer_is_accepted_only_when_discovery_can_be_appended_to_it() {
        for ok in [
            "",
            "https://id.example.com",
            "https://host/application/o/monitor/",
            // Plain http only where the traffic cannot leave the machine or the
            // operator's own network: that is what the token exchange carries.
            "http://127.0.0.1:1411",
            "http://localhost:1411",
            "http://[::1]:1411",
            "http://192.168.1.9:1411",
            "http://10.0.0.2:1411",
            "http://172.16.4.2:1411",
            "http://[fd00::1]:1411",
        ] {
            assert_eq!(setting_error("oidc_issuer", &json!(ok)), None, "{ok}");
        }
        for bad in [
            "id.example.com",
            "//id.example.com",
            "ftp://id.example.com",
            "https://id.example.com/?tenant=1",
            "https://id.example.com/#issuer",
            // A public address in the clear: the code, the verifier, the secret
            // and the bearer token would all cross the internet readable.
            "http://id.example.com",
            "http://198.51.100.7:1411",
            // A name is not evidence of locality, so it does not unlock http.
            "http://id.internal:1411",
            // What is left of the address once the paired suffix is stripped is
            // not a base URL either, so the discovery URL does not rescue it.
            "https:///.well-known/openid-configuration",
        ] {
            assert!(setting_error("oidc_issuer", &json!(bad)).is_some(), "{bad}");
        }
        // The discovery URL every provider hands its operator is stored as the
        // base it names rather than refused: the hub appends that suffix itself,
        // and appending it to a pasted one asks for a path nobody serves.
        assert_eq!(setting_error("oidc_issuer", &json!(POCKET_ID_DISCOVERY)), None);
        assert_eq!(issuer_address(POCKET_ID_DISCOVERY), "https://id.example.com");
    }

    /// The address Pocket-ID shows as its own discovery URL -- the value a
    /// reader copies into the Issuer field, and the one that produced a 404.
    const POCKET_ID_DISCOVERY: &str = "https://id.example.com/.well-known/openid-configuration";

    /// The Issuer field is a base URL, so the finished discovery URL an operator
    /// copies out of their identity system names the same issuer once the suffix
    /// it repeats is gone. Every spelling of that suffix is one the hub would
    /// otherwise append its own copy to, and a tenant path in front is kept.
    #[test]
    fn the_discovery_url_a_reader_pastes_is_stored_as_the_issuer_it_names() {
        for (pasted, stored) in [
            ("https://id.example.com", "https://id.example.com"),
            (POCKET_ID_DISCOVERY, "https://id.example.com"),
            ("https://id.example.com/", "https://id.example.com"),
            ("https://id.example.com/.well-known/openid-configuration/", "https://id.example.com"),
            // What a provider writes without the `.well-known` segment, and the
            // spellings a hand-typed address arrives in.
            ("https://id.example.com/openid-configuration", "https://id.example.com"),
            (" https://id.example.com/.well-known/OpenID-Configuration ", "https://id.example.com"),
            // A tenant path lives in the issuer rather than in the suffix, so
            // stripping the one must not touch the other.
            (
                "https://id.example.com/realms/monitor/.well-known/openid-configuration",
                "https://id.example.com/realms/monitor",
            ),
            // Nothing to strip: a path that merely ends in the same word is the
            // operator's own and stays as typed.
            (
                "https://id.example.com/my-openid-configuration",
                "https://id.example.com/my-openid-configuration",
            ),
            ("", ""),
        ] {
            assert_eq!(issuer_address(pasted), stored, "{pasted}");
        }
    }

    /// The wiring rather than the rule: what the panel saves is what the next
    /// discovery fetch appends to, so a pasted discovery URL must reach the
    /// store already shortened -- and a valid one must not be refused on the way
    /// in for what stripping it leaves.
    #[tokio::test]
    async fn a_pasted_discovery_url_is_saved_as_the_issuer() {
        let app = std::sync::Arc::new(app());
        let put =
            |body: Value| save_settings(Admin, State(app.clone()), peer(), HeaderMap::new(), Json(body));

        assert_eq!(put(json!({"oidc_issuer": POCKET_ID_DISCOVERY})).await.status(), StatusCode::OK);
        assert_eq!(app.db.get("oidc_issuer").as_deref(), Some("https://id.example.com"));

        // Saving the field again without touching it keeps the stored spelling,
        // which is what the panel shows and echoes back.
        assert_eq!(put(json!({"oidc_issuer": "https://id.example.com"})).await.status(), StatusCode::OK);
        assert_eq!(app.db.get("oidc_issuer").as_deref(), Some("https://id.example.com"));
    }

    /// The label sits inside a button, so it is measured in characters rather
    /// than bytes: sixteen of either language is the whole of the room.
    #[test]
    fn the_oidc_button_label_fits_in_a_button() {
        assert_eq!(setting_error("oidc_provider_name", &json!("Pocket ID")), None);
        assert_eq!(setting_error("oidc_provider_name", &json!("一二三四五六七八九十一二三四五六")), None);
        assert!(
            setting_error("oidc_provider_name", &json!("一二三四五六七八九十一二三四五六七")).is_some(),
            "seventeen characters must be refused"
        );
    }

    /// Bindings are stored as `name:sub` pairs, so a colon in a listed name would
    /// be read as the start of a `sub`: the account would sign in once, bind
    /// under a mangled name, and never match again. Refused where it is typed.
    #[test]
    fn an_oidc_name_the_binding_list_cannot_hold_is_refused() {
        assert_eq!(setting_error("oidc_allowed_users", &json!("")), None);
        assert_eq!(setting_error("oidc_allowed_users", &json!("alice, bob,")), None);
        assert_eq!(setting_error("oidc_allowed_users", &json!("alice@example.com")), None);
        let refused = setting_error("oidc_allowed_users", &json!("alice,bob:sub-1"));
        assert!(refused.as_ref().is_some_and(|e| e.contains("冒号")), "{refused:?}");
    }

    /// The OIDC secret is write-only like GitHub's, and optional: a public client
    /// with PKCE has none, so the panel must be able to save an empty one.
    #[tokio::test]
    async fn the_oidc_secret_is_reported_as_set_and_never_handed_back() {
        let app = app();
        app.db.set("oidc_issuer", "https://id.example.com").unwrap();
        app.db.set("oidc_client_id", "monitor").unwrap();
        app.db.set("oidc_client_secret", "oidc-super-secret").unwrap();
        app.db.set("oidc_allowed_users", "alice").unwrap();
        app.db.set("oidc_provider_name", "Pocket ID").unwrap();

        let Json(body) =
            settings(Admin, axum::extract::State(std::sync::Arc::new(app)), peer(), HeaderMap::new()).await;
        assert_eq!(body["oidc_issuer"], "https://id.example.com");
        assert_eq!(body["oidc_client_id"], "monitor");
        assert_eq!(body["oidc_allowed_users"], "alice");
        assert_eq!(body["oidc_provider_name"], "Pocket ID");
        assert_eq!(body["oidc_secret_set"], true);
        assert!(body.get("oidc_client_secret").is_none());
        assert!(!body.to_string().contains("oidc-super-secret"));
        // Empty is a valid value for this key, and travels to the store as such.
        assert_eq!(setting_error("oidc_client_secret", &json!("")), None);
    }

    /// The hub's own address, as typed in the panel: a bare host, optionally
    /// with a port, and always https by the time it is stored.
    #[test]
    fn a_site_address_is_a_bare_https_domain() {
        for ok in [
            "",
            " ",
            "hub.example.com",
            "hub.example.com/",
            "https://hub.example.com/",
            "hub.example.com:8443",
        ] {
            assert_eq!(setting_error("site_url", &json!(ok)), None, "{ok}");
        }
        // Normalised to one spelling, so the value can be prefixed to a path.
        assert_eq!(http_address(""), "");
        assert_eq!(http_address("hub.example.com"), "https://hub.example.com");
        assert_eq!(http_address(" https://hub.example.com/ "), "https://hub.example.com");
        assert_eq!(http_address("hub.example.com:8443"), "https://hub.example.com:8443");

        for bad in [
            // Plaintext is the one thing this value may never be: the sign-in it
            // exists for carries the authorization code and the session cookie.
            "http://hub.example.com",
            // An IP names no host a certificate can match, and a path would be
            // swallowed when `/api/...` is appended.
            "198.51.100.7",
            "hub.example.com/panel",
            "hub.example.com?x=1",
            "hub.example.com#top",
            // The hub's own machine is what `--site` is for; the setting exists
            // to name the public address.
            "localhost",
            "localhost:8443",
        ] {
            assert!(setting_error("site_url", &json!(bad)).is_some(), "{bad}");
        }
    }

    /// What every error response is held to: text written for the reader passes
    /// as it is, and nothing else -- a library's error, axum's rejection wording
    /// -- reaches the body.
    #[tokio::test]
    async fn only_written_text_reaches_an_error_response() {
        let read = |r: Response| async move {
            let r = plain_errors(r).await;
            let body = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
            String::from_utf8(body.to_vec()).unwrap()
        };
        let raw = || std::io::Error::other("/opt/probe/data/probe.db: disk I/O error");

        let internal = fail(raw());
        assert_eq!(internal.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(read(internal).await, INTERNAL);

        // The shown message, wherever it sits in the chain, and never its cause.
        let wrapped =
            anyhow::Error::from(raw()).context(crate::Shown("数据库读不出来".into())).context("installing");
        let refused = fail(wrapped);
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(read(refused).await, "数据库读不出来");

        let rejection =
            (StatusCode::UNPROCESSABLE_ENTITY, "Failed to deserialize the JSON body").into_response();
        assert_eq!(read(rejection).await, "请求格式不对");
        assert_eq!(read(StatusCode::UNAUTHORIZED.into_response()).await, "登录已失效，请重新登录");
        assert_eq!(read(bad("请填写节点名称")).await, "请填写节点名称");
    }
}
