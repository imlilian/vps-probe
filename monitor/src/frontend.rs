//! Built-in admin UI. The public page is a single built-in theme, embedded the
//! same way: nothing here reads a theme from disk or installs one.
//!
//! TEMPORARY: the archive-handling half of this module (`install`, `unpack`,
//! `publish`, `remove`, `preview` and their limits) no longer has a caller since
//! the theme market was removed. Phase 3 deletes it together with the `tar` and
//! `flate2` dependencies; until then its dead code is silenced here rather than
//! item by item, so a real warning cannot hide among them.
#![allow(dead_code)]

use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::api::answer;
use crate::auth::random_token;
use crate::{App, Shared};

#[derive(RustEmbed)]
#[folder = "web-admin/dist"]
struct AdminAssets;

#[derive(RustEmbed)]
#[folder = "target/theme/dist"]
struct DefaultThemeAssets;

/// The built-in theme's thumbnail, which sits beside `theme.json` rather than
/// inside `dist/` and so is not among the assets above. The file is optional in
/// a theme package: a package without one embeds nothing here and the panel
/// shows the card without an image.
#[derive(RustEmbed)]
#[folder = "target/theme"]
#[include = "preview.png"]
struct DefaultPreview;

#[derive(Clone, Deserialize, Serialize)]
pub struct Theme {
    pub name: String,
    pub short: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub url: String,
    /// The settings form the panel draws for this theme. Passed through
    /// unparsed: a malformed field costs that one field in the panel rather than
    /// removing the whole theme from the list, and a hub predating the field
    /// ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub selected: bool,
    /// Set only for the copy embedded in the binary. Never read from a manifest:
    /// a theme installed on disk cannot present itself as the one that cannot be
    /// deleted.
    #[serde(skip_deserializing)]
    pub builtin: bool,
    /// Whether [`preview`] has an image for it. Filled in for the panel's list
    /// only, so it lays each card out once rather than when the image arrives.
    #[serde(skip_deserializing)]
    pub preview: bool,
}

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
    ];
    if known == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    (headers, data).into_response()
}

/// Reads only regular files whose canonical path remains below `root`.
/// Canonicalizing both sides also rejects symlinks that point outside it.
fn read_inside(root: &Path, relative: &str) -> Option<Vec<u8>> {
    let root = root.canonicalize().ok()?;
    let file = root.join(relative).canonicalize().ok()?;
    if !file.starts_with(&root) || !file.is_file() {
        return None;
    }
    fs::read(file).ok()
}

// ---- installing a theme from an uploaded archive ----

/// Whether a short names a directory under `<themes>`, which rules out an empty
/// name and anything carrying a path separator.
///
/// Only the install path asks this now: the panel stopped naming themes when the
/// market was removed. Phase 3 deletes it with the rest of the archive handling.
fn valid_short(short: &str) -> bool {
    !short.is_empty() && short.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Limits on what one archive may expand to. A gz stream conceals its ratio
/// behind the 32 MiB upload ceiling, so the expanded total is gated in its own
/// right rather than as a multiple of the input; the entry count and per-file
/// size bound the other two forms a decompression bomb takes.
const MAX_ENTRIES: usize = 2_000;
const MAX_FILE: u64 = 8 << 20;
const MAX_EXPANDED: u64 = 64 << 20;

/// What may follow tar's end marker, which is padding to a whole record: 10 KiB
/// by default, and a mebibyte covers any blocking factor in use. Unbounded,
/// zeros there would inflate at 1 GiB per MiB uploaded, 1.4 s of CPU each.
const MAX_PADDING: u64 = 1 << 20;

/// Every byte the gzip stream may expand to, headers included. tar reads a GNU
/// long name or pax header into memory whole, under the size the header itself
/// declares, before `unpack` sees an entry: a 397 KiB upload declaring 400 MiB
/// would have taken the hub from 10 to 414 MiB resident. 8 MiB covers the
/// headers and block padding of [`MAX_ENTRIES`] entries, one extension header
/// each, twice over.
const MAX_STREAM: u64 = MAX_EXPANDED + MAX_PADDING + (8 << 20);

/// Installs a theme from its published `theme.tar.gz`, under the name its own
/// manifest carries.
///
/// Nothing reaches `<themes>/<short>` until the archive has been fully unpacked
/// and validated. Work lands in a sibling directory whose name `valid_short`
/// rejects, so a partially written theme is invisible to both `themes()` and
/// `serve`, and publishing is a single rename: the public page is never served
/// from an incomplete directory. A theme being replaced is renamed aside rather
/// than deleted, and restored if the publish cannot complete.
///
/// `expect` names the short the caller is replacing, where one is specified: an
/// upload installs whatever it carries, an update may not.
pub fn install<R: Read>(themes: &Path, archive: R, expect: Option<&str>) -> Result<Theme> {
    let staging = themes.join(format!(".staging-{}", &random_token()[..16]));
    let installed = unpack(archive, &staging).and_then(|()| publish(themes, &staging, expect));
    if installed.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    installed
}

/// The answer to any archive that cannot be read to the end: a download cut
/// short, which is how a partial `theme.tar.gz` fails, or a gzip stream that is
/// corrupt or holds no tar.
const DAMAGED: &str = "主题包损坏或不完整（可能没下载完），重新下载 theme.tar.gz 再试";

/// The answer to an archive whose entries cannot all be written: a file and a
/// directory under one name, or a name the filesystem refuses.
const TANGLED: &str = "主题包里有同名的文件和目录，或者文件名过长，包本身有问题，请联系主题作者";

/// The answer to a file that is not gzip at all, most often the release's
/// Source code zip. Reported as [`DAMAGED`], it would direct the reader to
/// download the same wrong file again.
const NOT_GZIP: &str = "选的不是主题包：到主题仓库的 Releases 下载 theme.tar.gz，不要选 Source code";

/// The first two bytes of every gzip stream.
pub const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Tells a failure the archive caused from one of this machine's. Reading fails
/// with `UnexpectedEof` where the stream stops short and `InvalidInput` for a
/// corrupt one; a layout that cannot be written fails with the
/// second group. Anything else -- a full disk, a permission -- is this machine's
/// to fix.
fn archive_error(e: std::io::Error) -> anyhow::Error {
    use std::io::ErrorKind::*;
    let shown = match e.kind() {
        UnexpectedEof | InvalidInput | InvalidData => DAMAGED,
        NotADirectory | IsADirectory | AlreadyExists | InvalidFilename => TANGLED,
        _ => return e.into(),
    };
    anyhow::Error::from(e).context(crate::Shown(shown.into()))
}

fn unpack<R: Read>(archive: R, into: &Path) -> Result<()> {
    let mut archive = std::io::BufReader::new(archive);
    if !std::io::BufRead::fill_buf(&mut archive)?.starts_with(&GZIP_MAGIC) {
        refuse!("{NOT_GZIP}");
    }
    fs::create_dir(into)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(archive).take(MAX_STREAM));
    // Modes come from the packer's machine: a theme packed under umask 000
    // would otherwise leave scripts the panel runs writable by every local user.
    archive.set_mask(0o022);
    let entries = unpack_entries(&mut archive, into);
    let mut rest = archive.into_inner();
    // Read to the end, where gzip keeps its checksum. The entries stop at tar's
    // end marker, short of it, so otherwise an archive whose bytes changed in
    // transit would install as long as its headers survived.
    let mut tail = 0;
    if entries.is_ok() {
        std::io::copy(&mut (&mut rest).take(MAX_PADDING), &mut std::io::sink()).map_err(archive_error)?;
        tail = rest.read(&mut [0]).map_err(archive_error)?;
    }
    // Ahead of the entries' error: a stream cut off by the budget reads as
    // truncated, and that answer would send the reader to download it again.
    if rest.limit() == 0 {
        refuse!("主题包解压后超过 {} MiB", MAX_EXPANDED >> 20);
    }
    entries?;
    if tail != 0 {
        refuse!("主题包在 tar 结尾之后还有超过 1 MiB 的数据，包本身有问题，请联系主题作者");
    }
    Ok(())
}

fn unpack_entries<R: Read>(archive: &mut tar::Archive<R>, into: &Path) -> Result<()> {
    let mut expanded = 0u64;
    // Every directory the entries create, named or not: unpacking a file
    // creates each missing parent, so one entry 1000 levels deep writes 1000
    // directories.
    let (mut files, mut dirs) = (0, std::collections::HashSet::new());
    for (seen, entry) in archive.entries()?.enumerate() {
        // Only reading happens here, so every failure is the archive's.
        let mut entry = entry.context(crate::Shown(DAMAGED.into()))?;
        if seen >= MAX_ENTRIES {
            refuse!("主题包里的条目超过 {MAX_ENTRIES} 个");
        }
        // Only the entry types a theme consists of. A symlink, hard link or
        // device node belongs in none, and each is a route to writing where the
        // path check below cannot see.
        let kind = entry.header().entry_type();
        // Also a pax global header: metadata that writes nothing, which
        // `git archive` and GitHub's Source code archives open with. Refusing
        // it would hide the answer that names the right file to download.
        let metadata = kind.is_pax_global_extensions();
        if !kind.is_file() && !kind.is_dir() && !metadata {
            refuse!("主题包里有不支持的条目：{}", entry.path()?.display());
        }
        let size = entry.size();
        if size > MAX_FILE {
            refuse!("{} 超过单个文件 {} MiB 的上限", entry.path()?.display(), MAX_FILE >> 20);
        }
        // Subtraction, because summing two entry sizes can overflow; `size` is
        // already known to be the smaller of the two.
        if expanded > MAX_EXPANDED - size {
            refuse!("主题包解压后超过 {} MiB", MAX_EXPANDED >> 20);
        }
        expanded += size;
        if metadata {
            continue;
        }
        let path = entry.path()?.into_owned();
        // Beyond what Linux takes in one call, so unpacking would fail anyway.
        // Refused before counting, which copies the path of every parent: a
        // name tens of KiB of `a/` long would otherwise take gigabytes.
        if path.as_os_str().len() > 4096 {
            refuse!("主题包里的路径过长");
        }
        files += usize::from(kind.is_file());
        let mut dir = if kind.is_dir() { Some(path.as_path()) } else { path.parent() };
        // A directory already counted brings its parents with it.
        while let Some(d) = dir.filter(|d| d.file_name().is_some() && dirs.insert(d.to_path_buf())) {
            dir = d.parent();
        }
        if files + dirs.len() > MAX_ENTRIES {
            refuse!("主题包里的文件和目录超过 {MAX_ENTRIES} 个");
        }
        // Rejects an entry whose path escapes `into` -- absolute, `..`, or via
        // a symlinked parent -- reporting `false` rather than an error.
        if !entry.unpack_in(into).map_err(archive_error)? {
            refuse!("主题包里的路径越出了主题目录");
        }
    }
    Ok(())
}

/// Checks the unpacked directory is a theme this hub can actually serve, then
/// moves it into place under the name its manifest asks for.
fn publish(themes: &Path, staging: &Path, expect: Option<&str>) -> Result<Theme> {
    // Source code (tar.gz) is gzip'd too, and nests everything one directory
    // down, so it fails here rather than at the magic bytes.
    let Some(manifest) = read_inside(staging, "theme.json") else {
        refuse!("主题包里没有 theme.json，下载的若是 Source code，换成 Releases 里的 theme.tar.gz")
    };
    if manifest.len() > 64 * 1024 {
        refuse!("theme.json 过大");
    }
    let theme: Theme =
        serde_json::from_slice(&manifest).context(crate::Shown("theme.json 格式不对".into()))?;
    if !valid_short(&theme.short) {
        refuse!("theme.json 里的 short 不能作为目录名：{:?}", theme.short);
    }
    // An update replaces the theme it was invoked for. A package whose manifest
    // carries a different `short` would instead install a second theme, or
    // overwrite an unrelated one, while reporting success for the update.
    if let Some(expected) = expect.filter(|&expected| expected != theme.short) {
        refuse!("这个包里是主题 {:?}，不是 {expected:?}", theme.short);
    }
    // The one file `serve` requires. Without it every request falls through to
    // the built-in theme, indistinguishable from the upload having no effect.
    if !staging.join("dist").join("index.html").is_file() {
        refuse!("主题包里没有 dist/index.html");
    }

    let destination = themes.join(&theme.short);
    let replaced = themes.join(format!(".replaced-{}", &random_token()[..16]));
    let replacing = destination.exists();
    if replacing {
        fs::rename(&destination, &replaced)?;
    }
    match fs::rename(staging, &destination) {
        Ok(()) => {
            if replacing {
                let _ = fs::remove_dir_all(&replaced);
            }
            Ok(theme)
        }
        Err(e) => {
            // Restore whatever was being served.
            if replacing {
                let _ = fs::rename(&replaced, &destination);
            }
            Err(e.into())
        }
    }
}

/// The panel's thumbnail for one theme: an optional `preview.png` beside
/// `theme.json`, outside `dist/` because it is metadata rather than content the
/// theme serves.
///
/// The name is a constant rather than a manifest field, so the path never
/// originates from the archive and has nothing to escape through. The size
/// check is repeated here because a theme copied directly into the directory
/// never passed through `unpack`.
pub fn preview(themes: &Path, short: &str) -> Option<Vec<u8>> {
    if !valid_short(short) {
        return None;
    }
    let root = themes.join(short);
    if let Ok(meta) = fs::metadata(root.join(PREVIEW)) {
        return (meta.len() <= MAX_FILE).then(|| read_inside(&root, PREVIEW)).flatten();
    }
    // No directory, or one carrying no thumbnail of its own: the built-in theme
    // has its own embedded beside the assets it serves.
    (short == "default").then(|| DefaultPreview::get(PREVIEW).map(|file| file.data.into_owned())).flatten()
}

const PREVIEW: &str = "preview.png";

/// Deletes an installed theme, including an installed copy of the built-in one,
/// which leaves the embedded copy serving in its place. The embedded copy itself
/// has no directory and so cannot be targeted. Deleting the currently selected
/// theme is permitted: `serve` falls back to the built-in one from the next
/// request, the same path a broken theme already takes.
pub fn remove(themes: &Path, short: &str) -> Result<()> {
    if !valid_short(short) {
        refuse!("没有这个主题");
    }
    let base = themes.canonicalize()?;
    // Already gone, as when two panels delete the same theme.
    let Ok(root) = base.join(short).canonicalize() else { refuse!("没有这个主题") };
    // Canonical on both sides: a symlink leading out of the themes directory
    // must not be deleted through.
    if !root.starts_with(&base) || !root.is_dir() {
        refuse!("没有这个主题");
    }
    fs::remove_dir_all(root)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_files_cannot_escape_their_dist_directory() {
        let tmp = crate::TempDir::new("theme-path-test");
        let base = tmp.0.clone();
        let dist = base.join("theme/dist");
        fs::create_dir_all(dist.join("assets")).unwrap();
        fs::write(dist.join("index.html"), "index").unwrap();
        fs::write(dist.join("assets/app.js"), "safe").unwrap();
        fs::write(base.join("secret"), "secret").unwrap();

        assert_eq!(read_inside(&dist, "assets/app.js").unwrap(), b"safe");
        assert!(read_inside(&dist, "../../secret").is_none());
        assert!(read_inside(&dist, "/etc/passwd").is_none());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret"), dist.join("assets/link")).unwrap();
            assert!(read_inside(&dist, "assets/link").is_none());
        }
    }

    /// The per-file and total ceilings hold at their exact boundary: a file of
    /// [`MAX_FILE`] and a total of [`MAX_EXPANDED`] install, one byte more does not.
    #[test]
    fn a_package_at_the_size_ceilings_installs_and_one_byte_past_does_not() {
        let tmp = crate::TempDir::new("ceilings");
        let base = tmp.0.clone();
        let manifest = r#"{"name":"x","short":"x","description":"","version":"1","author":"a","url":""}"#;
        let pack = |sizes: &[u64]| {
            let mut tar =
                tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
            // A directory entry, as `tar czf` writes one for every directory.
            let mut dir = tar::Header::new_gnu();
            dir.set_entry_type(tar::EntryType::Directory);
            dir.set_size(0);
            dir.set_mode(0o755);
            tar.append_data(&mut dir, "dist/", &[][..]).unwrap();
            let mut add = |name: &str, data: &[u8]| {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                tar.append_data(&mut header, name, data).unwrap();
            };
            add("theme.json", manifest.as_bytes());
            add("dist/index.html", b"x");
            for (i, &size) in sizes.iter().enumerate() {
                add(&format!("dist/{i}.bin"), &vec![0; size as usize]);
            }
            tar.into_inner().unwrap().finish().unwrap()
        };
        let headroom = MAX_EXPANDED - (manifest.len() as u64 + 1);
        let refused = |sizes: &[u64]| install(&base, &pack(sizes)[..], None).is_err();
        assert!(!refused(&[MAX_FILE]));
        assert!(refused(&[MAX_FILE + 1]));
        let full = [MAX_FILE; 7].into_iter().chain([headroom - 7 * MAX_FILE]).collect::<Vec<_>>();
        assert!(!refused(&full));
        assert!(refused(&[full.as_slice(), &[1]].concat()));
    }

    /// The shell changes under a fixed URL -- a new build, or the public page
    /// switched to another theme -- so it revalidates. The validator keeps that
    /// from costing the whole file and makes a switch land on the next request
    /// rather than when a proxy's timer expires.
    #[test]
    fn the_spa_shell_revalidates_by_etag_and_a_hashed_asset_carries_none() {
        let etag = |r: &Response| r.headers().get(header::ETAG).map(|v| v.to_str().unwrap().to_owned());

        let first = asset("index.html", b"<html>default</html>".to_vec(), None);
        assert_eq!(first.status(), StatusCode::OK);
        let tag = etag(&first).expect("the shell must carry a validator");

        // The same shell, and the browser states which it holds: nothing to send.
        let again = asset("index.html", b"<html>default</html>".to_vec(), Some(&tag));
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);

        // A switched theme: same URL, same request header, different bytes, so
        // the tag moved with them and the response is the new shell.
        let switched = asset("index.html", b"<html>demo</html>".to_vec(), Some(&tag));
        assert_eq!(switched.status(), StatusCode::OK);
        assert_ne!(etag(&switched), Some(tag));

        // A hashed name is immutable for a year: the browser never revalidates,
        // so computing a digest for it would serve no purpose.
        let hashed = asset("assets/index-CSjcYfL9.js", b"console.log(1)".to_vec(), None);
        assert_eq!(hashed.status(), StatusCode::OK);
        assert_eq!(etag(&hashed), None);
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

    /// A symlink in the themes directory that leads out of it is refused, and
    /// what it leads to survives.
    #[test]
    fn removing_a_theme_stays_inside_the_themes_directory() {
        let tmp = crate::TempDir::new("remove");
        let base = tmp.0.clone();
        let (themes, outside) = (base.join("themes"), base.join("outside"));
        fs::create_dir_all(themes.join("aurora")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, themes.join("elsewhere")).unwrap();

        assert!(remove(&themes, "elsewhere").is_err());
        assert!(outside.exists(), "the symlink's target survives");
        remove(&themes, "aurora").unwrap();
        assert!(!themes.join("aurora").exists());
    }
}
