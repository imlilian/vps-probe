//! Sessions, the local emergency password, and single sign-on.
//!
//! Two single sign-on paths sit beside the password and never replace it: GitHub
//! for the common case, and a standard OIDC provider (Pocket-ID, Authentik,
//! Authelia, Keycloak) for a self-hosted identity system. Each hides its button
//! when its settings are empty, so a wrong or unreachable provider costs its own
//! button and nothing else. The local password exists so that a broken OAuth app
//! or an unreachable provider cannot lock the owner out.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::api::{answer, fail};
use crate::{App, Shown};

pub const COOKIE: &str = "monitor_session";
const STATE_COOKIE: &str = "monitor_oauth_state";
/// The OIDC flow keeps its own pair rather than sharing the one above: a browser
/// that starts GitHub sign-in and then OIDC would overwrite the first flow's
/// state, killing a sign-in it had already begun.
const OIDC_STATE_COOKIE: &str = "monitor_oidc_state";
const OIDC_VERIFIER_COOKIE: &str = "monitor_oidc_verifier";
const SESSION_DAYS: i64 = 14;
/// Failed password attempts allowed per address before it is shut out.
const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(900);

/// How many password checks may run concurrently.
///
/// argon2 is deliberately expensive: one attempt costs 19 MiB and a tenth of a
/// core-second. Unbounded, that cost becomes a lever rather than a defence --
/// the lockout below bounds attempts per address, but nothing bounds the number
/// of addresses, which on IPv6 is a /64 the caller already controls.
///
/// Fixed at one: any limit at or above what the machine can run concurrently is
/// no limit at all. argon2 saturates a core, so a gate of four on a three-core
/// hub never reached four in flight and admitted a flood untouched -- 570 MB
/// against a unit file allowing 256. At one, 633 of 640 attempts are refused.
/// Deriving it from the core count would reopen the hole on smaller machines.
///
/// Refused rather than queued: a queue admits the same flood, merely later. The
/// cost is that two simultaneous sign-ins require one to retry.
const PASSWORD_CHECKS: usize = 1;
static PASSWORD_GATE: Semaphore = Semaphore::const_new(PASSWORD_CHECKS);

/// Serialises every test that passes through [`PASSWORD_GATE`]. The gate is
/// process-wide, so a test holding its only permit would refuse a parallel
/// sign-in or confirmation with a 429 the test never asked about.
#[cfg(test)]
pub(crate) static PASSWORD_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// How many OIDC token exchanges may be in flight at once.
///
/// The callback is anonymous, and one that carries a matching state and verifier
/// makes the hub open two connections to the provider: the caller obtains those
/// cookies by starting the flow itself, so nothing but a ceiling bounds how many
/// exchanges it can ask for. Without one, a script turns the hub into a relay
/// pointed at whatever provider it is configured with -- and a provider that
/// answers that by blocking the hub has taken the sign-in path down.
///
/// Two rather than one, unlike the password gate: this work is two I/O waits,
/// not 19 MiB of argon2, and a phone and a laptop signing in together is a real
/// pair. Refused rather than queued, for the reason the password gate refuses.
const OIDC_EXCHANGES: usize = 2;
static OIDC_GATE: Semaphore = Semaphore::const_new(OIDC_EXCHANGES);

pub fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn random_token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

pub fn hash_password(password: &str) -> Result<String> {
    let salt =
        SaltString::encode_b64(&rand::random::<[u8; 16]>()).map_err(|e| anyhow::anyhow!("salt: {e}"))?;
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash password: {e}"))?
        .to_string())
}

fn verify_password(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// The password itself, asked for again on a request that can empty the hub: a
/// restore replaces every node, setting and session, and a password change
/// signs the owner out of every device.
///
/// A session cookie says a browser signed in within the last fourteen days. It
/// says nothing about who is holding that browser now, which is the whole gap
/// this closes. Failures count against the sign-in page's throttle rather than
/// a counter of their own, so a stolen session is not an unlimited oracle for
/// guessing the password it was supposed to be guarded by.
///
/// Forbidden rather than unauthorized on a wrong password: the panel treats a
/// 401 as "the session died" and sends the reader to the sign-in page, which is
/// the one thing this must not do.
///
/// `None` when the password is right, else the refusal to return as it stands.
pub fn confirm_password(app: &App, ip: IpAddr, password: &str) -> Option<Response> {
    if app.throttle.locked(ip) {
        return Some(answer(StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，稍后再试"));
    }
    // Held across the check, as on the sign-in page: argon2 costs 19 MiB and a
    // tenth of a core-second an attempt, so the number in flight must be bounded.
    let Ok(_permit) = PASSWORD_GATE.try_acquire() else {
        return Some(answer(StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，稍后再试"));
    };
    let Some(stored) = app.db.get("admin_password_hash") else {
        return Some(answer(
            StatusCode::FORBIDDEN,
            "还没有设置应急密码。这一步要先在「设置」的「应急密码」里设置一个，再用它确认",
        ));
    };
    if !verify_password(password, &stored) {
        app.throttle.record_failure(ip);
        return Some(answer(StatusCode::FORBIDDEN, "密码错误"));
    }
    app.throttle.clear(ip);
    None
}

/// Per-address failure counter. The hub keeps two: one for the sign-in page,
/// one for agent registration (`App::registrations`).
pub struct Throttle {
    seen: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    /// How long a failure is remembered. A field rather than the constant so
    /// tests can observe a lockout expire without sleeping for 15 minutes.
    window: Duration,
}

impl Default for Throttle {
    fn default() -> Self {
        Self { seen: Mutex::default(), window: LOCKOUT }
    }
}

impl Throttle {
    /// An IPv6 visitor holds a whole /64, so the full address as key would be a
    /// fresh bucket per attempt.
    fn key(ip: IpAddr) -> IpAddr {
        match ip {
            IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & (!0u128 << 64)).into()),
            v4 => v4,
        }
    }

    pub(crate) fn locked(&self, ip: IpAddr) -> bool {
        let ip = Self::key(ip);
        let mut map = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&ip) {
            Some((n, since)) if since.elapsed() < self.window => *n >= MAX_ATTEMPTS,
            Some(_) => {
                map.remove(&ip);
                false
            }
            None => false,
        }
    }

    pub(crate) fn record_failure(&self, ip: IpAddr) {
        let ip = Self::key(ip);
        let mut map = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        // Addresses past their window are dropped here rather than allowed to
        // accumulate, which also restarts the count for a returning address.
        map.retain(|_, (_, since)| since.elapsed() < self.window);
        map.entry(ip).or_insert((0, Instant::now())).0 += 1;
    }

    pub(crate) fn clear(&self, ip: IpAddr) {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).remove(&Self::key(ip));
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

/// True when the request carries a live session cookie.
pub fn authed(app: &App, headers: &HeaderMap) -> bool {
    cookie_value(headers, COOKIE).is_some_and(|token| app.db.session_valid(&sha256(&token)))
}

fn set_cookie(name: &str, value: &str, max_age: i64, secure: bool) -> String {
    let mut cookie = format!("{name}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Digest of the caller's own session, so a session list can mark it.
pub fn current_session(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, COOKIE).map(|token| sha256(&token))
}

/// When a session with this expiry was issued. `issue_session` sets the expiry
/// to the issue time plus `SESSION_DAYS`, so this is exact rather than an
/// estimate; the two move together.
pub fn issued_at(expires_at: i64) -> i64 {
    expires_at - SESSION_DAYS * 86_400
}

/// The request's headers decide the Secure flag when the hub has no `--site`;
/// see `App::secure_cookies`.
pub fn issue_session(app: &App, headers: &HeaderMap) -> Result<String> {
    let token = random_token();
    app.db.create_session(&sha256(&token), Utc::now().timestamp() + SESSION_DAYS * 86_400)?;
    Ok(set_cookie(COOKIE, &token, SESSION_DAYS * 86_400, app.secure_cookies(headers)))
}

#[derive(Deserialize)]
pub struct LoginBody {
    password: String,
}

pub async fn login(
    State(app): State<crate::Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    let ip = client_ip(&app, &headers, peer.ip());
    if app.throttle.locked(ip) {
        return answer(StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，稍后再试");
    }
    // Held across the check below, which is its purpose.
    let Ok(_permit) = PASSWORD_GATE.try_acquire() else {
        return answer(StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，稍后再试");
    };
    let Some(stored) = app.db.get("admin_password_hash") else {
        return answer(StatusCode::FORBIDDEN, "没有设置应急密码，无法用密码登录");
    };
    if !verify_password(&body.password, &stored) {
        app.throttle.record_failure(ip);
        return answer(StatusCode::UNAUTHORIZED, "密码错误");
    }
    app.throttle.clear(ip);
    match issue_session(&app, &headers) {
        Ok(cookie) => {
            crate::notify::signed_in(&app, "应急密码", ip);
            with_cookies(Json(serde_json::json!({"ok": true})), [cookie])
        }
        Err(e) => fail(e),
    }
}

pub async fn logout(State(app): State<crate::Shared>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_value(&headers, COOKIE) {
        let _ = app.db.drop_session(&sha256(&token));
    }
    with_cookies(
        Json(serde_json::json!({"ok": true})),
        [set_cookie(COOKIE, "", 0, app.secure_cookies(&headers))],
    )
}

/// Step one of the OAuth exchange: issue a state nonce and redirect the browser
/// to GitHub. The nonce returns in step two and must match.
pub async fn github_start(State(app): State<crate::Shared>, headers: HeaderMap) -> Response {
    let Some(client_id) = app.db.get("github_client_id").filter(|v| !v.is_empty()) else {
        return answer(StatusCode::PRECONDITION_FAILED, "没有配置 GitHub 登录");
    };
    let state = random_token();
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={client_id}&scope=read:user&state={state}"
    );
    with_cookies(Redirect::to(&url), [set_cookie(STATE_COOKIE, &state, 600, app.secure_cookies(&headers))])
}

/// Every field is optional. With required fields axum would reject a malformed
/// callback before the handler runs, returning a bare 400 and logging nothing;
/// GitHub also reports a refusal with `error` and no `code`.
#[derive(Deserialize, Default)]
pub struct Callback {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

pub async fn github_callback(
    State(app): State<crate::Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Response {
    // GitHub reports a refusal in the query string rather than the body.
    if let Some(error) = &query.error {
        let reason = query.error_description.as_deref().unwrap_or(error);
        let shown = if error == "access_denied" {
            "在 GitHub 上取消了授权"
        } else {
            "GitHub 拒绝了这次登录，原因见 hub 日志"
        };
        return sign_in_failed(
            &app,
            &headers,
            // Quoted: anyone can send this query string, and a newline in it
            // would print a line of their own into the hub's log.
            anyhow!("GitHub returned {error:?}: {reason:?}").context(Shown(shown.into())),
        );
    }
    // Reject a callback the browser did not initiate.
    let state = query.state.as_deref().unwrap_or_default();
    if state.is_empty() || cookie_value(&headers, STATE_COOKIE).as_deref() != Some(state) {
        return sign_in_failed(&app, &headers, anyhow!(Shown("登录已过期，请从登录页重新开始".into())));
    }
    let Some(code) = query.code.as_deref().filter(|c| !c.is_empty()) else {
        return sign_in_failed(&app, &headers, anyhow!(Shown("GitHub 没有返回授权码，请重新登录".into())));
    };
    let user = match github_login(&app, code).await {
        Ok(user) => user,
        Err(e) => return sign_in_failed(&app, &headers, e),
    };
    let session = match issue_session(&app, &headers) {
        Ok(cookie) => cookie,
        Err(e) => return sign_in_failed(&app, &headers, e),
    };
    crate::notify::signed_in(&app, &format!("GitHub {user}"), client_ip(&app, &headers, peer.ip()));
    with_cookies(Redirect::to("/admin/nodes"), [clear_state(&app, &headers), session])
}

/// Redirects the browser back to the sign-in page with the reason, rather than
/// leaving a bare 401 at a callback URL offering no way forward. The reason is
/// the error's [`Shown`] message, the same rule `api::fail` applies.
fn sign_in_failed(app: &App, headers: &HeaderMap, e: anyhow::Error) -> Response {
    // A rejected sign-in must leave a server-side record; the browser sees only
    // the redirect.
    warn!("GitHub sign-in rejected: {e:#}");
    let reason = e.downcast_ref::<Shown>().map_or(crate::api::INTERNAL, |shown| shown.0.as_str());
    let target = format!("/admin/nodes?login_error={}", urlencode(reason));
    with_cookies(Redirect::to(&target), [clear_state(app, headers), String::new()])
}

fn clear_state(app: &App, headers: &HeaderMap) -> String {
    set_cookie(STATE_COOKIE, "", 0, app.secure_cookies(headers))
}

/// What OIDC sign-in says when the hub does not know an https address of its own.
///
/// Names both ways to give one, because the reader is one line away from fixing
/// it either way and the route is anonymous: whoever follows a stale bookmark
/// gets the same sentence.
const NOT_ADDRESSED: &str = "OIDC 登录需要 hub 知道自己的对外地址，且必须是 https：\
     用 --site https://你的域名 启动，或在面板「设置」里填站点 URL";

/// The three endpoints of the provider, plus the issuer it claims. An id_token
/// is not verified (see [`oidc_login`]), so no JWKS is kept; the claimed issuer
/// is kept only to be compared with the one that was asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct Discovery {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: String,
    /// Absent when the document does not name one. [`check_discovery`] then has
    /// nothing to compare and judges the three endpoints on their own.
    pub issuer: Option<String>,
}

/// Picks the three endpoints out of a discovery document. A separate function
/// because it is the part that can be wrong in ways worth a test: a document
/// missing one endpoint is refused by name rather than by "missing field ...".
fn parse_discovery(body: &str) -> Result<Discovery> {
    #[derive(Deserialize)]
    struct Document {
        authorization_endpoint: Option<String>,
        token_endpoint: Option<String>,
        userinfo_endpoint: Option<String>,
        issuer: Option<String>,
    }
    let document: Document = serde_json::from_str(body)
        .with_context(|| format!("discovery document: {}", body.chars().take(200).collect::<String>()))
        .context(Shown("身份系统的配置无法识别，检查 Issuer 是否填的是它的地址".into()))?;
    let endpoint = |value: Option<String>, name: &str| match value.filter(|v| !v.trim().is_empty()) {
        Some(value) => Ok(value),
        None => Err(anyhow!("discovery document has no {name}"))
            .context(Shown(format!("身份系统的配置里没有 {name}，它可能不是 OIDC 服务"))),
    };
    Ok(Discovery {
        authorization_endpoint: endpoint(document.authorization_endpoint, "authorization_endpoint")?,
        token_endpoint: endpoint(document.token_endpoint, "token_endpoint")?,
        userinfo_endpoint: endpoint(document.userinfo_endpoint, "userinfo_endpoint")?,
        issuer: document.issuer.filter(|v| !v.trim().is_empty()),
    })
}

/// Holds a fetched document to the address it was fetched from, so that the
/// three endpoints it names are the ones belonging to the issuer that was
/// configured.
///
/// Two things are checked, both about a document that answers correctly but for
/// the wrong place:
///
/// * the issuer it claims. OIDC Discovery 1.0 §4.3 requires the two to match,
///   and the failure it catches is the ordinary one: an issuer missing its
///   tenant path (`https://host` for Authentik's
///   `https://host/application/o/<slug>/`) is served some other tenant's
///   document, and signing in against it would bind accounts from the wrong
///   place. Trailing slashes are ignored, since both spellings name one issuer.
/// * the scheme of each endpoint. A document fetched over TLS may not send the
///   code, the verifier, the secret or the bearer token somewhere in the clear,
///   so `https` is required -- except where the issuer itself is plain `http`,
///   which [`crate::api::issuer_url`] has already limited to the hub's own
///   machine or network.
fn check_discovery(discovery: &Discovery, issuer: &str) -> Result<()> {
    if let Some(claimed) = discovery.issuer.as_deref() {
        let (claimed, asked) = (claimed.trim().trim_end_matches('/'), issuer.trim().trim_end_matches('/'));
        if !claimed.eq_ignore_ascii_case(asked) {
            return Err(anyhow!("discovery document claims issuer {claimed}, configured {asked}")).context(
                Shown(format!(
                    "身份系统说自己是 {claimed}，与填写的 {asked} 不一致：Issuer 多半少填或多填了一段路径"
                )),
            );
        }
    }
    let plaintext_ok = issuer.starts_with("http://");
    for (name, endpoint) in [
        ("authorization_endpoint", &discovery.authorization_endpoint),
        ("token_endpoint", &discovery.token_endpoint),
        ("userinfo_endpoint", &discovery.userinfo_endpoint),
    ] {
        let scheme = reqwest::Url::parse(endpoint).map(|url| url.scheme().to_owned());
        let ok = match scheme {
            Ok(scheme) => scheme == "https" || (plaintext_ok && scheme == "http"),
            Err(_) => false,
        };
        if !ok {
            return Err(anyhow!("discovery document gives {name} as {endpoint:?}"))
                .context(Shown(format!("身份系统的 {name} 不是 https 地址，这次登录不走它")));
        }
    }
    Ok(())
}

/// `BASE64URL-NOPAD(SHA256(verifier))`, the S256 challenge of RFC 7636 §4.2.
///
/// The verifier never leaves the hub except back through the browser's own
/// cookie, which is safe: it is worth nothing without the one-time code, and the
/// code only ever reaches the hub.
fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// How long a fetched discovery document is reused. `/api/auth/oidc` answers
/// anyone, so without this every click would be one outbound request: the hub
/// would relay a flood at whatever provider it points to.
const DISCOVERY_TTL: Duration = Duration::from_secs(3_600);
/// How long a failed fetch is remembered. Long enough to stop a reload loop from
/// hammering a dead provider; short enough that a provider coming back is picked
/// up without a restart.
const DISCOVERY_RETRY: Duration = Duration::from_secs(60);

/// The last answer about one issuer, and when it may be asked again.
#[derive(Debug)]
pub struct Cached {
    /// The issuer this answer belongs to. A different one makes it worthless.
    issuer: String,
    /// The document, or `None` when the last fetch failed.
    discovery: Option<Discovery>,
    /// The earliest moment another fetch may be made.
    due: Instant,
}

/// What the cache says about a request, from [`decide`].
#[derive(Debug, PartialEq)]
enum Decision {
    Fresh,
    /// Inside a failed fetch's window: no request, no waiting.
    Wait,
    Fetch,
}

/// The cache rule, on its own so a test can hand it a clock instead of waiting an
/// hour, and so the three branches are readable in one place.
fn decide(cache: Option<&Cached>, issuer: &str, now: Instant) -> Decision {
    let Some(cached) = cache else { return Decision::Fetch };
    if cached.issuer != issuer {
        return Decision::Fetch;
    }
    match (cached.discovery.is_some(), now < cached.due) {
        // A document still inside its hour.
        (true, true) => Decision::Fresh,
        // A failure still inside its minute.
        (false, true) => Decision::Wait,
        // Either window has passed.
        _ => Decision::Fetch,
    }
}

/// The provider's endpoints, from the cache when they are still good.
///
/// The record is armed pessimistically before the request rather than after it:
/// a burst of anonymous clicks then produces one outbound request instead of one
/// each, which is the whole point of caching here. Success replaces the armed
/// entry with the document and an hour; failure leaves it to expire in a minute.
pub(crate) async fn discovery_for(app: &App) -> Result<Discovery> {
    let Some(issuer) = app.db.get("oidc_issuer").filter(|v| !v.trim().is_empty()) else {
        refuse!("没有配置 OIDC 登录");
    };
    // A trailing slash is common (Authentik's issuers end in one) and would
    // otherwise produce a `//.well-known` path the provider does not serve.
    let issuer = issuer.trim().trim_end_matches('/').to_owned();
    let now = Instant::now();
    {
        let mut cache = app.oidc.lock().unwrap_or_else(|e| e.into_inner());
        match decide(cache.as_ref(), &issuer, now) {
            Decision::Fresh => {
                if let Some(discovery) = cache.as_ref().and_then(|c| c.discovery.clone()) {
                    return Ok(discovery);
                }
            }
            Decision::Wait => refuse!("连不上身份系统，稍后再试"),
            Decision::Fetch => {
                *cache = Some(Cached { issuer: issuer.clone(), discovery: None, due: now + DISCOVERY_RETRY });
            }
        }
    }

    let url = format!("{issuer}/.well-known/openid-configuration");
    let discovery = fetch_discovery(app, &url, &issuer).await?;
    let mut cache = app.oidc.lock().unwrap_or_else(|e| e.into_inner());
    // Whatever arrived meanwhile was for this issuer -- the fetch above armed
    // it -- so replacing it is safe unless the operator changed the issuer.
    if cache.as_ref().is_some_and(|c| c.issuer == issuer) {
        *cache =
            Some(Cached { issuer, discovery: Some(discovery.clone()), due: Instant::now() + DISCOVERY_TTL });
    }
    Ok(discovery)
}

async fn fetch_discovery(app: &App, url: &str, issuer: &str) -> Result<Discovery> {
    let response = app
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| anyhow::Error::from(e).context(Shown("连不上身份系统，稍后再试".into())))?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("discovery request answered {status} for {url}")
            .context(Shown("身份系统没有提供 OIDC 配置，检查 Issuer 是否填对了".into())));
    }
    let body = response
        .text()
        .await
        .map_err(|e| anyhow::Error::from(e).context(Shown("连不上身份系统，稍后再试".into())))?;
    let discovery = parse_discovery(&body)?;
    // Refused before it can become the cached answer. The placeholder that
    // `discovery_for` armed stays a failure and expires in a minute, so a wrong
    // Issuer costs one request a minute rather than one per click -- the same
    // bound as an unreachable provider.
    check_discovery(&discovery, issuer)?;
    Ok(discovery)
}

/// What a sign-in says when a request to the provider fails: unanswered is the
/// hub's network, an answer that does not decode is the provider's.
fn oidc_failed(e: reqwest::Error) -> anyhow::Error {
    let shown = if e.is_decode() {
        "身份系统的回复无法识别，稍后重新登录"
    } else {
        "hub 连不上身份系统，检查它的网络后重新登录"
    };
    anyhow::Error::from(e).context(Shown(shown.into()))
}

/// Step one of OIDC sign-in: discover the provider, then send the browser there
/// with a state nonce and a PKCE challenge.
///
/// `--site` is required because both the authorize request and the token
/// exchange must carry the same `redirect_uri`, and only the operator knows the
/// address the provider will call. The panel's install commands refuse an
/// address that is not an https domain for the same reason: an operator who
/// configured one has already met the rule.
pub async fn oidc_start(State(app): State<crate::Shared>, headers: HeaderMap) -> Response {
    let Some(client_id) = app.db.get("oidc_client_id").filter(|v| !v.is_empty()) else {
        return answer(StatusCode::PRECONDITION_FAILED, "没有配置 OIDC 登录");
    };
    // The address is a protocol input here, not a convenience: `redirect_uri`
    // travels in the authorize request and again in the token exchange, so a
    // plaintext one would put the code on the wire. Both halves are refused --
    // the panel does not draw the button, and this route is reachable by hand.
    if !app.oidc_address_ok() {
        return answer(StatusCode::PRECONDITION_FAILED, NOT_ADDRESSED);
    }
    let discovery = match discovery_for(&app).await {
        Ok(discovery) => discovery,
        Err(e) => return oidc_sign_in_failed(&app, &headers, e),
    };
    let state = random_token();
    let verifier = random_token();
    let redirect = format!("{}/api/auth/oidc/callback", app.base_url());
    // Some providers publish an authorization endpoint that already carries a
    // query (Azure AD's policy parameter, for one); appending another `?` there
    // would drop their own parameter.
    let separator = if discovery.authorization_endpoint.contains('?') { '&' } else { '?' };
    // `profile` alongside `openid`: Keycloak, Authentik and Authelia only put
    // `preferred_username` in userinfo when it was granted, and without a name
    // the allow list is matched against a `sub`, which never matches anything.
    // A provider that does not know the scope ignores it.
    let url = format!(
        "{}{separator}client_id={}&redirect_uri={}&response_type=code&scope=openid%20profile&state={}&code_challenge={}&code_challenge_method=S256",
        discovery.authorization_endpoint,
        urlencode(&client_id),
        urlencode(&redirect),
        state,
        pkce_challenge(&verifier),
    );
    let secure = app.secure_cookies(&headers);
    with_cookies(
        Redirect::to(&url),
        [
            set_cookie(OIDC_STATE_COOKIE, &state, 600, secure),
            set_cookie(OIDC_VERIFIER_COOKIE, &verifier, 600, secure),
        ],
    )
}

/// Step two: check the callback against the cookies issued in step one, exchange
/// the code, and open a session.
pub async fn oidc_callback(
    State(app): State<crate::Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Response {
    // Refusals arrive in the query string, as with GitHub, and both are cleared
    // whichever way this goes: a state cookie left behind would be a replay
    // window, and the verifier one is single-use by construction.
    if let Some(error) = &query.error {
        let reason = query.error_description.as_deref().unwrap_or(error);
        let shown = if error == "access_denied" {
            "在身份系统上取消了授权"
        } else {
            "身份系统拒绝了这次登录，原因见 hub 日志"
        };
        return oidc_sign_in_failed(
            &app,
            &headers,
            anyhow!("identity provider returned {error:?}: {reason:?}").context(Shown(shown.into())),
        );
    }
    let state = query.state.as_deref().unwrap_or_default();
    if state.is_empty() || cookie_value(&headers, OIDC_STATE_COOKIE).as_deref() != Some(state) {
        return oidc_sign_in_failed(&app, &headers, anyhow!(Shown("登录已过期，请从登录页重新开始".into())));
    }
    // Without the verifier the token exchange cannot prove it was the browser
    // that started this flow, so the callback is turned back rather than sent on
    // without a `code_verifier`.
    let Some(verifier) = cookie_value(&headers, OIDC_VERIFIER_COOKIE).filter(|v| !v.is_empty()) else {
        return oidc_sign_in_failed(&app, &headers, anyhow!(Shown("登录已过期，请从登录页重新开始".into())));
    };
    let Some(code) = query.code.as_deref().filter(|c| !c.is_empty()) else {
        return oidc_sign_in_failed(
            &app,
            &headers,
            anyhow!(Shown("身份系统没有返回授权码，请重新登录".into())),
        );
    };
    let user = match oidc_login(&app, code, &verifier).await {
        Ok(user) => user,
        Err(e) => return oidc_sign_in_failed(&app, &headers, e),
    };
    let session = match issue_session(&app, &headers) {
        Ok(cookie) => cookie,
        Err(e) => return oidc_sign_in_failed(&app, &headers, e),
    };
    crate::notify::signed_in(&app, &format!("OIDC {user}"), client_ip(&app, &headers, peer.ip()));
    with_cookies(
        Redirect::to("/admin/nodes"),
        [clear_oidc_state(&app, &headers), clear_oidc_verifier(&app, &headers), session],
    )
}

/// The GitHub one's counterpart, kept separate rather than parameterised: the
/// warn prefix is what makes a log searchable by provider, and changing the
/// shared function would change GitHub's lines.
fn oidc_sign_in_failed(app: &App, headers: &HeaderMap, e: anyhow::Error) -> Response {
    warn!("OIDC sign-in rejected: {e:#}");
    let reason = e.downcast_ref::<Shown>().map_or(crate::api::INTERNAL, |shown| shown.0.as_str());
    let target = format!("/admin/nodes?login_error={}", urlencode(reason));
    with_cookies(
        Redirect::to(&target),
        [clear_oidc_state(app, headers), clear_oidc_verifier(app, headers), String::new()],
    )
}

fn clear_oidc_state(app: &App, headers: &HeaderMap) -> String {
    set_cookie(OIDC_STATE_COOKIE, "", 0, app.secure_cookies(headers))
}

fn clear_oidc_verifier(app: &App, headers: &HeaderMap) -> String {
    set_cookie(OIDC_VERIFIER_COOKIE, "", 0, app.secure_cookies(headers))
}

/// Attaches several `Set-Cookie` headers to one response. An array of header
/// tuples is unsuitable: axum applies those with `HeaderMap::insert`, so a
/// second `Set-Cookie` replaces the first. Empty entries are skipped.
pub fn with_cookies<const N: usize>(response: impl IntoResponse, cookies: [String; N]) -> Response {
    let mut response = response.into_response();
    for cookie in cookies {
        if cookie.is_empty() {
            continue;
        }
        match cookie.parse() {
            Ok(value) => {
                response.headers_mut().append(header::SET_COOKIE, value);
            }
            Err(e) => return fail(e),
        }
    }
    response
}

/// Percent-encodes everything outside the unreserved set, sufficient for
/// placing an arbitrary message in a query string.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// What a sign-in says when a request to GitHub fails: unanswered is the hub's
/// network, an answer that does not decode is GitHub's.
fn github_failed(e: reqwest::Error) -> anyhow::Error {
    let shown = if e.is_decode() {
        "GitHub 的回复无法识别，稍后重新登录"
    } else {
        "hub 连不上 GitHub，检查它的网络后重新登录"
    };
    anyhow::Error::from(e).context(Shown(shown.into()))
}

/// Exchanges the code for a token and checks the login against the allow list,
/// returning the accepted login.
async fn github_login(app: &App, code: &str) -> Result<String> {
    let (Some(id), Some(secret)) = (app.db.get("github_client_id"), app.db.get("github_client_secret"))
    else {
        refuse!("没有配置 GitHub 登录");
    };
    let allowed = allowed_logins(&app.db.get("github_allowed_users").unwrap_or_default());
    if allowed.is_empty() {
        // Without an allow list, any GitHub account could sign in.
        refuse!("没有设置允许登录的 GitHub 用户");
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: Option<String>,
        error_description: Option<String>,
    }
    let token: TokenResponse = app
        .http
        .post("https://github.com/login/oauth/access_token")
        .header(header::ACCEPT, "application/json")
        .json(&serde_json::json!({"client_id": id, "client_secret": secret, "code": code}))
        .send()
        .await
        .map_err(github_failed)?
        .json()
        .await
        .map_err(github_failed)?;
    let Some(access) = token.access_token else {
        // Typically an expired code, or a client secret that no longer matches.
        let reason = token.error_description.unwrap_or_else(|| "no access token".into());
        return Err(anyhow!(reason)
            .context(Shown("GitHub 没有发放令牌，检查 Client Secret 是否正确后重新登录".into())));
    };

    #[derive(Deserialize)]
    struct GithubUser {
        login: String,
        id: i64,
    }
    let response = app
        .http
        .get("https://api.github.com/user")
        .header(header::AUTHORIZATION, format!("Bearer {access}"))
        .header(header::USER_AGENT, "probe-hub")
        .send()
        .await
        .map_err(github_failed)?;
    let status = response.status();
    let body = response.text().await.map_err(github_failed)?;
    // Decoding an error page into GithubUser would report "missing field login"
    // instead of GitHub's actual message.
    let user: GithubUser = serde_json::from_str(&body)
        .with_context(|| format!("user response ({status}): {}", body.chars().take(200).collect::<String>()))
        .context(Shown(format!("GitHub 没有返回用户信息（HTTP {}），重新登录再试", status.as_u16())))?;

    if !allowed.contains(&user.login.to_lowercase()) {
        // The list stays in the log and out of the reason, which travels back in
        // a query string: any GitHub account can reach that page, and a reason
        // carrying the allow list would disclose the accounts worth phishing.
        warn!("GitHub user {} is not on the allowed list {allowed:?}", user.login);
        refuse!("GitHub 用户 {} 不在允许登录的名单里", user.login);
    }
    let id = user.id.to_string();
    match app.db.bind_github(&user.login.to_lowercase(), &id)? {
        None => {
            warn!("GitHub user {} was removed from the allowed list during sign-in", user.login);
            refuse!("GitHub 用户 {} 不在允许登录的名单里", user.login);
        }
        Some(bound) if bound != id => {
            warn!(
                "GitHub user {} is account {id}, but the name first signed in as account {bound}",
                user.login
            );
            refuse!(
                "GitHub 用户 {} 已经不是第一次登录时的那个账号。如果账号确实重建过，先把它从允许名单里删掉并保存，再加回来",
                user.login
            );
        }
        Some(_) => {}
    }
    info!("GitHub sign-in accepted for {}", user.login);
    Ok(user.login)
}

/// Exchanges the code for a token, reads who it belongs to from the provider's
/// userinfo endpoint, and checks that against the allow list.
///
/// The id_token is deliberately not verified. Verifying it means decoding a JWT,
/// fetching JWKS and accepting the provider's choice of algorithm -- a new
/// dependency and a great deal of code -- to prove something the hub already
/// knows: the code arrived on a server-to-server TLS connection it opened itself,
/// and only it holds the code. The cost of that choice is that `nonce` would have
/// nothing to check it against, so the authorize request does not send one either;
/// a nonce that is issued and never verified is decoration. What is left holding
/// the flow together is the state cookie (the browser started it) and PKCE (the
/// code is for this exchange).
async fn oidc_login(app: &App, code: &str, verifier: &str) -> Result<String> {
    let (Some(client_id), Some(_)) = (app.db.get("oidc_client_id"), app.db.get("oidc_issuer")) else {
        refuse!("没有配置 OIDC 登录");
    };
    let allowed = allowed_logins(&app.db.get("oidc_allowed_users").unwrap_or_default());
    if allowed.is_empty() {
        // Without an allow list, any account on the provider could sign in.
        refuse!("没有设置允许登录的 OIDC 用户");
    }
    // The exchange must repeat the exact `redirect_uri` of the authorize request,
    // so a hub that does not know its own address has none to repeat.
    if !app.oidc_address_ok() {
        refuse!("{}", NOT_ADDRESSED);
    }
    // Held across both outbound requests below, which are made on behalf of a
    // caller the hub cannot identify.
    let Ok(_permit) = OIDC_GATE.try_acquire() else {
        refuse!("正在进行的登录太多，稍后再试");
    };
    let discovery = discovery_for(app).await?;

    #[derive(Serialize)]
    struct TokenForm<'a> {
        grant_type: &'a str,
        code: &'a str,
        redirect_uri: &'a str,
        code_verifier: &'a str,
        client_id: &'a str,
        /// Absent for a public client, which is a supported configuration: PKCE
        /// is what protects the exchange, and a secret is what a confidential
        /// client adds on top.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<&'a str>,
    }
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let redirect_uri = format!("{}/api/auth/oidc/callback", app.base_url());
    let secret = app.db.get("oidc_client_secret").filter(|s| !s.is_empty());
    let form = TokenForm {
        grant_type: "authorization_code",
        code,
        redirect_uri: &redirect_uri,
        code_verifier: verifier,
        client_id: &client_id,
        client_secret: secret.as_deref(),
    };
    let token: TokenResponse = app
        .http
        .post(&discovery.token_endpoint)
        .header(header::ACCEPT, "application/json")
        .form(&form)
        .send()
        .await
        .map_err(oidc_failed)?
        .json()
        .await
        .map_err(oidc_failed)?;
    let Some(access) = token.access_token else {
        // Typically an expired code, a redirect_uri that does not match the one
        // registered, or a secret the provider no longer accepts.
        let reason = token.error_description.or(token.error).unwrap_or_else(|| "no access token".into());
        return Err(anyhow!(reason)
            .context(Shown("身份系统没有发放令牌，检查 Client ID/Secret 与回调地址后重新登录".into())));
    };

    #[derive(Deserialize)]
    struct UserInfo {
        sub: Option<String>,
        preferred_username: Option<String>,
    }
    let response = app
        .http
        .get(&discovery.userinfo_endpoint)
        .header(header::AUTHORIZATION, format!("Bearer {access}"))
        .header(header::USER_AGENT, "probe-hub")
        .send()
        .await
        .map_err(oidc_failed)?;
    let status = response.status();
    let body = response.text().await.map_err(oidc_failed)?;
    // As with GitHub's user response: decoding an error page would report a
    // missing field instead of the provider's actual answer.
    let user: UserInfo = serde_json::from_str(&body)
        .with_context(|| {
            format!("userinfo response ({status}): {}", body.chars().take(200).collect::<String>())
        })
        .context(Shown(format!("身份系统没有返回用户信息（HTTP {}），重新登录再试", status.as_u16())))?;
    let Some(sub) = user.sub.filter(|s| !s.trim().is_empty()) else {
        refuse!("身份系统没有返回用户标识（sub）");
    };
    // The name is what the allow list holds and what the panel shows; `sub` is
    // what the binding holds. A provider may send no name at all, in which case
    // the identifier is the only thing to match on.
    let name = user
        .preferred_username
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| sub.clone())
        .trim()
        .to_lowercase();
    // The bindings are `name:sub` pairs, so a colon in a name would be read as
    // the start of a `sub`: the account would sign in once and then be refused
    // as "no longer the account it first signed in as", with nothing in the
    // message pointing at the colon. Refused here instead, and the allow list
    // refuses to store one for the same reason.
    if name.contains(':') {
        warn!("OIDC user {name:?} has a colon in its name, which the binding list cannot hold");
        refuse!("身份系统的用户名里有冒号（{}），与绑定记录的分隔符冲突，请改用别的用户名", name);
    }

    if !allowed.contains(&name) {
        // The list stays in the log and out of the reason: the reason travels back
        // in a query string anyone can read.
        warn!("OIDC user {} is not on the allowed list {allowed:?}", name);
        refuse!("身份系统用户 {} 不在允许登录的名单里", name);
    }
    match app.db.bind_oidc(&name, &sub)? {
        None => {
            warn!("OIDC user {} was removed from the allowed list during sign-in", name);
            refuse!("身份系统用户 {} 不在允许登录的名单里", name);
        }
        Some(bound) if bound != sub => {
            warn!("OIDC user {} is account {sub}, but the name first signed in as account {bound}", name);
            refuse!(
                "身份系统用户 {} 已经不是第一次登录时的那个账号。如果账号确实删掉重建过，先把它从允许名单里删掉并保存，再加回来",
                name
            );
        }
        Some(_) => {}
    }
    info!("OIDC sign-in accepted for {}", name);
    Ok(name)
}

/// The GitHub account each listed login belonged to when it first signed in,
/// as `login:id` pairs. The list names logins, and a renamed or deleted
/// account leaves its login free for anyone to register.
pub const GITHUB_IDS: &str = "github_user_ids";

/// The OIDC `sub` each listed name first signed in as, as `name:sub` pairs.
///
/// The list names what the IdP calls people, and a name there can be deleted
/// and given to someone else. The `sub` cannot: it is the one thing the IdP
/// promises to keep pointing at the same account, which is why the binding is
/// kept against it rather than against the name.
pub const OIDC_IDS: &str = "oidc_user_ids";

/// The logins of the allow list, in the case GitHub ignores.
pub fn allowed_logins(list: &str) -> Vec<String> {
    list.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
}

pub fn bound_id<'a>(ids: &'a str, login: &str) -> Option<&'a str> {
    ids.split(',').filter_map(|pair| pair.split_once(':')).find(|(l, _)| *l == login).map(|(_, id)| id)
}

/// `ids` without the logins `list` no longer allows, so a login removed and
/// added back binds afresh on its next sign-in.
pub fn keep_listed(ids: &str, list: &str) -> String {
    let allowed = allowed_logins(list);
    ids.split(',')
        .filter(|pair| pair.split_once(':').is_some_and(|(l, _)| allowed.iter().any(|a| a == l)))
        .collect::<Vec<_>>()
        .join(",")
}

/// Peer address, or the last hop in X-Forwarded-For when the request arrived
/// through a local reverse proxy. Used for throttling and the sign-in
/// notification, never for authorization.
///
/// The header is honoured only when the peer is itself local. Otherwise a
/// caller could mint a fresh identity per request, bypassing the lockout and
/// growing the throttle map without bound.
///
/// The last value is taken, not the first. Both documented proxies append
/// rather than replace -- nginx's `$proxy_add_x_forwarded_for`, caddy's
/// `reverse_proxy` default -- so a caller supplying its own `X-Forwarded-For`
/// leaves that value at the head while the address the proxy observed lands at
/// the tail. Reading the head would return control of the lockout to the
/// caller: rotating the header makes every attempt a fresh address, and writing
/// the operator's address locks them out of the sign-in page.
///
/// A second trusted proxy in front of the local one places its own address at
/// the tail instead. No single value in this header identifies the client, so
/// such a deployment must have its edge write the client address.
///
/// With `origin_cdn_only` on, the operator states that nothing but a CDN or
/// tunnel can reach the hub, and the peer no longer matters: the visitor is
/// `CF-Connecting-IP`, which Cloudflare overwrites, else the rightmost public
/// address in `X-Forwarded-For`, past any private hops a local proxy appended.
/// Rightmost, because a CDN appends what it saw and everything before that is
/// the caller's. Behind a public proxy of the operator's own the tail is still
/// that proxy's address, which its realip setting turns into the visitor. The
/// operator's statement is theirs to have made true -- a tunnel with no public
/// port, a secret header the CDN adds and the proxy requires -- and with it
/// untrue the caller writes its own address and the lockout means nothing.
///
/// Both addresses are canonicalized: the default dual-stack `[::]` listener
/// reports IPv4 peers, 127.0.0.1 included, as `::ffff:a.b.c.d`, which no IPv6
/// range below recognizes as local.
pub fn client_ip(app: &crate::App, headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    if app.db.get("origin_cdn_only").as_deref() == Some("on") {
        let visitor = written(headers, "cf-connecting-ip").next();
        if let Some(ip) = visitor.or_else(|| written(headers, "x-forwarded-for").last()) {
            return ip;
        }
    }
    let peer = peer.to_canonical();
    if !behind_local_proxy(peer) {
        return peer;
    }
    // The last line: a proxy that adds a line of its own, HAProxy's
    // `option forwardfor` for one, leaves the caller's lines ahead of it.
    headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(entry)
        .map_or(peer, |ip| ip.to_canonical())
}

/// One entry of a forwarding header. Some proxies, Azure's gateways among
/// them, add the port: `1.2.3.4:5678`, `[2001:db8::1]:443`. Unparsed, such an
/// entry would fall back to the proxy's address, one throttle key for every
/// visitor.
fn entry(v: &str) -> Option<IpAddr> {
    let v = v.trim();
    v.parse()
        .ok()
        .or_else(|| v.parse::<std::net::SocketAddr>().ok().map(|s| s.ip()))
        .or_else(|| v.strip_prefix('[')?.strip_suffix(']')?.parse().ok())
}

/// The public addresses written in a header, in order, however many lines and
/// commas it spans. Private and unparseable entries are passed over.
fn written<'a>(headers: &'a HeaderMap, name: &str) -> impl Iterator<Item = IpAddr> + 'a {
    headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(entry)
        .map(|ip| ip.to_canonical())
        .filter(|ip| crate::agent_ws::public(*ip))
}

/// Where a node's connection came from: its exit on the panel, and the address
/// its country falls back to. Called only once the node's token has checked out.
///
/// What a proxy in front of the hub says, believed: `CF-Connecting-IP` if there
/// is one, else the first public address in `X-Forwarded-For`, which is where a
/// CDN puts the address it received the connection from. Behind a CDN,
/// `client, edge` is thus the client with nothing configured, where
/// [`client_ip`] sees the edge.
///
/// That would be no way to read a throttle's key, which anyone can write to
/// lock others out or to slip past a lockout. Here a forged value costs the
/// forger only a wrong address beside their own node: a token holder reports
/// any public address of its own in the hello already, and the country lookup
/// follows what was believed, as it did for `CF-Connecting-IP`.
pub fn node_ip(app: &crate::App, headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    let written_by_proxy = written(headers, "cf-connecting-ip").next();
    written_by_proxy
        .or_else(|| written(headers, "x-forwarded-for").next())
        .unwrap_or_else(|| client_ip(app, headers, peer))
}

/// Loopback or a private network, where a reverse proxy resides.
fn behind_local_proxy(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        // Unique-local (fc00::/7) and link-local (fe80::/10); the stable
        // standard library provides no predicate for either.
        IpAddr::V6(v6) => {
            let head = v6.segments()[0];
            v6.is_loopback() || head & 0xfe00 == 0xfc00 || head & 0xffc0 == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forwarded_entry_may_carry_a_port_or_brackets() {
        for (written, ip) in [
            ("1.2.3.4", Some("1.2.3.4")),
            ("1.2.3.4:5678", Some("1.2.3.4")),
            ("[2001:db8::1]:443", Some("2001:db8::1")),
            ("[2001:db8::1]", Some("2001:db8::1")),
            (" 2001:db8::1 ", Some("2001:db8::1")),
            ("unknown", None),
        ] {
            assert_eq!(entry(written), ip.map(|ip| ip.parse().unwrap()), "{written}");
        }
    }

    #[test]
    fn a_password_round_trips_fails_closed_and_never_repeats_a_salt() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("Correct horse battery staple", &hash));
        assert!(!verify_password("", &hash));
        // A corrupt or empty stored hash must fail closed.
        assert!(!verify_password("anything", "not-a-hash"));
        assert!(!verify_password("anything", ""));
        // The salt is per hash, so cracking one row does not reveal every other
        // row sharing that password.
        assert_ne!(hash_password("same").unwrap(), hash_password("same").unwrap());
    }

    /// One address through the full lockout lifecycle: attempts up to the limit
    /// are allowed, the next locks the address out, the window expires on its
    /// own, and a success clears it early. The window is shortened so expiry is
    /// reachable within the test.
    #[test]
    fn a_lockout_lands_expires_on_its_own_and_clears_on_success() {
        let window = Duration::from_millis(60);
        let t = Throttle { window, ..Default::default() };
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let other: IpAddr = "203.0.113.8".parse().unwrap();
        let stale: IpAddr = "203.0.113.9".parse().unwrap();
        let held = || t.seen.lock().unwrap().len();

        t.record_failure(stale);
        for _ in 0..MAX_ATTEMPTS {
            assert!(!t.locked(ip), "attempts up to the limit are still allowed");
            t.record_failure(ip);
        }
        assert!(t.locked(ip), "the attempt past the limit is shut out");
        assert!(!t.locked(other), "the lockout must not spread to other addresses");

        // A lockout is a delay rather than a ban: the address is readmitted
        // automatically.
        std::thread::sleep(window * 2);
        assert!(!t.locked(ip), "an expired lockout must lift on its own");

        // `stale` is never queried, so only the sweep on entry can remove it.
        // Without it the map grows by one entry per address presented, for the
        // life of the process.
        assert_eq!(held(), 1, "the expired lockout is gone, stale is still held");
        t.record_failure(other);
        assert_eq!(held(), 1, "the stale address is swept, not carried");

        // A correct password clears the count, so two typos do not make the next
        // mistake a lockout.
        t.clear(other);
        assert_eq!(held(), 0);
    }

    fn shared() -> crate::Shared {
        std::sync::Arc::new(crate::App::for_test(crate::db::Db::open(":memory:").unwrap()))
    }

    /// The example of RFC 7636 appendix B, verbatim: a challenge that does not
    /// match its verifier is a sign-in the provider refuses, so this is the one
    /// place the encoding is pinned to the specification rather than to itself.
    ///
    /// (The plan quoted this verifier ending `...Ejno`; the RFC's ends `...EjXk`,
    /// and only that one hashes to the expected challenge. The expectation below
    /// is the RFC's, not the plan's.)
    #[test]
    fn the_pkce_challenge_matches_the_rfc_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        // 64 hex characters, the shape `random_token` produces, is inside the
        // 43..=128 the RFC allows.
        let verifier = random_token();
        assert_eq!(verifier.len(), 64);
        let challenge = pkce_challenge(&verifier);
        assert_eq!(challenge.len(), 43, "SHA-256 is 32 bytes, 43 characters unpadded");
        assert!(
            !challenge.contains('=') && !challenge.contains('+') && !challenge.contains('/'),
            "{challenge}"
        );
    }

    #[test]
    fn a_discovery_document_yields_its_three_endpoints() {
        let document = r#"{
            "issuer": "https://id.example.com",
            "authorization_endpoint": "https://id.example.com/authorize",
            "token_endpoint": "https://id.example.com/token",
            "userinfo_endpoint": "https://id.example.com/userinfo",
            "scopes_supported": ["openid", "profile"],
            "code_challenge_methods_supported": ["S256"]
        }"#;
        let discovery = parse_discovery(document).unwrap();
        assert_eq!(
            discovery,
            Discovery {
                authorization_endpoint: "https://id.example.com/authorize".into(),
                token_endpoint: "https://id.example.com/token".into(),
                userinfo_endpoint: "https://id.example.com/userinfo".into(),
                issuer: Some("https://id.example.com".into()),
            }
        );

        // Each endpoint by name, so the operator knows which one is missing.
        for (missing, named) in [
            ("authorization_endpoint", "authorization_endpoint"),
            ("token_endpoint", "token_endpoint"),
            ("userinfo_endpoint", "userinfo_endpoint"),
        ] {
            let mut value: serde_json::Value = serde_json::from_str(document).unwrap();
            value.as_object_mut().unwrap().remove(missing);
            let shown = parse_discovery(&value.to_string())
                .unwrap_err()
                .downcast::<Shown>()
                .map(|s| s.0)
                .unwrap_or_default();
            assert!(shown.contains(named), "{missing}: {shown}");
        }

        // An empty string is as missing as an absent key.
        let blank = document.replace("https://id.example.com/token", "");
        assert!(parse_discovery(&blank).is_err());

        // A page that is not JSON at all: the message must not be serde's.
        let refused = parse_discovery("<html>404</html>").unwrap_err();
        assert_eq!(
            refused.downcast_ref::<Shown>().map(|s| s.0.as_str()),
            Some("身份系统的配置无法识别，检查 Issuer 是否填的是它的地址")
        );
    }

    /// A document that answers correctly for somewhere else is the failure this
    /// check exists for: an issuer typed without its tenant path is served the
    /// document of the wrong tenant, every endpoint in it is reachable, and
    /// nothing else in the flow would notice.
    #[test]
    fn a_discovery_document_must_be_about_the_issuer_it_was_fetched_from() {
        let document = |issuer: Option<&str>, scheme: &str| {
            let issuer = issuer.map(|i| format!(r#""issuer": "{i}", "#)).unwrap_or_default();
            format!(
                r#"{{{issuer}
                    "authorization_endpoint": "{scheme}://id.example.com/authorize",
                    "token_endpoint": "{scheme}://id.example.com/token",
                    "userinfo_endpoint": "{scheme}://id.example.com/userinfo"}}"#
            )
        };
        let check = |body: &str, issuer: &str| {
            check_discovery(&parse_discovery(body).unwrap(), issuer)
                .err()
                .and_then(|e| e.downcast::<Shown>().ok())
                .map(|shown| shown.0)
        };

        // One issuer, however its trailing slash is spelled.
        for (claimed, asked) in [
            ("https://id.example.com", "https://id.example.com"),
            ("https://id.example.com/", "https://id.example.com"),
            ("https://id.example.com", "https://id.example.com/"),
        ] {
            assert_eq!(check(&document(Some(claimed), "https"), asked), None, "{claimed} {asked}");
        }

        // A tenant path missing from what the operator typed: the document names
        // one, and the message has to carry both addresses to be readable.
        let shown = check(&document(Some("https://host/application/o/monitor"), "https"), "https://host")
            .expect("a document about another issuer is refused");
        assert!(shown.contains("https://host/application/o/monitor"), "{shown}");
        assert!(shown.contains("与填写的 https://host 不一致"), "{shown}");

        // A document that names no issuer is taken at its word: its endpoints are
        // still checked, and refusing would lock out providers that publish a
        // minimal one.
        assert_eq!(check(&document(None, "https"), "https://id.example.com"), None);

        // Plain http endpoints under an https issuer would put the code, the
        // verifier, the secret and the bearer token on the wire in the clear.
        let shown = check(
            r#"{"issuer": "https://id.example.com",
                "authorization_endpoint": "https://id.example.com/authorize",
                "token_endpoint": "http://id.example.com/token",
                "userinfo_endpoint": "https://id.example.com/userinfo"}"#,
            "https://id.example.com",
        )
        .expect("an endpoint off TLS is refused");
        assert!(shown.contains("token_endpoint"), "{shown}");

        // The same endpoints under an http issuer are the loopback case the
        // issuer setting already allows, and are taken as they are.
        assert_eq!(check(&document(Some("http://127.0.0.1:1411"), "http"), "http://127.0.0.1:1411"), None);
    }

    /// The three branches of the cache rule, with a clock handed in rather than
    /// waited for: a document inside its hour is reused, a failure inside its
    /// minute is not retried, and either window ending lets the next request
    /// through.
    #[test]
    fn the_discovery_cache_reuses_answers_for_an_hour_and_failures_for_a_minute() {
        let now = Instant::now();
        let document = Discovery {
            authorization_endpoint: "https://id.example.com/authorize".into(),
            token_endpoint: "https://id.example.com/token".into(),
            userinfo_endpoint: "https://id.example.com/userinfo".into(),
            issuer: Some("https://id.example.com".into()),
        };
        let found = Cached {
            issuer: "https://id.example.com".into(),
            discovery: Some(document),
            due: now + DISCOVERY_TTL,
        };
        let failed =
            Cached { issuer: "https://id.example.com".into(), discovery: None, due: now + DISCOVERY_RETRY };

        // Nothing cached yet.
        assert_eq!(decide(None, "https://id.example.com", now), Decision::Fetch);
        // Inside the hour: no request, and the document is there to use.
        assert_eq!(decide(Some(&found), "https://id.example.com", now), Decision::Fresh);
        assert_eq!(decide(Some(&found), "https://id.example.com", now + DISCOVERY_TTL), Decision::Fetch);
        // Inside the minute after a failure: no request, and no waiting either.
        assert_eq!(decide(Some(&failed), "https://id.example.com", now), Decision::Wait);
        assert_eq!(decide(Some(&failed), "https://id.example.com", now + DISCOVERY_RETRY), Decision::Fetch);
        // A different issuer makes either answer worthless, whatever its age, and
        // neither may be waited on: the entry belongs to the old address.
        assert_eq!(decide(Some(&found), "https://other.example.com", now), Decision::Fetch);
        assert_eq!(decide(Some(&failed), "https://other.example.com", now), Decision::Fetch);
    }

    /// A hub with no provider configured answers the button's URL with a refusal
    /// rather than a redirect: nothing here may depend on the outside world.
    #[tokio::test]
    async fn the_oidc_entry_point_refuses_an_unconfigured_or_addressless_hub() {
        let app = shared();
        let res = oidc_start(State(app.clone()), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        assert!(res.headers().get(header::LOCATION).is_none());

        // Configured, but the hub does not know the address the provider would
        // call back on, which the exchange has to repeat verbatim.
        app.db.set("oidc_issuer", "https://id.example.com").unwrap();
        app.db.set("oidc_client_id", "monitor").unwrap();
        let res = oidc_start(State(app.clone()), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        assert!(res.headers().get(header::LOCATION).is_none());

        // An address, but a plaintext one: `redirect_uri` is a protocol
        // parameter, so the code would cross the wire in the clear. Refused
        // rather than attempted, and without any outbound request.
        app.db.set("site_url", "http://id.example.com").unwrap();
        let res = oidc_start(State(app), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        assert!(res.headers().get(header::LOCATION).is_none());
    }

    /// The exchange repeats the same `redirect_uri`, so the same gate holds in
    /// front of the two outbound requests rather than only in front of the
    /// button. Nothing here reaches the network: the refusal comes first.
    #[tokio::test]
    async fn a_plaintext_address_stops_the_exchange_before_it_is_made() {
        let app = shared();
        app.db.set("oidc_issuer", "https://id.example.com").unwrap();
        app.db.set("oidc_client_id", "monitor").unwrap();
        app.db.set("oidc_allowed_users", "alice").unwrap();
        app.db.set("site_url", "http://id.example.com").unwrap();
        let refused = oidc_login(&app, "a-code", "a-verifier").await.unwrap_err();
        assert!(format!("{refused:#}").contains("https"), "{refused:#}");
    }

    /// As with the GitHub callback: a callback the browser did not start is
    /// turned back before anything is sent to the provider, and both cookies it
    /// would have relied on are cleared on the way.
    #[tokio::test]
    async fn an_oidc_callback_the_browser_did_not_start_signs_nobody_in() {
        let app = shared();
        for (state, cookie) in
            [(Some("abc"), None), (Some("abc"), Some("xyz")), (None, Some("abc")), (Some(""), Some(""))]
        {
            let mut headers = HeaderMap::new();
            if let Some(cookie) = cookie {
                headers.insert(header::COOKIE, format!("{OIDC_STATE_COOKIE}={cookie}").parse().unwrap());
            }
            let query =
                Callback { code: Some("code".into()), state: state.map(Into::into), ..Default::default() };
            let res = oidc_callback(State(app.clone()), peer(), headers, Query(query)).await;
            let to = res.headers()[header::LOCATION].to_str().unwrap();
            assert!(to.ends_with(&urlencode("登录已过期，请从登录页重新开始")), "{state:?} {cookie:?}: {to}");
            let cleared: Vec<_> = res
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|c| c.to_str().unwrap().to_owned())
                .collect();
            assert!(cleared.iter().any(|c| c.starts_with(OIDC_STATE_COOKIE)), "{cleared:?}");
            assert!(cleared.iter().any(|c| c.starts_with(OIDC_VERIFIER_COOKIE)), "{cleared:?}");
            assert!(!cleared.iter().any(|c| c.starts_with(&format!("{COOKIE}="))), "no session");
        }
    }

    /// A state that matches but a verifier that is gone: the exchange cannot be
    /// made to prove it is the same browser, so it is not attempted.
    #[tokio::test]
    async fn a_callback_without_its_verifier_is_turned_back() {
        let app = shared();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("{OIDC_STATE_COOKIE}=abc123").parse().unwrap());
        let query =
            Callback { code: Some("code".into()), state: Some("abc123".into()), ..Default::default() };
        let res = oidc_callback(State(app), peer(), headers, Query(query)).await;
        let to = res.headers()[header::LOCATION].to_str().unwrap();
        assert!(to.ends_with(&urlencode("登录已过期，请从登录页重新开始")), "{to}");
    }

    fn peer() -> ConnectInfo<std::net::SocketAddr> {
        ConnectInfo("198.51.100.7:40000".parse().unwrap())
    }

    #[tokio::test]
    async fn a_password_signs_in_only_when_it_matches_and_signing_out_ends_the_session() {
        let _gate = PASSWORD_TESTS.lock().await;
        let app = shared();
        app.db.replace_password(&hash_password("the-right-password").unwrap()).unwrap();
        let attempt = |password: &str| {
            let body = Json(LoginBody { password: password.into() });
            login(State(app.clone()), peer(), HeaderMap::new(), body)
        };

        let wrong = attempt("a-wrong-password").await;
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        assert!(wrong.headers().get(header::SET_COOKIE).is_none(), "a wrong password earns no session");

        let right = attempt("the-right-password").await;
        assert_eq!(right.status(), StatusCode::OK);
        let cookie = right.headers()[header::SET_COOKIE].to_str().unwrap().to_owned();
        assert!(cookie.contains(&format!("Max-Age={}", SESSION_DAYS * 86_400)), "{cookie}");
        let token = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
        assert!(app.db.session_valid(&sha256(token)));
        let issued = issued_at(app.db.sessions().unwrap()[0].1);
        assert!((Utc::now().timestamp() - issued).abs() < 60, "valid for {SESSION_DAYS} days from now");

        let mut signed_in = HeaderMap::new();
        signed_in.insert(header::COOKIE, format!("{COOKIE}={token}").parse().unwrap());
        logout(State(app.clone()), signed_in).await;
        assert!(!app.db.session_valid(&sha256(token)), "signing out ends the session server-side");
    }

    /// The state check precedes any request to GitHub, so a callback the
    /// browser did not start is turned back with that reason and nothing else.
    #[tokio::test]
    async fn a_callback_the_browser_did_not_start_signs_nobody_in() {
        let app = shared();
        for (state, cookie) in
            [(Some("abc"), None), (Some("abc"), Some("xyz")), (None, Some("abc")), (Some(""), Some(""))]
        {
            let mut headers = HeaderMap::new();
            if let Some(cookie) = cookie {
                headers.insert(header::COOKIE, format!("{STATE_COOKIE}={cookie}").parse().unwrap());
            }
            let query =
                Callback { code: Some("code".into()), state: state.map(Into::into), ..Default::default() };
            let res = github_callback(State(app.clone()), peer(), headers, Query(query)).await;
            let to = res.headers()[header::LOCATION].to_str().unwrap();
            assert!(to.ends_with(&urlencode("登录已过期，请从登录页重新开始")), "{state:?} {cookie:?}: {to}");
            let sessions = res.headers().get_all(header::SET_COOKIE).iter();
            assert!(!sessions.into_iter().any(|c| c.to_str().unwrap().starts_with(&format!("{COOKIE}="))));
        }
    }

    /// The gate must refuse rather than queue: a queue admits the same flood,
    /// and each attempt that lands costs 19 MiB which remains in a thread's
    /// arena for the life of the process.
    #[tokio::test]
    async fn the_password_gate_refuses_a_flood_rather_than_queueing_it() {
        let _gate = PASSWORD_TESTS.lock().await;
        let held: Vec<_> =
            (0..PASSWORD_CHECKS).map(|_| PASSWORD_GATE.try_acquire().expect("up to the limit")).collect();
        assert!(PASSWORD_GATE.try_acquire().is_err(), "the attempt past the limit must be refused");
        drop(held);
        assert!(PASSWORD_GATE.try_acquire().is_ok(), "permits come back when the checks finish");
    }

    /// Both ends of the same redirect: every form GitHub can send must parse,
    /// or it never reaches the handler and can be neither logged nor explained,
    /// and the reason sent back must survive its query string.
    #[test]
    fn every_callback_shape_parses_and_a_failure_reason_survives_the_round_trip() {
        let parse = |q: &str| serde_urlencoded::from_str::<Callback>(q);

        let ok = parse("code=abc&state=xyz").expect("the happy path");
        assert_eq!(ok.code.as_deref(), Some("abc"));
        assert_eq!(ok.state.as_deref(), Some("xyz"));

        // GitHub reports a refusal with no code.
        let denied = parse("error=access_denied&error_description=the+user+said+no&state=xyz")
            .expect("a refusal must parse, not 400");
        assert_eq!(denied.error.as_deref(), Some("access_denied"));
        assert_eq!(denied.error_description.as_deref(), Some("the user said no"));
        assert!(denied.code.is_none());

        // Truncated or empty callbacks must still reach the handler.
        assert!(parse("state=xyz").is_ok());
        assert!(parse("").is_ok());

        // Anything that would escape the query string must be encoded, or the
        // reason arrives truncated at the first stray separator.
        assert_eq!(urlencode("a&b=c#d"), "a%26b%3Dc%23d");
        assert_eq!(urlencode("用户"), "%E7%94%A8%E6%88%B7");
        let reason = "no allowed GitHub users configured (a&b=c)";
        let back = parse(&format!("error={}", urlencode(reason))).expect("a reason must parse");
        assert_eq!(back.error.as_deref(), Some(reason), "the whole reason comes back");
    }

    /// A session cookie's round trip: the flags it is issued with, sharing a
    /// response with a second cookie, and being extracted from the single header
    /// the browser returns them in.
    #[test]
    fn a_session_cookie_goes_out_locked_down_alongside_others_and_parses_back() {
        let session = set_cookie(COOKIE, "abc123", 3_600, true);
        assert!(session.contains("HttpOnly") && session.contains("SameSite=Lax"));
        assert!(session.contains("Secure"));
        assert!(!set_cookie(COOKIE, "abc123", 3_600, false).contains("Secure"));

        // axum applies an array of header tuples with insert(), keeping only the
        // last Set-Cookie; this helper appends instead.
        let response = with_cookies(StatusCode::OK, [session, set_cookie(STATE_COOKIE, "s", 0, true)]);
        let set: Vec<_> = response.headers().get_all(header::SET_COOKIE).iter().collect();
        assert_eq!(set.len(), 2, "both cookies must reach the browser");
        // Empty entries are skipped rather than emitting a blank header.
        let response = with_cookies(StatusCode::OK, ["a=1".to_owned(), String::new()]);
        assert_eq!(response.headers().get_all(header::SET_COOKIE).iter().count(), 1);

        // And back: the browser returns them all in a single header.
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "other=1; monitor_session=abc123; x=2".parse().unwrap());
        assert_eq!(cookie_value(&h, COOKIE).as_deref(), Some("abc123"));
        assert_eq!(cookie_value(&h, "missing"), None);
        assert_eq!(cookie_value(&HeaderMap::new(), COOKIE), None);
    }

    #[test]
    fn forwarded_header_is_trusted_only_behind_a_local_proxy() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let app = crate::App::for_test(crate::db::Db::open(":memory:").unwrap());
        let xff = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert("x-forwarded-for", v.parse().unwrap());
            h
        };

        // Nothing arrived with the request: the proxy appended the single
        // address it observed, which is the entire header.
        assert_eq!(client_ip(&app, &xff("198.51.100.9"), ip("127.0.0.1")).to_string(), "198.51.100.9");

        // The caller supplied a header of its own. Both documented proxies
        // append, so the fabricated value sits at the head and the proxy's
        // observation at the tail; reading the head would let a caller choose its
        // own throttle bucket each request, or claim the operator's address.
        let forged = xff("10.0.0.2, 198.51.100.9");
        for peer in ["127.0.0.1", "10.0.0.1", "::1", "fd00::1", "fe80::1"] {
            assert_eq!(client_ip(&app, &forged, ip(peer)).to_string(), "198.51.100.9", "{peer}");
        }

        // A dual-stack `[::]` listener reports an IPv4 proxy as `::ffff:a.b.c.d`,
        // which is the same local peer.
        assert_eq!(client_ip(&app, &forged, ip("::ffff:172.18.0.4")).to_string(), "198.51.100.9");
        assert_eq!(client_ip(&app, &HeaderMap::new(), ip("::ffff:203.0.113.5")), ip("203.0.113.5"));

        // A proxy that adds a line of its own puts it after the caller's.
        let mut lines = HeaderMap::new();
        lines.append("x-forwarded-for", "10.0.0.2".parse().unwrap());
        lines.append("x-forwarded-for", "198.51.100.9".parse().unwrap());
        assert_eq!(client_ip(&app, &lines, ip("127.0.0.1")).to_string(), "198.51.100.9");

        // Directly from the internet the entire header is caller-supplied, and
        // honouring any part of it bypasses the lockout.
        assert_eq!(client_ip(&app, &forged, ip("203.0.113.5")), ip("203.0.113.5"));
        assert_eq!(client_ip(&app, &forged, ip("2001:db8::5")), ip("2001:db8::5"));
        // No header at all: the peer address is used.
        assert_eq!(client_ip(&app, &HeaderMap::new(), ip("10.0.0.1")), ip("10.0.0.1"));

        // Cloudflare in front of the local proxy: the tail is its edge. The
        // throttle stays on it, as anyone on Cloudflare's network can write
        // CF-Connecting-IP; a node's address follows the header.
        let mut edge = xff("10.0.0.2, 203.0.113.7, 162.158.88.126");
        edge.insert("cf-connecting-ip", "::ffff:203.0.113.7".parse().unwrap());
        assert_eq!(client_ip(&app, &edge, ip("127.0.0.1")), ip("162.158.88.126"));
        assert_eq!(node_ip(&app, &edge, ip("127.0.0.1")), ip("203.0.113.7"));
        // Without the header a node's address is the first public one in the
        // list, private hops ahead of it passed over.
        assert_eq!(node_ip(&app, &forged, ip("127.0.0.1")), ip("198.51.100.9"));
        // And with no proxy to speak of, there is nothing else to go by.
        assert_eq!(node_ip(&app, &HeaderMap::new(), ip("203.0.113.5")), ip("203.0.113.5"));
        assert_eq!(node_ip(&app, &xff("10.0.0.2"), ip("203.0.113.5")), ip("203.0.113.5"));
    }

    /// Behind a CDN a node's address is the first public one of the list, where
    /// the throttle's key stays the edge. Whatever else is written ahead of it is
    /// the node's to choose.
    #[test]
    fn a_nodes_address_sees_through_a_cdn_edge_and_the_throttle_does_not() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let app = crate::App::for_test(crate::db::Db::open(":memory:").unwrap());
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "198.51.100.77, 162.158.88.126".parse().unwrap());
        for peer in ["127.0.0.1", "10.0.0.1", "162.158.88.126"] {
            assert_eq!(node_ip(&app, &h, ip(peer)), ip("198.51.100.77"), "{peer}");
        }
        assert_eq!(client_ip(&app, &h, ip("127.0.0.1")), ip("162.158.88.126"));
        assert_eq!(client_ip(&app, &h, ip("162.158.88.126")), ip("162.158.88.126"));
        // A list with nothing public in it falls back to the throttle's rule.
        let mut junk = HeaderMap::new();
        junk.insert("x-forwarded-for", "nonsense, 10.0.0.9".parse().unwrap());
        assert_eq!(node_ip(&app, &junk, ip("127.0.0.1")), ip("10.0.0.9"));
    }

    /// With the origin declared reachable by a CDN only, the visitor is what the
    /// CDN wrote, and what the caller put ahead of it never chooses the key.
    #[test]
    fn with_the_origin_declared_cdn_only_the_visitor_is_the_address() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let app = crate::App::for_test(crate::db::Db::open(":memory:").unwrap());
        let xff = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert("x-forwarded-for", v.parse().unwrap());
            h
        };
        // A tunnel, then the local proxy that appended the tunnel's address,
        // behind a caller-written prefix: the CDN's entry is the one to take.
        let tunnel = xff("192.0.2.1, 198.51.100.77, 127.0.0.1");
        // Off, and not set at all, is the strict rule.
        assert_eq!(client_ip(&app, &tunnel, ip("127.0.0.1")), ip("127.0.0.1"));
        app.db.set("origin_cdn_only", "off").unwrap();
        assert_eq!(client_ip(&app, &tunnel, ip("127.0.0.1")), ip("127.0.0.1"));

        app.db.set("origin_cdn_only", "on").unwrap();
        for peer in ["127.0.0.1", "10.0.0.1", "162.158.88.126"] {
            assert_eq!(client_ip(&app, &tunnel, ip(peer)), ip("198.51.100.77"), "{peer}");
        }
        // The tunnel straight into the hub.
        assert_eq!(client_ip(&app, &xff("192.0.2.1, 198.51.100.77"), ip("127.0.0.1")), ip("198.51.100.77"));
        // Cloudflare writes the header itself, whatever the list says.
        let mut cf = xff("192.0.2.1, 198.51.100.77, 162.158.88.126");
        cf.insert("cf-connecting-ip", "198.51.100.88".parse().unwrap());
        assert_eq!(client_ip(&app, &cf, ip("127.0.0.1")), ip("198.51.100.88"));
        // A private value there is not a visitor.
        cf.insert("cf-connecting-ip", "127.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&app, &cf, ip("127.0.0.1")), ip("162.158.88.126"));
        // A CDN edge that is the proxy's peer is the tail, and stays one bucket.
        let edge = xff("192.0.2.1, 198.51.100.77, 162.158.88.126");
        assert_eq!(client_ip(&app, &edge, ip("127.0.0.1")), ip("162.158.88.126"));
        // Nothing written: the peer, as ever.
        assert_eq!(client_ip(&app, &HeaderMap::new(), ip("203.0.113.5")), ip("203.0.113.5"));
        // The cost of saying it falsely.
        assert_eq!(client_ip(&app, &xff("192.0.2.1"), ip("203.0.113.5")), ip("192.0.2.1"));
    }

    #[test]
    fn an_ipv6_visitor_is_one_bucket_per_64() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let throttle = Throttle::default();
        for n in 0..MAX_ATTEMPTS {
            throttle.record_failure(ip(&format!("2001:db8:1:2::{n:x}")));
        }
        assert!(throttle.locked(ip("2001:db8:1:2:ffff::1")));
        assert!(!throttle.locked(ip("2001:db8:1:3::1")));
    }
}
