#!/bin/sh
# probe hub installer.
#
#   curl -fsSL https://github.com/imlilian/vps-probe/releases/latest/download/install-hub.sh -o install-hub.sh
#   chmod +x install-hub.sh
#   sudo ./install-hub.sh
#
# Menu-driven when a terminal is available. A plain `curl ... | sh` has no
# terminal to read answers from, so it installs with the defaults rather than
# waiting on an invisible prompt.
set -eu
# useradd resides in sbin, which a root shell entered through `su` without `-`
# lacks on Debian: su keeps the caller's PATH unless ALWAYS_SET_PATH is set, and
# Debian does not set it.
PATH="$PATH:/usr/sbin:/sbin"

REPO="imlilian/vps-probe"
# Where the binary, its signature and the checksum file are published. One line,
# so pointing this at a mirror keeps everything else working: the mirror has to
# serve the same file names under <base>/. Re-running this script is the upgrade,
# so a released copy staying put is correct -- the binary is what moves.
BASE="https://github.com/$REPO/releases/latest/download"
SERVICE="probe-hub"
UNIT="/etc/systemd/system/probe-hub.service"
# Everything but the unit lives under one directory: the binary at the top and
# everything the hub writes -- the database -- under data/. One path to back up,
# one to move to another host, and the same split the container image uses,
# where data/ is mounted at /data.
ROOT="/opt/probe"
BIN="$ROOT/probe-hub"
DATA="$ROOT/data"
# A fixed data directory requires a fixed owner: DynamicUser= selects its uid at
# start, and a recycled one would leave the database unreadable.
USER_NAME="probe"
PORT="28080"
PORT_SET=""
SITE=""
SITE_SET=""
YES=""
PURGE=""
ACTION=""
SOURCE=""

# The ed25519 key the release job signs both binaries with, as PEM. Its private
# half lives in the repository's Actions secrets and never on a host.
#
# Verifying here is the reason this installer does not merely check a sha256:
# the checksum sits in the same release as the binary, so whoever can replace
# one can replace the other -- and this binary runs as root on the one machine
# that hands out agents to the whole fleet. A signature cannot be replaced
# without the key.
PUBKEY="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEWjdds49q97yv3/zWLQLMe6/A7PvK+/e4NZq8eXO+o8=
-----END PUBLIC KEY-----"

# ---- ui ----
# Colour only to a terminal, and never when NO_COLOR is set: the output of a
# piped run belongs in a log rather than in escape sequences.
if [ -t 1 ] && [ -z "${NO_COLOR-}" ]; then
	B="$(printf '\033[1m')" D="$(printf '\033[2m')" N="$(printf '\033[0m')"
	G="$(printf '\033[32m')" R="$(printf '\033[31m')" Y="$(printf '\033[33m')"
else
	B="" D="" N="" G="" R="" Y=""
fi

rule() { printf '  %s────────────────────────────────────────────%s\n' "$D" "$N"; }

banner() {
	if [ -t 1 ]; then printf '\033[H\033[2J'; fi
	printf '\n  %sprobe hub%s  %s·%s  安装器\n' "$B" "$N" "$D" "$N"
	rule
	printf '\n'
}

# Every label below is deliberately two CJK characters wide: printf pads by byte
# count, so any other width would break the column.
ok() { printf '  %s✓%s  %s    %s%s%s\n' "$G" "$N" "$1" "$D" "${2-}" "$N"; }
field() { printf '  %s%s%s    %s\n' "$D" "$1" "$N" "$2"; }
warn() { printf '  %s!%s  %s\n' "$Y" "$N" "$1"; }
die() { printf '  %s✗%s  %s\n' "$R" "$N" "$1" >&2; exit 1; }

# A default answer on Enter, and the same default when there is no terminal.
ask() {
	if [ ! -t 0 ]; then printf '%s' "$2"; return; fi
	printf '  %s?%s  %s %s[%s]%s ' "$Y" "$N" "$1" "$D" "$2" "$N" >&2
	read -r reply || reply=""
	printf '%s' "${reply:-$2}"
}

confirm() {
	if [ -n "$YES" ]; then return 0; fi
	if [ ! -t 0 ]; then die "$1（非交互运行时加 --yes 确认）"; fi
	printf '  %s?%s  %s  %s[y/N]%s ' "$Y" "$N" "$1" "$D" "$N"
	read -r reply || reply=""
	case "$reply" in y | Y | yes) return 0 ;; *) printf '  已取消\n'; return 1 ;; esac
}

press() {
	if [ ! -t 0 ]; then return 0; fi
	printf '\n  %s回车返回菜单%s ' "$D" "$N"
	read -r _ || true
}

# A saved copy of this script is deliberately left alone. The original replaced
# itself with a newer copy fetched from the release and re-executed the result as
# root -- the same shape as the theme market this fork removed, and unnecessary:
# re-running the release URL is the upgrade. What matters is the binary, and that
# is verified by signature below, so even a stale copy of this script installs
# only bytes the release key signed.

check_port() {
	case "$1" in "" | *[!0-9]*) die "端口必须是 1-65535 的整数：$1" ;; esac
	[ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "端口必须是 1-65535 的整数：$1"
}

# The `--listen ...` tail of the installed unit's ExecStart, empty when nothing
# is installed. An upgrade rewrites the unit, so anything not supplied on the
# command line must be recovered from the old one, or re-running to upgrade
# would silently reset the port and drop --site.
old_exec() { sed -n 's/^ExecStart=.*--listen //p' "$UNIT" 2>/dev/null || true; }

# The port that unit listens on, empty when there is none. Read twice: once for
# the carry-over and once for the default the menu offers, since pressing Enter
# there must leave a running deployment unchanged.
old_port() {
	listen="$(old_exec)"
	case "$listen" in
	*:[0-9]*) listen="${listen%% *}"; printf '%s' "${listen##*:}" ;;
	esac
}

# ---- install ----
install_hub() {
	case "$(uname -m)" in
	x86_64 | amd64) arch=x86_64 ;;
	aarch64 | arm64) arch=aarch64 ;;
	*) die "不支持的架构：$(uname -m)（发布的是 x86_64 与 aarch64）" ;;
	esac
	asset="probe-hub-$arch-unknown-linux-musl"
	ok "架构" "$arch"

	# Whatever the command line did not specify is recovered from the old unit;
	# see old_exec.
	if [ -z "$PORT_SET" ]; then
		carried="$(old_port)"
		[ -z "$carried" ] || PORT="$carried"
	fi
	if [ -z "$SITE_SET" ]; then
		carried="$(old_exec)"
		case "$carried" in
		*--site\ *) SITE="${carried##*--site }"; SITE="${SITE%% *}" ;;
		esac
	fi
	check_port "$PORT"

	# Before anything is stopped, replaced or downloaded: a port conflict must
	# leave the running hub untouched. The hub's own socket is never a conflict,
	# determined by pid rather than by the port written in the unit -- one this
	# script did not write, whether hand-edited or with ExecStart split across
	# lines, parses out empty, and the hub already on the port would be reported
	# as an unrelated process occupying it.
	if command -v ss >/dev/null 2>&1; then
		holder="$(ss -ltnpH "sport = :$PORT" 2>/dev/null |
			sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
		if [ -n "$holder" ] &&
			[ "$holder" != "$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)" ]; then
			die "端口 $PORT 已被其它程序占用，换一个：--port <n>"
		fi
	fi

	id -u "$USER_NAME" >/dev/null 2>&1 ||
		useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME" ||
		die "无法创建系统用户 $USER_NAME"
	install -d -m 0755 "$ROOT"
	# 0700 owned by the service user, so its group is irrelevant and nothing here
	# depends on useradd having created one.
	install -d -m 0700 -o "$USER_NAME" "$DATA"

	# Only a missing database makes this a first install, which sets the
	# password. Checked before anything is installed.
	first=""
	[ -f "$DATA/probe.db" ] || first=1

	# The download happens before anything is stopped, so a host that cannot fetch
	# the binary keeps the hub it is running.
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	if [ -n "$SOURCE" ]; then
		# A local file skips the network: for a host that cannot reach github.com,
		# and for a binary built straight from the working tree. The signature is
		# expected beside it, so the same check applies either way.
		[ -f "$SOURCE" ] || die "找不到文件：$SOURCE"
		cp "$SOURCE" "$tmp/$asset" || die "读不了 $SOURCE"
		[ ! -f "$SOURCE.sig" ] || cp "$SOURCE.sig" "$tmp/$asset.sig"
		ok "来源" "$SOURCE"
	else
		# The tag comes from GitHub's own redirect for "latest", so there is no API
		# call to be rate-limited and no JSON to parse. Only the first hop carries
		# it -- the chain ends on release-assets.githubusercontent.com, whose URL
		# contains no tag -- so this must not follow redirects. A missing asset
		# still redirects, so the download below is what catches an architecture
		# that was never published.
		tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' "$BASE/$asset" 2>/dev/null |
			sed -n 's#.*/download/\([^/]*\)/.*#\1#p')" || true
		[ -n "$tag" ] || die "查不到最新发布版；GitHub 不可达，或还没有任何发布"
		ok "版本" "$tag"

		curl -fsSL --max-time 300 "$BASE/$asset" -o "$tmp/$asset" || die "二进制下载失败：$BASE/$asset"
		curl -fsSL --max-time 30 "$BASE/$asset.sig" -o "$tmp/$asset.sig" ||
			die "签名下载失败：$BASE/$asset.sig"
		ok "下载" "$(du -h "$tmp/$asset" | cut -f1)"
	fi

	# Verified by signature rather than by the release's checksum file. The
	# checksum sits in the same release as the binary, so whoever can replace one
	# can replace the other; a signature needs the key, which never leaves this
	# machine's owner. It also covers a truncated transfer and a mirror's error
	# page, which is everything the checksum was there for.
	[ -f "$tmp/$asset.sig" ] || die "缺少签名文件 $asset.sig，不安装未经签名的二进制"
	command -v openssl >/dev/null 2>&1 || die "需要 openssl 验证签名（apt install openssl）"
	printf '%s\n' "$PUBKEY" >"$tmp/pub.pem"
	openssl pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin \
		-in "$tmp/$asset" -sigfile "$tmp/$asset.sig" >/dev/null 2>&1 ||
		die "签名校验不通过，已丢弃下载的文件：这份二进制不是用本项目的发布密钥签的"
	ok "校验" "ed25519 签名一致"

	# Keep the old binary until the new one has proved it starts: a failed upgrade
	# must leave a running hub rather than a dead service.
	backup=""
	if [ -f "$BIN" ]; then
		backup="$BIN.old"
		# Never over an existing backup. A run that died between the install below
		# and the health check left $BIN holding a binary that never proved it
		# starts; copying that over the good backup would make the rollback restore
		# the same broken binary while reporting success.
		[ -f "$backup" ] || cp -f "$BIN" "$backup"
	fi
	# Stopped first so the copy does not land beneath a live process.
	systemctl stop "$SERVICE" 2>/dev/null || true
	install -m 0755 "$tmp/$asset" "$BIN"
	# The download is complete. Cleared here as well as on EXIT because the menu
	# calls this more than once per run and each call replaces the trap, leaving
	# the previous directory and its binary uncollected.
	rm -rf "$tmp"
	trap - EXIT

	# Loopback only: the panel and the agent tokens never traverse a network in
	# the clear, and there is no port to firewall. Reaching it is the reverse
	# proxy's responsibility, and 127.0.0.1 rather than [::1] because that is
	# every proxy's default upstream; the hub binds one address, not both.
	args="--listen 127.0.0.1:$PORT --db $DATA/probe.db"
	[ -z "$SITE" ] || args="$args --site $SITE"
	cat >"$UNIT" <<UNIT
[Unit]
Description=probe hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN $args
Restart=always
RestartSec=5
# The database lives in data/, which is the only path this service may write
# to, excluding even the binary above it.
User=$USER_NAME
WorkingDirectory=$ROOT
ReadWritePaths=$DATA
NoNewPrivileges=yes
RestrictSUIDSGID=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=256M
# The default soft limit is 1024, which sustains roughly 850 agents: past that
# the hub stops accepting connections, including the panel's own, and logs
# nothing about it. The binary raises its own limit at startup but cannot pass
# the hard one, so it is raised here where systemd may.
LimitNOFILE=65536

# Nothing the hub does needs a capability: it binds a high port, writes one
# directory, and runs as a plain user. The empty set makes that structural --
# a capability gained later by a bug cannot be used, because none are in the
# bounding set to begin with.
CapabilityBoundingSet=
# Kernel surfaces a status server never touches. Each is a mount-namespace
# option, so a container that cannot create one degrades to a warning rather
# than a unit that refuses to start.
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
# The hub creates no namespaces at run time.
RestrictNamespaces=yes
# Refuses the 32-bit syscall entry, which nothing in a native build calls.
SystemCallArchitectures=native
# What a normal system service is expected to use: sockets, files, SQLite,
# name resolution, timers. Checked against a pass over every route with an
# agent connected, so a rejected call shows up as status=31/SYS in the journal
# rather than as a mystery. That status is the first thing to look for if a
# future change reaches outside the set.
SystemCallFilter=@system-service
# Anything the service creates -- journals, and the temporary files a restore
# writes -- is private to it by default.
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

	# Taken from the binary's stdout rather than the journal, which some hosts
	# keep nowhere. Set before the service starts, so the hub finds a password in
	# place and does not generate a second one. A reset refuses a missing
	# database, so the file is created first under the service user; SQLite reads
	# an empty file as an empty database.
	pw=""
	if [ -n "$first" ]; then
		install -m 0600 -o "$USER_NAME" /dev/null "$DATA/probe.db"
		pw="$(new_password)"
	fi

	systemctl daemon-reload
	systemctl enable "$SERVICE" >/dev/null 2>&1 || true
	# Not left to set -e: a binary that cannot exec fails the job itself, which is
	# precisely the case the rollback below exists for. Unguarded, the script
	# would exit here with a raw systemd error and leave the hub down on the
	# binary that just failed.
	systemctl restart "$SERVICE" || true
	# is-active answers before a unit that exits immediately has done so. Wait,
	# then query.
	sleep 3
	if ! systemctl is-active --quiet "$SERVICE"; then
		# A first install has nothing to keep serving, so there is no rollback.
		# The new database holds nothing but a password never shown; it is removed
		# so that a rerun is again a first install and shows one, and the unit is
		# disabled, since any binary it started later -- on a reboot as well --
		# would set a password on an empty database and print it only to the
		# journal. A backup, if any, stays for the next run.
		if [ -n "$first" ]; then
			systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
			rm -f "$DATA/probe.db" "$DATA/probe.db-wal" "$DATA/probe.db-shm"
			die "服务启动失败。日志：journalctl -u $SERVICE -n 50"
		fi
		if [ -n "$backup" ]; then
			install -m 0755 "$backup" "$BIN"
			rm -f "$backup"
			systemctl restart "$SERVICE" 2>/dev/null || true
			die "新版本没能启动，已回滚到上一版。日志：journalctl -u $SERVICE -n 50"
		fi
		die "服务启动失败。日志：journalctl -u $SERVICE -n 50"
	fi
	rm -f "$BIN.old"
	ok "服务" "已启动并开机自启"

	if [ -n "$first" ]; then done_title="安装完成"; else done_title="升级完成"; fi
	printf '\n  %s%s%s\n' "$B" "$done_title" "$N"
	rule
	printf '\n'
	field "面板" "${SITE:-http://127.0.0.1:$PORT}/admin"
	if [ -n "$first" ]; then
		if [ -n "$pw" ]; then
			field "密码" "$pw"
			field "    " "${D}记下来，登录后到「安全」里改掉${N}"
		else
			field "密码" "没取到，重跑安装器选「重置密码」"
		fi
	fi
	field "数据" "$DATA/probe.db"
	field "服务" "systemctl status $SERVICE"
	field "日志" "journalctl -u $SERVICE -f"
	printf '\n'

	# The hub is on loopback, so this is the remaining half of the install rather
	# than optional advice. It does not ask for --site here: the panel builds
	# install commands from the browser's own address, so once the domain works
	# everything downstream follows -- except OIDC, which the hub has to name the
	# callback address for itself, and which is why the note below mentions it.
	if [ -z "$SITE" ]; then
		printf '  %s还差一步：配个反向代理%s\n' "$B" "$N"
		printf '     面板只监听本机，公网访问不到——这是故意的，凭证不会在链路上裸奔。\n'
		printf '     用 nginx / caddy / cf tunnel 任选一种，把 hub.example.com 换成你的域名，\n'
		printf '     配好之后用域名访问面板，我相信这难不倒你。\n'
		[ "$PORT" = 28080 ] || printf '     反代要指向 %s 这个端口。\n' "$PORT"
		# Everything the panel derives from the browser address follows from the
		# domain working, which is why --site is not asked for here. OIDC is the
		# exception: the hub has to send the callback address itself, and only
		# --site tells it what that is.
		printf '     另外：要用 OIDC 登录（面板「安全」页那张卡），得再跑一次带\n'
		printf '     --site https://你的域名 的安装——OIDC 的回调地址只能来自它。\n'
	fi
}

# ---- password ----
# Prints nothing on failure; the hub's own error reaches stderr. Running as root
# is safe: SQLite gives the -wal and -shm files it creates the database file's
# owner.
new_password() {
	"$BIN" --db "$DATA/probe.db" --reset-password | sed -n 's/^Emergency password: //p'
}

reset_password() {
	# The data outlives --uninstall, so the database alone does not mean a hub.
	if [ ! -f "$BIN" ] || [ ! -f "$DATA/probe.db" ]; then
		die "这台机器上没有装 probe hub"
	fi
	confirm "重置面板密码？所有已登录的会话都会被登出" || return 0
	pw="$(new_password)"
	# Versions without the flag report "unknown argument" on stderr.
	[ -n "$pw" ] || die "重置失败。上面提示 unknown argument 的话是 hub 版本太旧，先升级"
	field "密码" "$pw"
}

# ---- uninstall ----
uninstall_hub() {
	if [ ! -f "$BIN" ] && [ ! -f "$UNIT" ]; then
		# The data outlives the unit, so --purge still has work to do.
		if [ -n "$PURGE" ] && [ -e "$DATA" ]; then
			confirm "服务已经卸载了。删除 $DATA 下的数据库？不可撤销" || return 0
			rm -rf "$DATA"
			rmdir "$ROOT" 2>/dev/null || true
			ok "数据" "已删除"
			return 0
		fi
		[ ! -e "$DATA" ] || die "服务已经卸载了，数据还留在 $DATA；要一并删掉就加 --purge"
		die "这台机器上没有装 probe hub"
	fi
	if [ -n "$PURGE" ]; then
		confirm "卸载 probe hub，并删除 $DATA 下的数据库？不可撤销" || return 0
	else
		confirm "卸载 probe hub？数据保留在 $DATA" || return 0
	fi
	systemctl disable --now "$SERVICE" 2>/dev/null || true
	rm -f "$UNIT" "$BIN" "$BIN.old"
	systemctl daemon-reload
	ok "服务" "已移除"
	if [ -n "$PURGE" ]; then
		rm -rf "$DATA"
		# Only when the agent is not installed alongside it.
		rmdir "$ROOT" 2>/dev/null || true
		ok "数据" "已删除"
	else
		field "数据" "保留在 $DATA，重新安装会直接接着用"
	fi
}

menu() {
	while :; do
		banner
		printf '    1  安装 / 升级\n'
		printf '    2  卸载\n'
		printf '    3  状态\n'
		printf '    4  日志\n'
		printf '    5  重置密码\n'
		printf '    q  退出\n\n'
		printf '  %s›%s ' "$B" "$N"
		read -r choice || exit 0
		printf '\n'
		case "$choice" in
		1)
			# The default offered is what the unit already listens on, so Enter
			# leaves a running deployment unchanged. PORT_SET marks the answer as
			# supplied: without it the carry-over in install_hub would read the port
			# back out of that same unit and discard the answer given here.
			carried="$(old_port)"
			PORT="$(ask "监听端口" "${carried:-$PORT}")"
			check_port "$PORT"
			PORT_SET=1
			printf '\n'
			install_hub
			press
			;;
		2) uninstall_hub; press ;;
		3) systemctl status "$SERVICE" --no-pager || true; press ;;
		4) journalctl -u "$SERVICE" -f --no-pager ;;
		5) reset_password; press ;;
		q | Q | exit | "") exit 0 ;;
		*) ;;
		esac
	done
}

usage() {
	cat <<TXT
probe hub 安装器

  sudo ./install-hub.sh                有终端时给菜单，否则按默认安装
  sudo ./install-hub.sh --upgrade      升级到最新发布版，配置沿用上次
  sudo ./install-hub.sh --port 8443    指定端口安装
  sudo ./install-hub.sh --from FILE    用本地二进制安装，不是从 GitHub 取
  sudo ./install-hub.sh --uninstall    卸载，保留数据
  sudo ./install-hub.sh --purge        卸载并删除数据库
  sudo ./install-hub.sh --reset-password
                                       重置面板密码，登出所有会话

  --port <n>     本机监听端口，默认 $PORT
  --site <url>   一般不用填。面板拼安装命令用的是浏览器地址栏，配好反代
                 用域名访问就自动对了。四种情况要填：要用 OIDC 登录（面板
                 「安全」页那张卡——它必须原样带上回调地址，hub 只能从
                 --site 知道它，不填则点登录按钮直接失败）；节点该连的域名
                 和你进面板的域名不是同一个；走 SSH 隧道进面板（地址栏是
                 127.0.0.1，节点连不上它）；反代不发 X-Forwarded-Proto
                 （那时会话 cookie 拿不到 Secure 标志）
  --from <file>  不从发布源取，改用本地文件；同名 .sig 要放在它旁边
  --yes, -y      跳过确认
  --help, -h     显示这段

hub 只监听 127.0.0.1，公网访问不到，需要自己配 nginx / caddy / CF 隧道把
域名指过来，装完用 --site 填你的域名。

二进制按 ed25519 签名校验：签名私钥只在发布流水线里，任何机器上都没有，
所以发布源被换掉也装不进来。校验不过直接拒绝，不落盘。
重跑一次就是升级，起不来会自动回滚到上一版；没写的参数沿用上次的，升级
不会把端口和 --site 冲掉。二进制和数据都在 $ROOT 下，卸载默认保留数据。
TXT
}

while [ $# -gt 0 ]; do
	case "$1" in
	# An explicit guard rather than `${2-}`: `shift 2` with nothing to shift is
	# fatal in dash, and the output would be the shell's diagnostic rather than
	# this message.
	--port) [ $# -ge 2 ] || die "--port 后面要跟端口号"; PORT="$2"; PORT_SET=1; shift 2 ;;
	--site) [ $# -ge 2 ] || die "--site 后面要跟地址"; SITE="$2"; SITE_SET=1; shift 2 ;;
	--from) [ $# -ge 2 ] || die "--from 后面要跟文件路径"; SOURCE="$2"; shift 2 ;;
	# Named for what it does, though it is also what a bare run does: the
	# distinction users care about is install versus the other actions.
	--upgrade) ACTION=install; shift ;;
	--uninstall) ACTION=uninstall; shift ;;
	--purge) ACTION=uninstall; PURGE=1; shift ;;
	--reset-password) ACTION=reset; shift ;;
	--yes | -y) YES=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "未知参数：$1（--help 看用法）" ;;
	esac
done

check_port "$PORT"
# The same form `api::https_domain` measures --site against on the hub, checked
# here because this is where the value is entered. A hub started with a value it
# refuses starts normally and then declines to add or install any node, which
# surfaces only in the journal and the panel, long after the value was typed.
SITE="${SITE%/}"
if [ -n "$SITE" ]; then
	case "$SITE" in
	https://*) ;;
	*) die "--site 必须以 https:// 开头：$SITE" ;;
	esac
	rest="${SITE#https://}"
	case "$rest" in
	*/*) die "--site 后面不能带路径，只要 https://域名[:端口]：$SITE" ;;
	*@*) die "--site 里不能带用户名：$SITE" ;;
	"["*) die "--site 必须是域名，不能是 IP 地址：$SITE" ;;
	esac
	# A port is permitted; what precedes it must be a name rather than an
	# address.
	case "${rest%%:*}" in
	"" | localhost | *.localhost) die "--site 必须是一个域名：$SITE" ;;
	*[!0-9.]*) ;;
	*) die "--site 必须是域名而不是 IP 地址：$SITE" ;;
	esac
fi
[ "$(id -u)" = 0 ] || die "需要 root：sudo sh $0"
# A local file needs no network, and uninstalling needs neither network nor
# openssl: checked here so a host without them can still be cleaned up.
if [ -z "$SOURCE" ] && [ "$ACTION" != uninstall ] && [ "$ACTION" != reset ]; then
	command -v curl >/dev/null 2>&1 || die "需要 curl"
	command -v openssl >/dev/null 2>&1 || die "需要 openssl 验证签名（apt install openssl）"
fi
command -v systemctl >/dev/null 2>&1 ||
	die "这个安装器只装 systemd 服务。手动运行：$BIN --listen 127.0.0.1:$PORT --db $DATA/probe.db"

case "$ACTION" in
uninstall) banner; uninstall_hub ;;
reset) banner; reset_password ;;
*)
	if [ -t 0 ]; then
		menu
	else
		banner
		install_hub
	fi
	;;
esac
