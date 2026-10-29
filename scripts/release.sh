#!/bin/sh
# Bumps the version both binaries will be released under, commits it and pushes
# it -- and stops there, because cutting the tag is a separate decision.
#
# One tag carries the hub and the agent, and .github/workflows/release.yml
# refuses a v* tag whose number disagrees with monitor/Cargo.toml or
# agent/Cargo.toml. A v* tag can be neither moved nor deleted, so the bump has to
# be on the remote as a commit before the tag is made. Bumped by hand it also
# left Cargo.lock behind at the old number, which `cross build --release
# --locked` in that same workflow rejects, so the locks are rewritten here too.
#
# The tag is not this script's job: the release commit must pass CI first, and
# only the person who pushed knows when that gate is green. The two commands are
# printed at the end.
#
#   scripts/release.sh 0.2.2            bump, commit, push
#   scripts/release.sh v0.2.2 --dry-run  show what would change, touch nothing
set -eu
cd "$(dirname "$0")/.."

CRATES="monitor agent"
DRY=no
VERSION=
for arg in "$@"; do
  case $arg in
    --dry-run) DRY=yes ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) VERSION=${arg#v} ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <x.y.z> [--dry-run]" >&2
  exit 2
fi
case $VERSION in
  *[!0-9.]* | .* | *. | *..*)
    echo "版本号要写成 x.y.z（v 前缀可有可无）：$VERSION" >&2
    exit 2
    ;;
esac

# The version every release so far has been one plain triple; anything else is a
# typo that would produce a tag no installer can compare against.
[ "$(printf '%s' "$VERSION" | awk -F. '{ print NF }')" = 3 ] || {
  echo "版本号要写成 x.y.z：$VERSION" >&2
  exit 2
}

OLD=$(awk -F'"' '/^version = "/ { print $2; exit }' monitor/Cargo.toml)
AGENT_OLD=$(awk -F'"' '/^version = "/ { print $2; exit }' agent/Cargo.toml)
[ "$OLD" = "$AGENT_OLD" ] ||
  echo "warning: monitor is $OLD, agent is $AGENT_OLD; both are set to $VERSION" >&2

if [ "$VERSION" = "$OLD" ]; then
  echo "already at $VERSION: nothing to bump" >&2
  exit 1
fi
# Only forward: a version that goes backwards can only be a typo, and after the
# tag exists there is no way to take it back.
if printf '%s\n%s\n' "$OLD" "$VERSION" | sort -V >/dev/null 2>&1; then
  if [ "$(printf '%s\n%s\n' "$OLD" "$VERSION" | sort -V | tail -n 1)" = "$OLD" ]; then
    echo "monitor/Cargo.toml is already $OLD; a release only moves forward" >&2
    exit 1
  fi
fi
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && {
  echo "tag v$VERSION already exists locally; a published tag cannot be moved" >&2
  exit 1
}
[ -z "$(git status --porcelain)" ] || {
  echo "working tree is not clean: commit or stash first, so the release commit is only the bump" >&2
  git status --short >&2
  exit 1
}
BRANCH=$(git rev-parse --abbrev-ref HEAD)
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || {
  echo "$BRANCH has no upstream: push it once with -u before releasing" >&2
  exit 1
}

echo "bumping $OLD -> $VERSION on $BRANCH ($UPSTREAM)"

# The first `version = "..."` in a manifest is the package's: `[package]` comes
# before every dependency table. Rewritten through a temporary file rather than
# `sed -i`, whose syntax differs between GNU and BSD.
for crate in $CRATES; do
  awk -v v="$VERSION" '
    !done && /^version = "/ { print "version = \"" v "\""; done = 1; next }
    { print }
  ' "$crate/Cargo.toml" >"$crate/Cargo.toml.tmp"
  mv "$crate/Cargo.toml.tmp" "$crate/Cargo.toml"

  # The lock names its packages in `[[package]]` blocks: the version to rewrite
  # is the first one after this crate's `name`, not the one after a dependency's.
  name=$([ "$crate" = monitor ] && echo probe-hub || echo probe-agent)
  awk -v crate="$name" -v v="$VERSION" '
    $0 == "name = \"" crate "\"" { found = 1; print; next }
    found && /^version = "/ { print "version = \"" v "\""; found = 0; next }
    { print }
  ' "$crate/Cargo.lock" >"$crate/Cargo.lock.tmp"
  mv "$crate/Cargo.lock.tmp" "$crate/Cargo.lock"
done

# Verified rather than assumed: a Cargo.toml that did not move and a lock that
# still says the old number are exactly what `--locked` fails on, three minutes
# into a release nobody can retract.
for crate in $CRATES; do
  name=$([ "$crate" = monitor ] && echo probe-hub || echo probe-agent)
  manifest=$(awk -F'"' '/^version = "/ { print $2; exit }' "$crate/Cargo.toml")
  locked=$(awk -v crate="$name" '
    $0 == "name = \"" crate "\"" { found = 1; next }
    found && /^version = "/ { split($0, p, "\""); print p[2]; exit }
  ' "$crate/Cargo.lock")
  [ "$manifest" = "$VERSION" ] && [ "$locked" = "$VERSION" ] || {
    echo "$crate is not at $VERSION after the bump (manifest $manifest, lock $locked)" >&2
    exit 1
  }
done

git --no-pager diff --stat
if [ "$DRY" = yes ]; then
  echo "dry run: nothing committed. Reverting with: git checkout -- monitor/Cargo.* agent/Cargo.*"
  exit 0
fi

git add monitor/Cargo.toml monitor/Cargo.lock agent/Cargo.toml agent/Cargo.lock
git commit -q -m "release: $VERSION"
# Named rather than a bare `git push`: the remote and branch were resolved above,
# and a bare push would follow whatever push.default the operator configured
# instead of putting this branch on its own upstream.
git push "${UPSTREAM%%/*}" "$BRANCH"

cat <<EOF

release: $VERSION is pushed. Nothing is tagged yet -- on purpose:

  1. wait for CI on $BRANCH to pass
  2. git tag v$VERSION && git push origin v$VERSION

The tag starts .github/workflows/release.yml, which refuses to build unless both
manifests say v$VERSION.
EOF
