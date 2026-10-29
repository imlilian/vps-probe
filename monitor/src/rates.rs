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
use axum::Json;
use chrono::Local;
use serde_json::{json, Map, Value};
use tracing::{info, warn};

use crate::{App, Shared};

/// The source: ECB reference rates as JSON, no key, one edition a working day.
pub const URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD";

/// Where the table is kept. Internal -- not in `api::READABLE_SETTINGS`, so
/// neither settings route returns or accepts it.
const KEY: &str = "rates";

/// Six places. The smallest unit in the table is the rupiah at 0.000055, and
/// what the number feeds is rounded to the dollar.
fn round(usd_per: f64) -> f64 {
    (usd_per * 1e6).round() / 1e6
}

/// The stored table, or `None` before the first successful fetch.
pub fn snapshot(app: &App) -> Option<Value> {
    let stored = app.db.get(KEY)?;
    serde_json::from_str(&stored).ok()
}

/// `GET /api/rates`: the table the public page converts with.
///
/// Open, unlike the rest of `/api`: the answer is a list of published exchange
/// rates and says nothing about this hub, and a visitor who is not signed in is
/// exactly who reads a public status page. A hub that has not fetched yet
/// answers `{}`, which the page reads as "use the table you were built with".
pub async fn public(State(app): State<Shared>) -> Json<Value> {
    Json(snapshot(&app).unwrap_or_else(|| json!({})))
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
    let stored = snapshot(app);
    if stored.as_ref().and_then(|t| t.get("fetched")).and_then(Value::as_str) == Some(today.as_str()) {
        return Ok(());
    }
    match fetch(app).await {
        Ok(table) => {
            let count = table.get("usd_per").and_then(Value::as_object).map_or(0, Map::len);
            let date = table.get("date").and_then(Value::as_str).unwrap_or("unknown").to_owned();
            app.db.set(KEY, &table.to_string())?;
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
    let body: Value = response.json().await.context("rates document")?;
    let rates = body.get("rates").and_then(Value::as_object).context("rates document has no rates")?;
    let mut usd_per = Map::new();
    // The source quotes the other way round -- units of each currency per dollar
    // -- because that is the direction a traveller reads. Every consumer here
    // multiplies a price, so the table is inverted once, here.
    usd_per.insert("USD".to_owned(), json!(1.0));
    for (code, quote) in rates {
        if let Some(per_dollar) = quote.as_f64().filter(|value| *value > 0.0) {
            usd_per.insert(code.to_ascii_uppercase(), json!(round(1.0 / per_dollar)));
        }
    }
    // One entry is the dollar itself: a document that produced nothing else is a
    // broken answer, not a table of one currency.
    if usd_per.len() < 2 {
        anyhow::bail!("rates document holds {} currencies", usd_per.len());
    }
    Ok(json!({
        "fetched": Local::now().format("%Y-%m-%d").to_string(),
        "date": body.get("date").cloned().unwrap_or(Value::Null),
        "usd_per": usd_per,
    }))
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

    /// Every consumer multiplies a price by this table, so it is dollars per
    /// unit -- the inverse of what the source publishes -- and the dollar itself
    /// is in it, since a fleet billed in dollars is the common case.
    #[test]
    fn the_table_is_inverted_to_dollars_per_unit() {
        let rates: Value = serde_json::from_str(DOCUMENT).unwrap();
        let body = rates.get("rates").and_then(Value::as_object).unwrap();
        assert_eq!(round(1.0 / body["GBP"].as_f64().unwrap()), 1.328762);
        assert_eq!(round(1.0 / body["JPY"].as_f64().unwrap()), 0.006331);
        assert_eq!(round(1.0 / body["CNY"].as_f64().unwrap()), 0.150006);
    }

    /// The day fetched is what decides whether to fetch again, not the day the
    /// rates are from: the ECB publishes nothing at weekends, so a Saturday
    /// fetch returns Friday's date and would otherwise refetch until Monday.
    #[test]
    fn a_table_fetched_today_is_not_fetched_again() {
        let app = app();
        let today = Local::now().format("%Y-%m-%d").to_string();
        app.db
            .set(KEY, &json!({"fetched": today, "date": "2026-10-28", "usd_per": {"USD": 1.0}}).to_string())
            .unwrap();
        assert_eq!(snapshot(&app).and_then(|t| t.get("fetched").cloned()), Some(json!(today)));

        // A table from another day is due, whatever its rates' own date says.
        app.db
            .set(KEY, &json!({"fetched": "2020-01-01", "date": today, "usd_per": {"USD": 1.0}}).to_string())
            .unwrap();
        assert_ne!(
            snapshot(&app).and_then(|t| t.get("fetched").and_then(Value::as_str).map(str::to_owned)),
            Some(today),
        );
    }

    /// Nothing stored is an empty answer rather than an error: the page reads it
    /// as "use the table you were built with".
    #[test]
    fn a_hub_that_never_fetched_answers_nothing() {
        let app = app();
        assert!(snapshot(&app).is_none());
    }
}
