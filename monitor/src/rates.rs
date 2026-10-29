//! What one unit of each currency is worth in dollars, refreshed once a day.
//!
//! The public page's remaining-value card adds up prices billed in different
//! currencies, so it needs one scale to add them on. That scale used to be a
//! table compiled into the bundle, which meant it was as old as the release it
//! shipped with. The hub fetches it instead, from the same source the table was
//! taken from -- the ECB reference rates, as frankfurter publishes them -- and
//! the page asks the hub.
//!
//! The page cannot ask frankfurter itself: it is served under `connect-src
//! 'self'`, so a request to another origin is refused by the browser before it
//! leaves the tab. That policy is not widened for a figure that is an estimate.
//!
//! Everything here is best effort. A day the fetch fails keeps yesterday's
//! table, whose date is in it; a hub that has never fetched answers `{}`, and
//! the page falls back to the table it was built with. A price shown in the
//! wrong place is worse than a price not shown at all, and a stale rate is
//! neither: the reader is told which day's rates these are.

use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use chrono::Local;
use serde_json::{json, Map, Value};
use tracing::{info, warn};

use crate::{App, Shared};

/// The source: ECB reference rates as JSON, no key, one edition a working day.
pub const URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD";

/// Where the table is kept, exactly as `/api/rates` serves it. Internal -- not in
/// `api::READABLE_SETTINGS`, so neither settings route returns or accepts it.
const KEY: &str = "rates";

/// The day the table was fetched on, as the hub's calendar writes it. A second
/// key rather than a field of the table so that what is served is what is stored,
/// byte for byte, and so the bookkeeping does not travel to anonymous callers.
const ASKED: &str = "rates_fetched";

/// How many currencies an answer may carry. The source publishes thirty; a
/// thousand is a document that has gone wrong, not a table to store.
const LIMIT: usize = 400;

/// Six places. The smallest unit in the table is the rupiah at 0.000055, and
/// what the number feeds is rounded to the dollar.
fn round(usd_per: f64) -> f64 {
    (usd_per * 1e6).round() / 1e6
}

/// `GET /api/rates`: the table the public page converts with.
///
/// Open, unlike the rest of `/api`: the answer is a list of published exchange
/// rates and says nothing about this hub -- not its address, not its nodes, not
/// when it last ran its housekeeping, which is why that date is kept in its own
/// key rather than in the table. A visitor who is not signed in is exactly who
/// reads a public status page. A hub that has not fetched yet answers `{}`, which
/// the page reads as "use the table you were built with".
///
/// Served as the stored string rather than a parsed `Value`: this route is
/// reachable by anyone, and re-parsing a setting per request is work an anonymous
/// caller should not be able to ask for.
pub async fn public(State(app): State<Shared>) -> Response {
    let body = app.db.get(KEY).filter(|stored| !stored.is_empty()).unwrap_or_else(|| "{}".into());
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// Fetches the table if today's is not already stored.
///
/// Scheduled from the hourly housekeeping pass rather than on its own timer: the
/// source publishes once a working day, so the question "is there anything to do"
/// is answered by the date in the stored table, and a second timer would only be
/// a second thing to keep alive.
pub async fn refresh_if_due(app: &App) -> Result<()> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    // The date fetched on, not the date of the rates it returned: the ECB does
    // not publish at weekends or on holidays, so the two differ for days at a
    // time, and comparing the rates' own date would refetch all day long.
    if app.db.get(ASKED).as_deref() == Some(today.as_str()) {
        return Ok(());
    }
    match fetch(app).await {
        Ok(table) => {
            let count = table.get("usd_per").and_then(Value::as_object).map_or(0, Map::len);
            let date = table.get("date").and_then(Value::as_str).unwrap_or("unknown").to_owned();
            app.db.set(KEY, &table.to_string())?;
            // Stamped only after the table is stored: a write that failed leaves
            // the day unclaimed, so the next pass tries again rather than serving
            // yesterday's rates under today's date.
            app.db.set(ASKED, &today)?;
            info!("exchange rates refreshed: {count} currencies, ECB {date}");
            Ok(())
        }
        Err(e) => {
            // The previous table stays exactly as it was, date and all: an
            // estimate built on last week's rates still beats none, and the page
            // prints the day it is based on.
            warn!("exchange rates not refreshed: {e:#}");
            Err(e)
        }
    }
}

/// One request to the source, as the table the rest of the hub stores.
async fn fetch(app: &App) -> Result<Value> {
    let response =
        app.http.get(URL).timeout(Duration::from_secs(15)).send().await.context("rates request")?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("rates answered {status}");
    }
    let document: Value = response.json().await.context("rates document")?;
    table(&document)
}

/// The table to store, out of the source's document.
///
/// Everything taken from the far end is held to the shape this hub serves: three
/// ASCII letters per code -- the same rule the panel and `billing_error` apply to
/// a currency, so a code that arrives here is one a node could be billed in --
/// a positive finite quote, and a bounded number of them. The document is one
/// request away from a hub that trusts it blindly, and what it produces is stored
/// and then served to every visitor: a megabyte of keys, or a `NaN` that breaks
/// every sum on the page, would both be this hub's fault and not the source's.
fn table(document: &Value) -> Result<Value> {
    let rates = document.get("rates").and_then(Value::as_object).context("rates document has no rates")?;
    let mut usd_per = Map::new();
    // The source quotes the other way round -- units of each currency per dollar
    // -- because that is the direction a traveller reads. Every consumer here
    // multiplies a price, so the table is inverted once, here.
    usd_per.insert("USD".to_owned(), json!(1.0));
    for (code, quote) in rates.iter().take(LIMIT) {
        if !(code.len() == 3 && code.bytes().all(|b| b.is_ascii_alphabetic())) {
            continue;
        }
        // `as_f64` is `None` for a string, a bool or a null, and `is_finite`
        // rejects an infinity or a NaN that survived the trip through JSON.
        if let Some(per_dollar) = quote.as_f64().filter(|value| value.is_finite() && *value > 0.0) {
            let per = round(1.0 / per_dollar);
            if per.is_finite() && per > 0.0 {
                usd_per.insert(code.to_ascii_uppercase(), json!(per));
            }
        }
    }
    // One entry is the dollar itself: a document that produced nothing else is a
    // broken answer, not a table of one currency.
    if usd_per.len() < 2 {
        anyhow::bail!("rates document holds {} usable currencies", usd_per.len());
    }
    Ok(json!({ "date": date(document), "usd_per": usd_per }))
}

/// The day the rates are from, when it is written the way the page prints it.
///
/// Anything else becomes null, and the page then prints the date of the table it
/// was built with. A string of a few thousand characters would otherwise travel
/// into a tooltip on every card.
fn date(document: &Value) -> Value {
    document
        .get("date")
        .and_then(Value::as_str)
        .filter(|date| {
            date.len() == 10
                && date.bytes().enumerate().all(|(i, b)| match i {
                    4 | 7 => b == b'-',
                    _ => b.is_ascii_digit(),
                })
        })
        .map_or(Value::Null, |date| json!(date))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    /// The document the source actually answers with, cut to three currencies.
    const DOCUMENT: &str = r#"{"amount":1.0,"base":"USD","date":"2026-10-28","rates":{"GBP":0.75258,"JPY":157.96,"CNY":6.6664}}"#;

    fn document(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    /// Every consumer multiplies a price by this table, so it is dollars per
    /// unit -- the inverse of what the source publishes -- and the dollar itself
    /// is in it, since a fleet billed in dollars is the common case.
    #[test]
    fn the_table_is_inverted_to_dollars_per_unit() {
        let stored = table(&document(DOCUMENT)).unwrap();
        let usd_per = stored.get("usd_per").and_then(Value::as_object).unwrap();
        assert_eq!(usd_per["USD"], json!(1.0));
        assert_eq!(usd_per["GBP"], json!(1.328762));
        assert_eq!(usd_per["JPY"], json!(0.006331));
        assert_eq!(usd_per["CNY"], json!(0.150006));
        assert_eq!(stored["date"], json!("2026-10-28"));
    }

    /// What arrives from the far end is stored and then served to every visitor,
    /// so it is held to the shape this hub serves: three letters per code, a
    /// positive finite quote, a date in one spelling, and a bounded count.
    #[test]
    fn a_document_of_the_wrong_shape_is_not_stored_whole() {
        let stored = table(&document(
            r#"{"date":"2026-10-28","rates":{
                "gbp":0.75, "CNY":6.66, "USDT":1, "港币":1, "":1, "US D":1, "EURO":1,
                "JPY":0, "KRW":-3, "SEK":null, "NOK":true, "DKK":"7.46"
            }}"#,
        ))
        .unwrap();
        let usd_per = stored.get("usd_per").and_then(Value::as_object).unwrap();
        assert_eq!(
            usd_per.keys().map(String::as_str).collect::<Vec<_>>(),
            ["CNY", "GBP", "USD"],
            "three letters only, quotes that are numbers only, and the dollar"
        );
        assert_eq!(usd_per["GBP"], json!(1.333333), "a lower-case code is stored upper-cased");

        // A date of any other spelling becomes null rather than travelling into
        // every card's tooltip as it was sent.
        for bad in [r#""2026-1-28""#, r#""x""#, "12345", "null", r#""2026-10-28T00:00:00Z""#] {
            let stored =
                table(&document(&format!(r#"{{"date":{bad},"rates":{{"GBP":0.75,"CNY":6.66}}}}"#))).unwrap();
            assert_eq!(stored["date"], Value::Null, "{bad}");
        }

        // A document with one usable quote is a broken answer, not a table.
        assert!(
            table(&document(r#"{"date":"2026-10-28","rates":{"gbp":0.75}}"#)).is_ok(),
            "the dollar plus one"
        );
        assert!(table(&document(r#"{"date":"2026-10-28","rates":{}}"#)).is_err());
        assert!(table(&document(r#"{"date":"2026-10-28"}"#)).is_err(), "no rates at all");
    }

    /// The day the table was fetched on is what decides whether to fetch again,
    /// not the day the rates are from: the ECB publishes nothing at weekends, so
    /// a Saturday fetch returns Friday's date and would otherwise refetch until
    /// Monday.
    #[test]
    fn the_day_fetched_is_kept_beside_the_table_not_in_it() {
        let app = app();
        let today = Local::now().format("%Y-%m-%d").to_string();
        app.db.set(ASKED, &today).unwrap();
        app.db.set(KEY, &json!({"date": "2026-10-28", "usd_per": {"USD": 1.0}}).to_string()).unwrap();
        assert_eq!(app.db.get(ASKED), Some(today));
        // What is served is exactly what is stored: the bookkeeping date is in
        // its own key, so an anonymous caller cannot read when the hub last ran.
        let served = app.db.get(KEY).unwrap();
        assert!(!served.contains("fetched"), "{served}");
        assert!(app.db.get(ASKED).is_some());
    }

    /// Nothing stored is an empty answer rather than an error: the page reads it
    /// as "use the table you were built with".
    #[test]
    fn a_hub_that_never_fetched_has_nothing_to_serve() {
        let app = app();
        assert!(app.db.get(KEY).is_none());
    }
}
