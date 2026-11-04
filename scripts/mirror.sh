#!/bin/sh
# Mirrors one release into a directory of your own: every asset with its
# signature, a versions.json that names the tag and says where the assets are,
# and the installer.
#
#   scripts/mirror.sh --dest /srv/dl/vps-probe --public-base https://dl.example.com/vps-probe
#   scripts/mirror.sh --dest ./mirror --flat --tag v1.2.0 --source /srv/downloads
#
# Why a script rather than three commands in a runbook: two steps are easy to get
# wrong and both fail in a way that reads as something else entirely.
#
#   * a missing `.sig` is not "one file fewer". Every install and every relayed
#     agent verifies the binary against it, so the node reports 「签名校验不通过，已
#     丢弃下载的文件」 -- which reads like the mirror had been tampered with.
#   * a versions.json written without `download` points whoever reads it at the
#     directory the file itself is in, so a release kept under <tag>/ answers 404.
#
# Layout, and the reason for it: metadata wants one stable path, assets must never
# change under a URL that has already been published. So versions.json sits at the
# top of the mirror and the assets go under <tag>/, which `download` names.
#
#   <dest>/versions.json     Cache-Control: max-age=300
#   <dest>/<tag>/*           Cache-Control: public, max-age=31536000, immutable
#   <dest>/versions.json     and the rest of the mirror: no directory listing
#
# --flat puts the assets beside versions.json and omits `download`, which is the
# shape GitHub publishes -- one directory to point `install-hub.sh
# --release-base` at, at the cost of overwriting the previous release in place.
#
# The binaries are verified against the public key compiled into this project
# before anything is published: a truncated download, or a source that answered
# with an error page, fails here rather than on a customer's node. --no-verify
# skips it, for a source that is your own disk or your own previous mirror.
set -eu
cd "$(dirname "$0")/.."

REPO="imlilian/vps-probe"
SOURCE="https://github.com/$REPO/releases/latest/download"
DEST=""
PUBLIC_BASE=""
TAG=""
ARCHES="x86_64 aarch64"
FLAT=no
VERIFY=yes

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'TXT'

  --dest <dir>          mirror directory (required); created if missing
  --public-base <url>   the URL <dir> is served at, for the `download` field;
                        required unless --flat, which needs none
  --source <dir|url>    where to copy from: the official release page by default,
                        a directory (a previous mirror, a build host) or a URL
  --tag <tag>           the release to label; read from the source's versions.json
                        when it says
  --arches "x86_64 aarch64"   architectures to copy — both by default. A hub only
                        relays the architecture its nodes ask for, but the panel
                        offers both, and a 404 on one is a support question.
  --flat                assets beside versions.json, no `download` field
  --no-verify           skip the signature check (your own source, already checked)
  -h, --help            this text
TXT
}

die() {
  echo "mirror: $*" >&2
  exit 1
}
say() { printf '  %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) [ $# -ge 2 ] || die "--dest 后面要跟目录"; DEST="${2%/}"; shift 2 ;;
    --public-base) [ $# -ge 2 ] || die "--public-base 后面要跟地址"; PUBLIC_BASE="${2%/}"; shift 2 ;;
    --source) [ $# -ge 2 ] || die "--source 后面要跟目录或地址"; SOURCE="${2%/}"; shift 2 ;;
    --tag) [ $# -ge 2 ] || die "--tag 后面要跟标签"; TAG="${2%/}"; shift 2 ;;
    --arches) [ $# -ge 2 ] || die "--arches 后面要跟架构"; ARCHES="$2"; shift 2 ;;
    --flat) FLAT=yes; shift ;;
    --no-verify) VERIFY=no; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "未知参数：$1（--help 看用法）" ;;
    *) die "多余的参数：$1" ;;
  esac
done

[ -n "$DEST" ] || die "要指定 --dest（--help 看用法）"
if [ "$FLAT" = no ] && [ -z "$PUBLIC_BASE" ]; then
  die "要指定 --public-base：versions.json 的 download 字段得写出别人怎么取这些文件"
fi
case "$PUBLIC_BASE" in
  "" | https://?* | http://?*) ;;
  *) die "--public-base 要以 https:// 或 http:// 开头：$PUBLIC_BASE" ;;
esac

# One file from the source. A directory is copied rather than fetched: a previous
# mirror and a build host are the two most useful sources, and both are local.
fetch() { # <name> <output>
  if [ -d "$SOURCE" ]; then
    cp "$SOURCE/$1" "$2" 2>/dev/null
  else
    curl -fsSL --max-time 300 "$SOURCE/$1" -o "$2" 2>/dev/null
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch versions.json "$tmp/versions.json" ||
  die "源上没有 versions.json：$SOURCE（--tag 也补不出 hub 与 agent 的版本号，先在源上放一份）"
field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$tmp/versions.json" | head -1; }
[ -n "$TAG" ] || TAG="$(field tag)"
HUB="$(field hub)"
AGENT="$(field agent)"
[ -n "$TAG" ] || die "源上的 versions.json 没有 tag：用 --tag 指定这次发布的名字"
# A tag may be a readable label rather than vN; the only thing that would break is
# a character a URL cannot carry.
case "$TAG" in
  *[!A-Za-z0-9._-]*) die "tag 只能用字母、数字、点、下划线和横线：$TAG" ;;
esac
say "tag     $TAG"
[ -z "$HUB$AGENT" ] || say "版本    hub ${HUB:-?} · agent ${AGENT:-?}"

mkdir -p "$tmp/assets"
for arch in $ARCHES; do
  for name in probe-hub probe-agent; do
    asset="$name-$arch-unknown-linux-musl"
    fetch "$asset" "$tmp/assets/$asset" ||
      die "源上没有 $asset：这个架构没有发布，或者 --arches 写错了"
    # Not a nicety: see the header. Failing here is the whole point of the script.
    fetch "$asset.sig" "$tmp/assets/$asset.sig" ||
      die "源上没有 $asset.sig —— 少了它，节点安装时报的是「签名校验不通过」，看着像被投毒"
    say "asset   $asset  ($(du -h "$tmp/assets/$asset" | cut -f1))"
  done
done
fetch install-hub.sh "$tmp/assets/install-hub.sh" ||
  die "源上没有 install-hub.sh：那台机器升级 hub 时要它"

if [ "$VERIFY" = yes ]; then
  if command -v openssl >/dev/null 2>&1; then
    # The key is the installer's own copy: one statement of it, and the copy that
    # matters is the one every node already trusts.
    sed -n '/^PUBKEY="-----BEGIN/,/^-----END PUBLIC KEY-----$/p' hub/install-hub.sh |
      sed 's/^PUBKEY="//; s/"$//' >"$tmp/pub.pem"
    [ -s "$tmp/pub.pem" ] || die "没能从 install-hub.sh 里取出公钥"
    for sig in "$tmp/assets/"*.sig; do
      openssl pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin \
        -in "${sig%.sig}" -sigfile "$sig" >/dev/null 2>&1 ||
        die "签名不匹配：$(basename "${sig%.sig}") 不是用本项目的发布密钥签的，不镜像它"
    done
    say "校验    签名与 install-hub.sh 里的公钥一致"
  else
    die "需要 openssl 验证签名（apt install openssl），或用 --no-verify 明确跳过"
  fi
fi

# A convenience for whoever downloaded a file by hand -- `sha256sum -c` against
# it -- and not what any installer trusts: the signature is.
(cd "$tmp/assets" && sha256sum ./*-musl install-hub.sh >sha256sums.txt)

if [ "$FLAT" = yes ]; then
  stage="$tmp/stage"
  DOWNLOAD=""
  say "布局    平铺（没有 download 字段；--release-base 指向 $( [ -n "$PUBLIC_BASE" ] && echo "$PUBLIC_BASE" || echo "$DEST" )）"
else
  stage="$tmp/stage/$TAG"
  DOWNLOAD="$PUBLIC_BASE/$TAG"
  say "布局    版本目录（download = $DOWNLOAD）"
fi
mkdir -p "$stage"
cp -R "$tmp/assets/." "$stage/"

# The two fields CI writes plus this script's own: `tag` labels the release,
# `download` says where its files are. Written last, so a mirror never publishes a
# versions.json for files that are not there yet.
if [ -n "$DOWNLOAD" ]; then
  printf '{"tag":"%s","hub":"%s","agent":"%s","download":"%s"}\n' "$TAG" "$HUB" "$AGENT" "$DOWNLOAD" \
    >"$tmp/stage/versions.json"
else
  printf '{"tag":"%s","hub":"%s","agent":"%s"}\n' "$TAG" "$HUB" "$AGENT" >"$tmp/stage/versions.json"
fi

mkdir -p "$DEST"
if command -v rsync >/dev/null 2>&1; then
  # No --delete: a release already published stays, because a node that is
  # mid-upgrade is still asking for the files it started with.
  rsync -a "$tmp/stage/." "$DEST/"
else
  cp -R "$tmp/stage/." "$DEST/"
fi
say "目标    $DEST"

echo
echo "  装 hub 时指向这里："
echo "    sudo sh install-hub.sh --release-base ${PUBLIC_BASE:-$DEST}"
echo
echo "  反代给这个目录的缓存（强烈建议，理由在 versions.json 的作用里）："
echo "    location = /versions.json { add_header Cache-Control \"max-age=300\"; }"
echo "    location /              { add_header Cache-Control \"public, max-age=31536000, immutable\"; }"
echo "    以及 autoindex off —— 镜像不需要能列出目录。"
echo
echo "  每次发布重跑一遍这个脚本即可：同一台 hub 只要不重装就继续用同一个地址。"
