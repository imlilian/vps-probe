//! Built-in admin UI. The public page is a single built-in theme, embedded the
//! same way: nothing here reads a theme from disk or installs one.

use anyhow::Result;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};

use crate::api::answer;
use crate::{App, Shared};

#[derive(RustEmbed)]
#[folder = "web-admin/dist"]
struct AdminAssets;

#[derive(RustEmbed)]
#[folder = "target/theme/dist"]
struct DefaultThemeAssets;

pub async fn serve(State(app): State<Shared>, headers: HeaderMap, uri: Uri) -> Response {
    let known = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    respond(&app, uri.path().trim_start_matches('/'), uri.query(), known, &|html| stamp_icons(&app, html))
}

/// What `serve` answers for `path`. `shell` rewrites the HTML shell on its way
/// out; [`stamp_icons`] resolves each icon through here with the shell left
/// as it is, which also keeps an icon a theme lacks, answered with the shell,
/// from recursing.
fn respond(app: &App, path: &str, query: Option<&str>, known: Option<&str>, shell: Shell) -> Response {
    if is_api_path(path) {
        return answer(StatusCode::NOT_FOUND, format!("没有这个接口：/{path}"));
    }
    // `?theme` asks past the site icon for the theme's own, which the panel
    // shows as what clearing the setting returns to.
    let setting = ICON_PATHS.iter().find(|(icon, _)| *icon == path).map(|&(_, key)| key);
    if let Some(key) = setting.filter(|_| query != Some("theme")) {
        if let Some(Ok((mime, data))) = app.db.get(key).filter(|v| !v.is_empty()).as_deref().map(site_icon) {
            return icon(path, mime, data, known);
        }
    }

    // The panel's entry is an alias for its first page, and said so here rather
    // than by the panel renaming its address once loaded: Chrome files a tab's
    // icon under the URL the page had when the icon arrived, and shows what it
    // filed the moment a navigation starts. Renamed first, the entry kept the
    // icon it last had and flashed it on every visit.
    if path == "admin" || path == "admin/" {
        let first = "/admin/nodes";
        return Redirect::to(&query.map_or(first.to_owned(), |q| format!("{first}?{q}"))).into_response();
    }
    if let Some(path) = path.strip_prefix("admin/") {
        return embedded::<AdminAssets>(
            path,
            "面板没有构建，在 web-admin/ 下运行 npm run build",
            known,
            shell,
        );
    }

    embedded::<DefaultThemeAssets>(path, "默认主题缺失，运行 scripts/theme.sh", known, shell)
}

/// Names each icon in an HTML shell after the bytes served for it -- the ETag,
/// which is their digest -- as the build already names everything under
/// `assets/`. The URL a theme writes is fixed while what it serves is not: a
/// site icon set or cleared, a theme switched or updated. Chrome keeps a tab's
/// icon by its URL and, on an ordinary navigation, shows the one it holds
/// without asking again, whatever the cache headers say; only a reload fetches
/// it anew.
fn stamp_icons(app: &App, html: Vec<u8>) -> Vec<u8> {
    let mut text = match String::from_utf8(html) {
        Ok(text) => text,
        Err(e) => return e.into_bytes(),
    };
    for path in ["favicon.svg", "admin/favicon.svg", "apple-touch-icon.png", "admin/apple-touch-icon.png"] {
        let quoted = format!("\"/{path}\"");
        if !text.contains(&quoted) {
            continue;
        }
        let served = respond(app, path, None, None, &|html| html);
        let Some(etag) = served.headers().get(header::ETAG).and_then(|v| v.to_str().ok()) else { continue };
        text = text
            .replace(&quoted, &format!("\"/{path}?v={}\"", etag.trim_matches('"').get(..8).unwrap_or(etag)));
    }
    text.into_bytes()
}

/// Where the panel and the themes name their icons, plus the ones browsers ask
/// for unprompted, each with the setting that replaces it. With a site icon
/// set, all of them answer with it, so the icon follows the site across theme
/// switches. iOS takes neither SVG nor the tab icon for a bookmark or the home
/// screen, only `apple-touch-icon`, which the panel renders as a separate image.
const ICON_PATHS: &[(&str, &str)] = &[
    ("favicon.svg", "favicon"),
    ("favicon.ico", "favicon"),
    ("admin/favicon.svg", "favicon"),
    ("apple-touch-icon.png", "touch_icon"),
    ("apple-touch-icon-precomposed.png", "touch_icon"),
    ("admin/apple-touch-icon.png", "touch_icon"),
];

/// The largest of either icon. Both are stored as data URLs in the settings
/// rows and saved together through the settings route's 64 KiB body limit,
/// which their base64 forms (a third larger) fit beneath with room for the
/// rest of the form. The panel scales whatever it is given down to fit.
pub const MAX_ICON: usize = 20 * 1024;

/// Decodes the `favicon` or `touch_icon` setting, a `data:image/...;base64,` URL, into the
/// bytes and the type they actually are. The declared type is not trusted: the
/// browser takes it from the file name, and the response's type comes from the
/// bytes.
pub fn site_icon(value: &str) -> Result<(&'static str, Vec<u8>), &'static str> {
    use base64::Engine;
    const NOT_IMAGE: &str = "站点图标只支持 PNG、ICO、SVG、WebP、JPEG、GIF";
    let payload = value
        .strip_prefix("data:image/")
        .and_then(|rest| rest.split_once(";base64,"))
        .map(|(_, payload)| payload)
        .ok_or(NOT_IMAGE)?;
    let data = base64::engine::general_purpose::STANDARD.decode(payload).map_err(|_| NOT_IMAGE)?;
    if data.len() > MAX_ICON {
        return Err("站点图标不能超过 20 KiB");
    }
    let mime = match data.as_slice() {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0, 0, 1, 0, ..] => "image/x-icon",
        [0xff, 0xd8, 0xff, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ if std::str::from_utf8(&data).is_ok_and(|text| text.contains("<svg")) => "image/svg+xml",
        _ => return Err(NOT_IMAGE),
    };
    Ok((mime, data))
}

/// The site icon under the shell's caching policy: the URL stays while the
/// bytes change. An SVG opened directly is a document at the hub's origin, so
/// the sandbox keeps any script in it from running there; as an icon or `<img>`
/// it never runs scripts anyway.
fn icon(path: &str, mime: &'static str, data: Vec<u8>, known: Option<&str>) -> Response {
    let mut response = asset(path, data, known);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, header::HeaderValue::from_static("nosniff"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
    );
    response
}

fn is_api_path(path: &str) -> bool {
    path == "api" || path.starts_with("api/")
}

/// Everything a build writes under `assets/` carries a content hash, so a miss
/// there is a request for a file that no longer exists, never a route. Falling
/// back to index.html would answer a script tag with HTML, which the browser
/// rejects on MIME type. The same hashed names let `asset` mark these
/// immutable for a year; both decisions read the prefix from here.
fn is_asset(path: &str) -> bool {
    path.starts_with("assets/")
}

/// Rewrites the shell, `index.html`, on its way out; see [`stamp_icons`].
type Shell<'a> = &'a dyn Fn(Vec<u8>) -> Vec<u8>;

fn page(path: &str, data: Vec<u8>, known: Option<&str>, shell: Shell) -> Response {
    asset(path, if path == "index.html" { shell(data) } else { data }, known)
}

fn embedded<T: RustEmbed>(requested: &str, remedy: &str, known: Option<&str>, shell: Shell) -> Response {
    let path = if requested.is_empty() { "index.html" } else { requested };
    if let Some(file) = T::get(path) {
        return page(path, file.data.into_owned(), known, shell);
    }
    if is_asset(path) {
        return answer(StatusCode::NOT_FOUND, format!("没有这个文件：/{path}"));
    }
    match T::get("index.html") {
        Some(index) => page("index.html", index.data.into_owned(), known, shell),
        None => answer(StatusCode::NOT_FOUND, remedy),
    }
}

/// Sent with every document this origin serves. `script-src 'self'` is the one
/// that earns its keep: both bundles load nothing from elsewhere, so a
/// dependency that injected an external script would be blocked rather than
/// run. `'unsafe-inline'` is needed for styles alone -- React writes them as
/// style attributes, which CSP counts as inline -- and not for scripts.
///
/// `ws:` and `wss:` are named because `'self'` matches the page's own http(s)
/// origin only, while the live feed opens a WebSocket, a scheme of its own.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
     img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; \
     base-uri 'none'; form-action 'self'";

/// Serves one file with the caching policy its path warrants.
///
/// Hashed names under `assets/` are immutable for a year: the browser never
/// revalidates, so an ETag there would serve no purpose.
///
/// Everything else is the SPA shell, served `no-cache` because its bytes change
/// under the same URL -- a new hub build, or the public page switched to
/// another theme. Without a validator every request would re-send the whole
/// shell, which invites a timed `s-maxage` at the CDN and makes a theme switch
/// take a minute to appear. With one, revalidation costs a 304 and the switch
/// lands on the next request.
fn asset(path: &str, data: Vec<u8>, known: Option<&str>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if is_asset(path) {
        let cache = "public, max-age=31536000, immutable";
        return ([(header::CONTENT_TYPE, mime.as_ref()), (header::CACHE_CONTROL, cache)], data)
            .into_response();
    }
    // Half a SHA-256 of the body, and therefore a strong validator: equal
    // digests mean identical shells.
    let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&data))[..32]);
    let headers = [
        (header::CONTENT_TYPE, mime.as_ref()),
        (header::CACHE_CONTROL, "no-cache"),
        (header::ETAG, etag.as_str()),
        // A document here may not be framed, which is what keeps a panel's
        // delete and restore buttons from being clicked through an invisible
        // iframe laid over someone else's page.
        (header::CONTENT_SECURITY_POLICY, CSP),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
    ];
    if known == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    (headers, data).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell changes under a fixed URL -- a hub upgrade brings a new build --
    /// so it revalidates. The validator keeps that from costing the whole file
    /// and makes the new build land on the next request rather than when a
    /// proxy's timer expires.
    #[test]
    fn the_spa_shell_revalidates_by_etag_and_a_hashed_asset_carries_none() {
        let etag = |r: &Response| r.headers().get(header::ETAG).map(|v| v.to_str().unwrap().to_owned());

        let first = asset("index.html", b"<html>default</html>".to_vec(), None);
        assert_eq!(first.status(), StatusCode::OK);
        let tag = etag(&first).expect("the shell must carry a validator");

        // The same shell, and the browser states which it holds: nothing to send.
        let again = asset("index.html", b"<html>default</html>".to_vec(), Some(&tag));
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);

        // A rebuilt shell: same URL, same request header, different bytes, so
        // the tag moved with them and the response is the new one.
        let switched = asset("index.html", b"<html>demo</html>".to_vec(), Some(&tag));
        assert_eq!(switched.status(), StatusCode::OK);
        assert_ne!(etag(&switched), Some(tag));

        // A hashed name is immutable for a year: the browser never revalidates,
        // so computing a digest for it would serve no purpose.
        let hashed = asset("assets/index-CSjcYfL9.js", b"console.log(1)".to_vec(), None);
        assert_eq!(hashed.status(), StatusCode::OK);
        assert_eq!(etag(&hashed), None);
    }

    /// The shell is framed by nobody and loads only what it shipped with.
    /// Asserted because neither header has a visible symptom when it goes
    /// missing: the page works exactly the same until someone embeds it.
    #[test]
    fn a_served_document_forbids_framing_and_foreign_scripts() {
        let response = asset("index.html", b"<html></html>".to_vec(), None);
        let headers = response.headers();
        let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("script-src 'self'"), "{csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
        // The live feed is a WebSocket, whose scheme `'self'` does not cover.
        assert!(csp.contains("ws:") && csp.contains("wss:"), "{csp}");
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");

        // A hashed asset is loaded by the shell rather than framed itself, and
        // its name is already immutable: a policy there would cost bytes only.
        let hashed = asset("assets/index-CSjcYfL9.js", b"console.log(1)".to_vec(), None);
        assert!(!hashed.headers().contains_key(header::CONTENT_SECURITY_POLICY));
    }

    /// The bytes decide the type, whatever the data URL declares, and anything
    /// that is not one of the image formats is refused before it is stored.
    #[test]
    fn a_site_icon_is_typed_by_its_bytes() {
        use base64::Engine;
        let url = |declared: &str, data: &[u8]| {
            format!("data:image/{declared};base64,{}", base64::engine::general_purpose::STANDARD.encode(data))
        };
        let png = b"\x89PNG\r\n\x1a\n....";
        assert_eq!(site_icon(&url("png", png)).unwrap(), ("image/png", png.to_vec()));
        assert_eq!(site_icon(&url("x-icon", b"\0\0\x01\0rest")).unwrap().0, "image/x-icon");
        assert_eq!(
            site_icon(&url("png", b"<svg xmlns='http://www.w3.org/2000/svg'/>")).unwrap().0,
            "image/svg+xml"
        );
        assert_eq!(site_icon(&url("webp", b"RIFF\0\0\0\0WEBPVP8 ")).unwrap().0, "image/webp");

        assert!(site_icon(&url("png", b"<html><script>")).is_err());
        assert!(site_icon("data:text/html;base64,PHN2Zz4=").is_err());
        assert!(site_icon("data:image/png;base64,not base64!").is_err());
        assert!(site_icon(&url("png", &[png.as_slice(), &[0; MAX_ICON]].concat())).is_err());

        let served = icon("favicon.svg", "image/png", png.to_vec(), None);
        assert_eq!(served.headers()[header::CONTENT_TYPE], "image/png");
        assert!(served.headers().contains_key(header::ETAG));
        assert!(served.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("sandbox"));
    }

    /// The shell names each icon after the bytes served for it, so a changed
    /// icon is a new URL: Chrome does not refetch a tab icon it already holds on
    /// an ordinary navigation.
    #[test]
    fn the_shell_names_each_icon_after_what_it_serves() {
        let app = App::for_test(crate::db::Db::open(":memory:").unwrap());
        let html = br#"<link rel="icon" href="/favicon.svg" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" />"#;
        let shell = || String::from_utf8(stamp_icons(&app, html.to_vec())).unwrap();
        let before = shell();
        assert!(
            before.contains(r#"href="/favicon.svg?v="#)
                && before.contains(r#"href="/apple-touch-icon.png?v="#)
        );
        assert_eq!(shell(), before, "the same bytes, the same URL");

        app.db.set("favicon", "data:image/png;base64,iVBORw0KGgo=").unwrap();
        let after = shell();
        assert_ne!(after, before);
        // Only the icon that changed moves.
        let touch = |html: &str| html.split("apple-touch-icon.png").nth(1).unwrap().to_owned();
        assert_eq!(touch(&after), touch(&before));
    }
}
