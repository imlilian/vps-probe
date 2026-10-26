#!/bin/sh
# Materialises the default theme from its source tree (web-site/, sibling of
# web-admin/ and embedded the same way) into target/theme/, where rust-embed
# picks it up.
#
# Called by build.rs. The theme is a build input of the hub binary, so nothing
# is downloaded: a changed source tree re-runs `npm run build` and re-syncs;
# an unchanged tree is a no-op, which keeps plain `cargo build` fast.
#
# Escape hatch: a dist/ manually placed in the source tree with no prior sync
# is used as-is (same tolerance the old download script had). With no dist/
# at all the build fails with instructions.
set -eu

cd "$(dirname "$0")/.."
SRC=web-site
DEST=target/theme

[ -f "$SRC/package.json" ] ||
  { echo "theme source $SRC is missing package.json" >&2; exit 1; }

# Stamp: hash of everything that feeds the vite build (node_modules/ and
# dist/ excluded). A match against target/theme/.pin means the last sync
# already covered exactly this source state.
STAMP=$(find "$SRC" -type f \
  -not -path "$SRC/node_modules/*" \
  -not -path "$SRC/dist/*" \
  | LC_ALL=C sort | xargs -r sha256sum | sha256sum | cut -d' ' -f1)

PIN=$(cat "$DEST/.pin" 2>/dev/null || true)
if [ "$PIN" = "$STAMP" ]; then
  exit 0
fi

# dist/ absent, or the source changed since the last sync: rebuild it.
if [ ! -f "$SRC/dist/index.html" ] || [ -n "$PIN" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "theme source changed (or dist/ absent): rebuilding $SRC" >&2
    (cd "$SRC" && npm run build) ||
      { echo "npm run build failed in $SRC" >&2; exit 1; }
  elif [ -f "$SRC/dist/index.html" ]; then
    echo "warning: npm not found; embedding the existing $SRC/dist (possibly stale)" >&2
  else
    echo "$SRC/dist/index.html does not exist and npm is unavailable." >&2
    echo "build the theme first:  (cd $SRC && npm install && npm run build)" >&2
    exit 1
  fi
fi
# else: no .pin but dist/ exists -- a manually built theme, used as-is.

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/dist" "$DEST/dist"

# dist/ is all frontend.rs embeds. A build that produced no shell embeds
# nothing, and the public page would answer 404 until the next sync.
if [ ! -f "$DEST/dist/index.html" ]; then
  echo "theme build produced no dist/index.html" >&2
  exit 1
fi

printf '%s\n' "$STAMP" >"$DEST/.pin"
echo "default theme synced from $SRC into $DEST"
