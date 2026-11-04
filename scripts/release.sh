#!/bin/sh
# Bumps the version of whichever components this release changes, commits it --
# and stops there, because pushing and tagging are separate decisions.
#
# A tag is only the release's sequence number; it no longer has to equal any
# component's version. hub/Cargo.toml and agent/Cargo.toml each move only
# when their own code does, and a release whose component stayed put inherits
# that component's previous binary (release.yml compares against the previous
# release's versions.json). Missing a bump is not a failure: the next release
# fixes it. This script only warns when an unselected component has changed
# since the last tag.
#
#   scripts/release.sh 0.2.2            bump both, commit
#   scripts/release.sh HUB=0.2.2        bump hub only
#   scripts/release.sh AGENT=0.2.2      bump agent only
#   scripts/release.sh HUB=0.2.2 AGENT=0.2.3   each to its own number
#
# Nothing is pushed and nothing is tagged here: the bump commit must pass CI
# first, and only the person who pushed knows when that gate is green. The
# commands are printed at the end, with the next tag's number already worked
# out (the largest existing tag's patch, plus one -- the tag is never a
# component version on purpose).
#
#   scripts/release.sh 0.2.2 --dry-run  show what would change, touch nothing
#   scripts/release.sh HUB=0.2.2 --force  skip the "unchanged component changed
#                                           since the last tag" warning
set -eu
cd "$(dirname "$0")/.."

DRY=no
FORCE=no
BUMP_HUB=no
BUMP_AGENT=no
HUB_VER=
AGENT_VER=
for arg in "$@"; do
  case $arg in
    --dry-run) DRY=yes ;;
    --force) FORCE=yes ;;
    -h | --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    HUB=*) BUMP_HUB=yes; HUB_VER=${arg#HUB=}; HUB_VER=${HUB_VER#v} ;;
    AGENT=*) BUMP_AGENT=yes; AGENT_VER=${arg#AGENT=}; AGENT_VER=${AGENT_VER#v} ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) BUMP_HUB=yes; BUMP_AGENT=yes; HUB_VER=${arg#v}; AGENT_VER=${arg#v} ;;
  esac
done

if [ "$BUMP_HUB" = no ] && [ "$BUMP_AGENT" = no ]; then
  echo "usage: scripts/release.sh <x.y.z> | HUB=<x.y.z> | AGENT=<x.y.z> [HUB=… AGENT=…] [--dry-run] [--force]" >&2
  exit 2
fi

valid() {
  case $1 in
    *[!0-9.]* | . | *. | *..* | "") return 1 ;;
  esac
  [ "$(printf '%s' "$1" | awk -F. '{ print NF }')" = 3 ] || return 1
  return 0
}

for pair in "hub:$BUMP_HUB:$HUB_VER" "agent:$BUMP_AGENT:$AGENT_VER"; do
  crate=${pair%%:*}; rest=${pair#*:}
  bump=${rest%%:*}; ver=${rest#*:}
  if [ "$bump" = yes ]; then
    valid "$ver" || { echo "$crate 的版本号要写成 x.y.z（v 前缀可有可无）：${ver:-（空）}" >&2; exit 2; }
  fi
done

hub_old=$(awk -F'"' '/^version = "/ { print $2; exit }' hub/Cargo.toml)
agent_old=$(awk -F'"' '/^version = "/ { print $2; exit }' agent/Cargo.toml)

# A v* tag can be neither moved nor deleted, so the number must never be taken
# twice. The check stays even though tag and version are decoupled: a component
# version is still what the panel and the changelog compare against.
tag_exists() {
  git rev-parse -q --verify "refs/tags/v$1" >/dev/null 2>&1 && return 0
  [ -n "$(git ls-remote --tags --refs origin "refs/tags/v$1" 2>/dev/null)" ]
}

# Only forward: a version that goes backwards can only be a typo, and after the
# tag exists there is no way to take it back.
forward() {
  if [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; then
    echo "$3/Cargo.toml is already $1; a release only moves forward" >&2
    exit 1
  fi
}

if [ "$BUMP_HUB" = yes ]; then
  [ "$HUB_VER" = "$hub_old" ] && { echo "hub is already at $HUB_VER: nothing to bump" >&2; exit 1; }
  tag_exists "$HUB_VER" && { echo "tag v$HUB_VER already exists; a published tag cannot be moved" >&2; exit 1; }
  forward "$hub_old" "$HUB_VER" hub
fi
if [ "$BUMP_AGENT" = yes ]; then
  [ "$AGENT_VER" = "$agent_old" ] && { echo "agent is already at $AGENT_VER: nothing to bump" >&2; exit 1; }
  tag_exists "$AGENT_VER" && { echo "tag v$AGENT_VER already exists; a published tag cannot be moved" >&2; exit 1; }
  forward "$agent_old" "$AGENT_VER" agent
fi

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

# Advisory, not a gate: a component left at its old version is inherited, so
# code that changed without a bump would ship as the old binary. Warned here
# and nowhere else -- release.yml checks nothing, on purpose.
LAST_TAG=$(git tag --list 'v*' | sort -V | tail -n1)
if [ "$FORCE" != yes ] && [ -n "$LAST_TAG" ]; then
  for crate in hub agent; do
    case $crate in
      hub) bump=$BUMP_HUB ;;
      agent) bump=$BUMP_AGENT ;;
    esac
    if [ "$bump" = no ] && [ -n "$(git diff --name-only "$LAST_TAG"..HEAD -- "$crate/")" ]; then
      echo "warning: $crate/ has changes since $LAST_TAG but its version was not bumped:" >&2
      echo "         this release would publish $crate's previous binary unchanged." >&2
      if [ "$crate" = hub ]; then
        echo "         若属遗漏，请中止后改用：scripts/release.sh HUB=<新号> [AGENT=<新号>]" >&2
      else
        echo "         若属遗漏，请中止后改用：scripts/release.sh AGENT=<新号> [HUB=<新号>]" >&2
      fi
      echo "         （--force 跳过此警告）5 秒后继续……" >&2
      sleep 5
    fi
  done
fi

# The first `version = "..."` in a manifest is the package's: `[package]` comes
# before every dependency table. Rewritten through a temporary file rather than
# `sed -i`, whose syntax differs between GNU and BSD.
bump_crate() {
  crate=$1; ver=$2
  awk -v v="$ver" '
    !done && /^version = "/ { print "version = \"" v "\""; done = 1; next }
    { print }
  ' "$crate/Cargo.toml" >"$crate/Cargo.toml.tmp"
  mv "$crate/Cargo.toml.tmp" "$crate/Cargo.toml"

  # The lock names its packages in `[[package]]` blocks: the version to rewrite
  # is the first one after this crate's `name`, not the one after a dependency's.
  name="probe-$crate"
  awk -v crate="$name" -v v="$ver" '
    $0 == "name = \"" crate "\"" { found = 1; print; next }
    found && /^version = "/ { print "version = \"" v "\""; found = 0; next }
    { print }
  ' "$crate/Cargo.lock" >"$crate/Cargo.lock.tmp"
  mv "$crate/Cargo.lock.tmp" "$crate/Cargo.lock"
}

[ "$BUMP_HUB" = yes ] && bump_crate hub "$HUB_VER"
[ "$BUMP_AGENT" = yes ] && bump_crate agent "$AGENT_VER"

# Verified rather than assumed: a Cargo.toml that did not move and a lock that
# still says the old number are exactly what `--locked` fails on, three minutes
# into a release nobody can retract.
for crate in hub agent; do
  case $crate in
    hub) bump=$BUMP_HUB; want=$HUB_VER ;;
    agent) bump=$BUMP_AGENT; want=$AGENT_VER ;;
  esac
  [ "$bump" = yes ] || continue
  name="probe-$crate"
  manifest=$(awk -F'"' '/^version = "/ { print $2; exit }' "$crate/Cargo.toml")
  locked=$(awk -v crate="$name" '
    $0 == "name = \"" crate "\"" { found = 1; next }
    found && /^version = "/ { split($0, p, "\""); print p[2]; exit }
  ' "$crate/Cargo.lock")
  [ "$manifest" = "$want" ] && [ "$locked" = "$want" ] || {
    echo "$crate is not at $want after the bump (manifest $manifest, lock $locked)" >&2
    exit 1
  }
done

echo "hub $hub_old -> $([ "$BUMP_HUB" = yes ] && echo "$HUB_VER" || echo 不变) · agent $agent_old -> $([ "$BUMP_AGENT" = yes ] && echo "$AGENT_VER" || echo 不变) on $BRANCH ($UPSTREAM)"

git --no-pager diff --stat
if [ "$DRY" = yes ]; then
  echo "dry run: nothing committed. Reverting with: git checkout -- hub/Cargo.* agent/Cargo.*"
  exit 0
fi

git add hub/Cargo.toml hub/Cargo.lock agent/Cargo.toml agent/Cargo.lock
# The trailing `|| true` is not decoration: a `[ ... ] && printf` that does not
# fire returns non-zero, and as the last command of the substitution it is what
# the assignment sees -- which `set -e` would take as fatal, before the commit.
msg=$(printf 'release:'
  { [ "$BUMP_HUB" = yes ] && printf ' hub %s' "$HUB_VER"; } || true
  { [ "$BUMP_AGENT" = yes ] && printf ' agent %s' "$AGENT_VER"; } || true)
git commit -q -m "$msg"

# The tag is this release's sequence number: the largest tag's patch, plus one.
# It deliberately has nothing to do with either component's version.
NEXT_TAG=v0.0.1
if [ -n "$LAST_TAG" ]; then
  NEXT_TAG=$(printf '%s' "$LAST_TAG" | awk -F. '{ print $1 "." $2 "." ($3 + 1) }')
fi

cat <<EOF

release commit is made. Nothing is pushed and nothing is tagged -- on purpose:

  1. git push
  2. wait for CI on $BRANCH to pass
  3. git tag $NEXT_TAG && git push origin $NEXT_TAG

Tag $NEXT_TAG is a sequence number only: it equals neither the hub's
($([ "$BUMP_HUB" = yes ] && echo "$HUB_VER" || echo "$hub_old")) nor
the agent's ($([ "$BUMP_AGENT" = yes ] && echo "$AGENT_VER" || echo "$agent_old"))
version, and must not be edited to match one.
EOF
