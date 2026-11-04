#!/bin/sh
# Installs probe-agent as a systemd or OpenRC service.
#   curl -fsSL https://hub.example.com/install-agent.sh | sh -s -- --server URL --token TOKEN [options]
#   curl -fsSL https://hub.example.com/install-agent.sh | sh -s -- --server URL --register KEY [options]
#   curl -fsSL https://hub.example.com/install-agent.sh | sh -s -- --upgrade
#   curl -fsSL https://hub.example.com/install-agent.sh | sh -s -- --uninstall
#
# Named after what it installs, matching install-hub.sh. The hub serves this file
# and also keeps the older /install.sh path alive, so a command pasted before the
# rename still installs.
set -eu
# useradd and rc-update reside in sbin, which a root shell entered through `su`
# without `-` lacks on Debian: su keeps the caller's PATH unless ALWAYS_SET_PATH
# is set, and Debian does not set it.
PATH="$PATH:/usr/sbin:/sbin"

# Binary and token in one directory, the same one the hub uses, giving a node a
# single path to inspect and a single path to remove.
ROOT="/opt/probe"
# The service, the account and every file named after them carry one name, so
# `ps`, `journalctl` and /etc/passwd read alike and renaming is one line. Not the
# bare `probe` the hub's account once used: that is a name other packages pick
# for their own user, and a clash is adopted silently rather than reported -- see
# ours(). SVC rather than NAME because --name already means the node's name.
SVC="probe-agent"
USER_NAME="$SVC"
BIN="$ROOT/$SVC"
ENV_FILE="$ROOT/agent.env"
UNIT_FILE="/etc/systemd/system/$SVC.service"
RC_FILE="/etc/init.d/$SVC"
LOG_FILE="/var/log/$SVC.log"
SERVER=""
TOKEN=""
REGISTER=""
NAME=""
IFACE=""
IFACE_SET=""
INTERVAL=""
INSECURE=""
UNINSTALL=""
UPGRADE=""

# One text for both the wrong-argument path and --help, which the hub script has
# had all along: a script a fleet pastes blind is the one that most needs a way to
# ask what it takes.
usage() {
	cat <<TXT
installs probe-agent from the hub that served this script.

  install-agent.sh --server URL (--token TOKEN | --register KEY) [options]
  install-agent.sh --upgrade [--iface LIST] [--interval SECONDS]
  install-agent.sh --uninstall

  --server <url>       Hub base URL, e.g. https://hub.example.com
  --token <token>      Node token from the hub panel
  --register <key>     Registration key from the panel; exchanges it for this
                       node's own token, which is what a batch install uses
  --name <name>        Names the node --register creates, which is otherwise
                       named after its id. < > " ' are dropped from it; the
                       panel renames a node freely
  --iface <list>       Count traffic on these interfaces alone, e.g.
                       eth1,pppoe-wan. A leading - removes one. Kept on rerun.
  --interval <secs>    Report interval, 1-3600. Kept on rerun.
  --insecure           Plain HTTP to a hub with no TLS in front: the token and
                       the binary travel in the clear
  --upgrade            Reinstall from this machine's own token and hub address
  --uninstall          Remove the service, binary, env file and log
  --help, -h           Show this

The token lives in $ENV_FILE (0600 root); the agent runs as $USER_NAME with no
capabilities. Everything is installed under $ROOT.
TXT
}

while [ $# -gt 0 ]; do
	# A flag with no argument: under set -u, `$2` aborts with the shell's own
	# message rather than the usage below, and `shift 2` cannot proceed.
	case "$1" in
	--server | --token | --register | --name | --iface | --interval)
		[ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; } ;;
	esac
	case "$1" in
	--server) SERVER="$2"; shift 2 ;;
	--token) TOKEN="$2"; shift 2 ;;
	--register) REGISTER="$2"; shift 2 ;;
	--name) NAME="$2"; shift 2 ;;
	--iface) IFACE="$2"; IFACE_SET=1; shift 2 ;;
	--interval) INTERVAL="$2"; shift 2 ;;
	--insecure) INSECURE=1; shift ;;
	--uninstall) UNINSTALL=1; shift ;;
	--upgrade) UPGRADE=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# `uid shell` of a local account, empty when the name is not in /etc/passwd.
# Read from the file rather than through getent, which a slim install need not
# have; NSS-backed accounts are not what a system service user ever is.
account() {
	sed -n "s/^$1:[^:]*:\([0-9]*\):[0-9]*:[^:]*:[^:]*:\([^:]*\)$/\1 \2/p" /etc/passwd | head -n 1
}

# Whether an account of this name is this project's. A system uid with a nologin
# shell is the shape both installers create; any other account of the same name
# belongs to some other package, and taking it over would hand that package's
# owner this node's token -- or delete their user on --uninstall. A heuristic,
# but the alternative is trusting `id -u` alone, which adopts a name clash
# silently. Same test as install-hub.sh: the two must agree, since both accounts
# live on the same hosts.
#
# The two temporaries are globals rather than `local`, which is not POSIX: this
# runs under whatever /bin/sh the host has. The underscore keeps them clear of
# the flags, which are the only other globals that matter.
ours() {
	_ours_acct="$(account "$1")"
	case "$_ours_acct" in
	'') return 1 ;;
	*' '*) ;;
	*) return 1 ;;
	esac
	_ours_uid="${_ours_acct% *}"
	case "$_ours_uid" in *[!0-9]*) return 1 ;; esac
	[ "$_ours_uid" -ge 100 ] && [ "$_ours_uid" -le 999 ] || return 1
	case "${_ours_acct#* }" in *nologin | */false) return 0 ;; esac
	return 1
}

# Alpine ships BusyBox adduser rather than useradd: -S system, -D no password,
# -H no home.
add_user() {
	if command -v useradd >/dev/null; then
		useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
	else
		adduser -S -D -H -s /sbin/nologin "$USER_NAME"
	fi
}

# Which of three things the name in /etc/passwd is: ours to adopt, free to
# create, or somebody else's.
#
# The fourth case is not an error and is why this returns a word rather than a
# yes/no: a name that resolves but is not in the passwd file is the transient
# user an agent installed under the old DynamicUser= is still running as. That
# one is this project's, and it goes away with the unit, which is why the caller
# asks again after stopping it -- see the stop further down.
user_state() {
	if [ -n "$(account "$1")" ]; then
		if ours "$1"; then echo ours; else echo foreign; fi
	elif id -u "$1" >/dev/null 2>&1; then
		echo transient
	else
		echo free
	fi
}

# Creates the account when the name is free, adopts it when it is this project's,
# and refuses when it is somebody else's.
ensure_user() {
	case "$(user_state "$USER_NAME")" in
	ours | transient) return 0 ;;
	free)
		add_user || { echo "cannot create the system user $USER_NAME" >&2; return 1; }
		;;
	*)
		echo "$USER_NAME is already an account on this machine that this project did not create." >&2
		echo "deal with it by hand, or install under another name, rather than sharing it." >&2
		return 1
		;;
	esac
}

# Removes exactly what an install writes and nothing else, for both init
# systems: the one present now need not be the one the install found, and
# systemctl fails outright where systemd is not PID 1 (WSL, containers) although
# the install left its files there. Each step therefore tolerates failure. The
# hub may be installed in $ROOT as well, so the directory is removed only once
# empty. The account goes too -- unlike the hub's, it owns no state, so nothing
# is lost by deleting it -- but only when it is this project's own; see ours().
if [ -n "$UNINSTALL" ]; then
	# Asked where somebody is watching, skipped where the command came from a
	# broadcast: `curl | sh` leaves stdin holding the script itself, so there is no
	# terminal to answer on and a fleet-wide uninstall must not wait for one.
	if [ -t 0 ]; then
		printf 'remove %s, %s and the token in %s? [y/N] ' "$SVC" "$BIN" "$ENV_FILE"
		read -r reply || reply=""
		case "$reply" in
		y | Y | yes) ;;
		*) echo "cancelled"; exit 0 ;;
		esac
	fi
	rc-service "$SVC" stop 2>/dev/null || true
	rc-update del "$SVC" default >/dev/null 2>&1 || true
	systemctl disable --now "$SVC" 2>/dev/null || true
	rm -f "$UNIT_FILE" "$RC_FILE" "$LOG_FILE" "$BIN" "$BIN.old" "$ENV_FILE"
	systemctl daemon-reload 2>/dev/null || true
	if ours "$USER_NAME"; then
		userdel "$USER_NAME" 2>/dev/null || deluser "$USER_NAME" 2>/dev/null || true
	fi
	rmdir "$ROOT" 2>/dev/null || true
	echo "$SVC uninstalled"
	exit 0
fi

# Reinstalls the binary with what this machine already holds. It is the one
# command a whole fleet can be upgraded with, because it carries no credential
# and names no node: the token and the hub address come from the env file, which
# only an install writes. Registering is not reached, so it can neither add a
# node nor spend a key, and a machine with nothing installed is told to use the
# panel's command rather than quietly becoming a new node.
if [ -n "$UPGRADE" ]; then
	[ -z "$TOKEN$REGISTER" ] ||
		{ echo "--upgrade takes no --token or --register; it reuses what this machine holds" >&2; exit 2; }
	TOKEN=$(sed -n 's/^PROBE_TOKEN=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ -n "$SERVER" ] || SERVER=$(sed -n 's/^PROBE_SERVER=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	# The scheme already installed is the record of --insecure: an env file naming
	# http:// could only have been written by a run that said so, and this command --
	# the one a whole fleet upgrades with -- carries no flags at all. Without this,
	# the check below refuses the upgrade of every node that had to accept plaintext.
	case "$SERVER" in
	http://*)
		if [ -z "$INSECURE" ]; then
			INSECURE=1
			echo "keeping --insecure: $SERVER is plain http" >&2
		fi
		;;
	esac
	[ -n "$TOKEN" ] && [ -n "$SERVER" ] || {
		echo "no agent is installed here: $ENV_FILE holds no token and hub address." >&2
		echo "install it with the command from the panel instead" >&2
		exit 2
	}
fi

[ -n "$SERVER" ] && { [ -n "$TOKEN" ] || [ -n "$REGISTER" ]; } || {
	usage >&2
	exit 2
}
# Names the node a registration creates. A token belongs to a node that already
# has a name, which the panel changes; silently dropping the flag there would
# read as a rename that never happened.
[ -z "$NAME" ] || [ -z "$TOKEN" ] ||
	{ echo "--name applies only with --register; rename an existing node in the panel" >&2; exit 2; }
# A setting of this machine, kept by a rerun without the flag for the reason
# given for --iface below: the batch command carries none at the default. It is
# read back from the service definition the last install wrote; a first install
# takes 1.
if [ -z "$INTERVAL" ]; then
	INTERVAL=$(cat "$UNIT_FILE" "$RC_FILE" 2>/dev/null | sed -n \
		-e 's/^ExecStart=.* --interval \([0-9][0-9]*\).*/\1/p' \
		-e 's/^command_args="--interval \([0-9][0-9]*\).*/\1/p' | tail -n 1)
	if [ -n "$INTERVAL" ]; then echo "keeping --interval $INTERVAL from the previous install"; else INTERVAL=1; fi
fi
case "$INTERVAL" in "" | *[!0-9]*) echo "interval must be an integer from 1 to 3600" >&2; exit 2 ;; esac
[ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 3600 ] || { echo "interval must be from 1 to 3600" >&2; exit 2; }
# Which interfaces carry this machine's traffic is known only on the machine,
# and the batch command a fleet shares cannot carry one value per machine. A
# rerun without --iface, the documented upgrade, therefore keeps the value in
# the env file; --iface '' clears it.
#
# A kept value is written back as found, the last assignment being the one
# systemd and OpenRC apply: root wrote it, both already read it, and a hand edit
# with quotes must not block every later upgrade. A value given here is held to
# what the agent accepts -- full names separated by commas, each optionally led
# by one `-` -- since the agent refuses anything else at startup and would
# restart forever while this script reported success. The character set also
# keeps it inert where OpenRC sources the file as shell.
if [ -z "$IFACE_SET" ]; then
	IFACE=$(sed -n 's/^PROBE_IFACE=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ -z "$IFACE" ] || echo "keeping --iface $IFACE from the previous install"
else
	case ",$IFACE," in
	*[!A-Za-z0-9._,-]* | *,-,* | *,--*)
		echo "--iface takes full interface names separated by commas, each optionally led by -, not: $IFACE" >&2
		exit 2
		;;
	esac
fi
# A bare host implies TLS, matching the upgrade the agent's ws_url() performs,
# and the same reversal under --insecure where the hub has no TLS to upgrade to.
# Without this the two diverge: the agent would dial wss:// while curl below
# defaults a scheme-less URL to http://, fetching over plaintext the binary about
# to run as root.
if [ -n "$INSECURE" ]; then SCHEME=http; else SCHEME=https; fi
# The scheme in lowercase, as every check below matches it: a hand-typed
# HTTP:// would otherwise pass the plaintext refusal.
lower_scheme() { printf '%s://%s' "$(printf '%s' "${1%%://*}" | tr 'A-Z' 'a-z')" "${1#*://}"; }
case "$SERVER" in
*://*) SERVER=$(lower_scheme "$SERVER") ;;
*) SERVER="$SCHEME://$SERVER" ;;
esac
# The agent already refuses plaintext ws:// to a remote hub, since the token
# would travel in the clear. The same address fetches the binary about to run as
# root here, so the same rule applies: over plain HTTP anyone on the path can
# substitute a binary of their own.
#
# --insecure overrides both halves for a hub reached at ip:port with no TLS in
# front, and says so explicitly: this is the one step of the install that cannot
# be corrected afterwards, because a substituted binary is already running as
# root by then.
#
# The test applies to the host alone, with scheme, port and path removed, and
# matches an address rather than a prefix: `127.evil.com` is a registered name
# resolving wherever its owner points it, and reading it as loopback would hand
# this plaintext channel to that owner.
HOST="${SERVER#*://}"
HOST="${HOST%%/*}"
# RFC 3986 places userinfo before the host, so `127.0.0.1:28080@evil.example.com`
# leaves a loopback address where the test below looks while curl, which parses
# the URL correctly, fetches from the owner of that name -- over plain HTTP, with
# the bytes installed 0755 and started as root a few lines below. A hub address
# never requires userinfo; the agent's own ws_url rejects it as well.
case "$HOST" in
*@*) echo "server URL must not contain '@': the host is whatever follows it" >&2; exit 2 ;;
esac
case "$HOST" in
"["*) HOST="${HOST#\[}"; HOST="${HOST%%]*}" ;;
*) HOST="${HOST%%:*}" ;;
esac
# A full dotted quad in 127/8 and nothing shorter, matching what the agent's
# is_loopback() accepts, since Rust's IpAddr parser accepts nothing shorter
# either -- `127.1` is a name to it, not an address. The two must agree, or this
# installs over plaintext against a hub the agent then refuses to dial: the unit
# is written, the service started, and it crash-loops on RestartSec while this
# script has reported success.
#
# The first arm excludes anything containing a letter, which is a registered name
# however it begins, and anything with more than four components, which is not an
# address.
case "$HOST" in
localhost | ::1) LOCAL=1 ;;
*[!0-9.]* | *.*.*.*.*) LOCAL="" ;;
127.[0-9]*.[0-9]*.[0-9]*) LOCAL=1 ;;
*) LOCAL="" ;;
esac
case "$SERVER" in
https://*) ;;
http://*)
	if [ -z "$LOCAL" ]; then
		[ -n "$INSECURE" ] || {
			echo "refusing plaintext http:// to a remote hub; use https://, or --insecure if it has no TLS" >&2
			exit 2
		}
		echo "warning: --insecure over plain HTTP to $SERVER" >&2
		echo "         the token and every report travel in the clear, and the binary" >&2
		echo "         installed below is fetched over the same unverified channel" >&2
	fi
	;;
# Anything else is refused rather than left to curl: ftp:// or the agent's own
# ws:// would fetch the binary in the clear while escaping the test above.
*)
	echo "server URL must start with https:// or http://, not: $SERVER" >&2
	exit 2
	;;
esac
if command -v systemctl >/dev/null; then
	INIT=systemd
elif command -v rc-update >/dev/null; then
	INIT=openrc
else
	echo "this installer needs systemd or OpenRC" >&2
	exit 1
fi

# The service user the agent runs as under either init system, created before
# the download and the registration, so a host where this fails keeps the agent
# it already runs and spends no registration key. One case passes this check
# without a user and is settled after the old agent stops; see there.
ensure_user || exit 1

case "$(uname -m)" in
x86_64 | amd64) ARCH=x86_64 ;;
aarch64 | arm64) ARCH=aarch64 ;;
*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# The hub relays the binary, so a node need only reach the hub it already talks
# to: an IPv6-only or blocked machine cannot resolve github.com. A hub unable to
# fetch releases itself is configured with a GitHub proxy in its own settings,
# which is why none is requested here.
URL="${SERVER%/}/probe/$ARCH"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "downloading $SVC ($ARCH)"
# The hub relays four downloads at once and queues the rest for up to 30 seconds
# (RELAY_WAIT), then turns the request away with 503, which is retried here rather
# than failing the machine. The budget has to outlast that queue, or the machines
# that queued longest -- the ones a batch install needs most -- are the ones that
# give up: eight waits of five seconds reach 40 s, past the queue with margin.
# Any other refusal is final and shown with the hub's own reason, which --fail
# would discard.
TRIES=0
while :; do
	CODE=$(curl -sSL --max-time 300 -w '%{http_code}' "$URL" -o "$TMP") || exit 1
	[ "$CODE" = 503 ] && [ "$TRIES" -lt 8 ] || break
	TRIES=$((TRIES + 1))
	echo "the hub is busy relaying to other machines; retrying in 5 seconds ($TRIES/8)"
	sleep 5
done
[ "$CODE" = 200 ] ||
	{ printf 'download failed (HTTP %s): %s\n' "$CODE" "$(head -n 1 "$TMP" | cut -c1-500)" >&2; exit 1; }
# A relay can answer 200 with something other than the program, such as a
# mirror's error page. Checked before the running agent is stopped, so a batch
# run through such a relay leaves each machine on the agent it had, rather than
# on bytes that cannot start while this script reports success.
[ "$(head -c 4 "$TMP")" = "$(printf '\177ELF')" ] ||
	{ echo "the download is not a Linux executable: $(head -n 1 "$TMP" | tr -cd '[:print:]' | cut -c1-200)" >&2; exit 1; }

# Downloaded before the registration below, because that step spends a node: the
# key returns a token and the panel gains a row, while the env file recording it
# is only written once the binary is in place. A download that fails after
# registering therefore leaves an unusable node behind, and the rerun -- the
# documented way to recover -- registers a second one.
#
# --register exchanges a key for this node's own token, which is what allows one
# command to provision a batch of machines. The key is valid only within the
# window the panel opened and never becomes the credential the agent runs with.
if [ -z "$TOKEN" ]; then
	# Re-running the same command must not add a second node, so the token this
	# machine already holds travels with the key. The hub returns it unchanged
	# while it still opens a node, also after the window has closed; otherwise
	# the request is a new registration, which needs an open window. The env file
	# alone cannot tell a node deleted from the panel, and trusting it would keep
	# a revoked token while this installer reported success.
	#
	# Only for the same hub: a token issued by hub A means nothing to hub B.
	HELD=""
	# An env file written before the scheme was lowercased may hold HTTP://.
	CACHED=$(sed -n 's/^PROBE_SERVER=//p' "$ENV_FILE" 2>/dev/null || true)
	if [ "$(lower_scheme "${CACHED%/}")" = "${SERVER%/}" ]; then
		HELD=$(sed -n 's/^PROBE_TOKEN=//p' "$ENV_FILE" 2>/dev/null || true)
	fi
	# --name as given, which the hub trims and bounds. The hostname is not sent
	# in its place: it often carries the machine's address or the provider's
	# label, and the name reaches the public page. Without one the hub names
	# the node after its id.
	echo "registering ${NAME:-this machine} with the hub"
	# curl sends no header at all for an empty $HELD. The status follows the body
	# on a line of its own, so a refusal shows the hub's own reason: a closed
	# window, a lockout and a database error share one exit status under --fail.
	# A request that got no response stops here, with curl's own message. The
	# name travels on stdin: as an
	# argument, one beginning with @ would be read as a file to send.
	REPLY=$(printf '%s' "$NAME" | curl -sS --max-time 30 -w '\n%{http_code}' -H "Authorization: Bearer $REGISTER" \
		-H "X-Node-Token: $HELD" --data-binary @- "${SERVER%/}/api/agent/register") || exit 1
	CODE=$(printf '%s\n' "$REPLY" | tail -n 1)
	TOKEN=$(printf '%s\n' "$REPLY" | sed '$d')
	if [ "$CODE" != 200 ]; then
		# The hub answers in one line of text. A proxy or CDN in front may answer
		# with a page of HTML instead, of which the first line is enough.
		printf 'registration failed (HTTP %s): %s\n' "$CODE" "$(printf '%s\n' "$TOKEN" | head -n 1 | cut -c1-500)" >&2
		[ -z "$HELD" ] || echo "if this machine's node was deleted or its token reissued, the token it holds no longer counts." >&2
		exit 1
	fi
	[ -n "$TOKEN" ] || { echo "the hub answered without a token" >&2; exit 1; }
	if [ "$TOKEN" = "$HELD" ]; then
		echo "this machine is already registered; keeping its token and the name the panel shows"
	elif [ -n "$HELD" ]; then
		echo "the token this machine held no longer opens a node; registered as a new node."
		echo "if that token was reissued rather than its node deleted, delete the old node in the panel."
	fi
fi

# Stop an agent already running here before replacing its binary. The service
# name is fixed, so a reinstall could never start a second copy, but without this
# the new binary lands beneath a live process and only the restart at the end
# picks it up. Stopping first also means the copy does not depend on `install`
# unlinking rather than failing with ETXTBSY. Placed after the download, so a
# node that cannot fetch the binary keeps running.
if [ "$INIT" = openrc ]; then
	rc-service "$SVC" stop 2>/dev/null || true
else
	systemctl stop "$SVC" 2>/dev/null || true
	# An agent installed before the fixed user ran under DynamicUser=, and while
	# it runs nss-systemd resolves its transient user of the same name: the check
	# above reads that as this project's and creates nothing, and useradd would
	# refuse the name as taken. Stopping the unit releases that user, so asking
	# again here creates the fixed one. Should that fail, the old binary and unit
	# are still in place and are started again.
	ensure_user || {
		systemctl start "$SVC" 2>/dev/null || true
		exit 1
	}
fi
install -d -m 0755 "$ROOT"
# Kept until the new binary has proved it starts; see not_started. Never over
# an existing copy: a run that died before that check left an unproven binary
# in $BIN, and the copy is the one that ran before it.
[ ! -f "$BIN" ] || [ -f "$BIN.old" ] || cp "$BIN" "$BIN.old"
install -m 0755 "$TMP" "$BIN"

# The token lives in a root-only environment file rather than the unit, keeping
# it out of `systemctl cat` and the world-readable journal. 0600 root is what
# keeps it private, since $ROOT itself is readable and holds the binaries. Set in
# a subshell, because the unit file written below is read by anyone debugging
# with `systemctl cat` and need not be 0600.
(
	umask 077
	cat >"$ENV_FILE" <<ENV
PROBE_SERVER=$SERVER
PROBE_TOKEN=$TOKEN
ENV
	[ -z "$IFACE" ] || printf 'PROBE_IFACE=%s\n' "$IFACE" >>"$ENV_FILE"
)

# The new agent is not running. The binary it replaced is put back and started
# again, so a failed upgrade leaves the machine reporting as before; the unit
# and env file just written suit that binary as well, since an upgrade keeps the
# token and the settings. A first install has nothing to put back.
not_started() {
	echo "$SVC did not start; see: $1" >&2
	[ -f "$BIN.old" ] || exit 1
	mv -f "$BIN.old" "$BIN"
	if [ "$INIT" = openrc ]; then
		rc-service "$SVC" restart >/dev/null 2>&1 || true
	else
		systemctl restart "$SVC" || true
	fi
	echo "the previous $SVC binary is back in place and was restarted" >&2
	exit 1
}

if [ "$INIT" = openrc ]; then
	cat >"$RC_FILE" <<RC
#!/sbin/openrc-run
description="probe agent"
command="$BIN"
command_args="--interval $INTERVAL${INSECURE:+ --insecure}"
supervisor="supervise-daemon"
command_user="$USER_NAME"
respawn_delay=5
output_log="$LOG_FILE"
error_log="$LOG_FILE"

depend() {
	need net
}

# The token stays in the root-only env file rather than the service script;
# this runs as root, and the agent inherits what it exports. supervise-daemon
# opens the log only after dropping to command_user, so the file must be the
# agent's, including one an earlier install left to root.
start_pre() {
	checkpath --file --owner $USER_NAME --mode 0600 $LOG_FILE
	set -a
	. $ENV_FILE
	set +a
}
RC
	chmod 0755 "$RC_FILE"
	rc-update add "$SVC" default >/dev/null
	rc-service "$SVC" restart
	# supervise-daemon reports the service started while it respawns an agent
	# that exits at once, so the process itself is what is looked for, inside
	# the respawn delay. pidof rather than pgrep -x, which BusyBox matches
	# against the full path.
	sleep 3
	pidof "$SVC" >/dev/null || not_started "$LOG_FILE"
	rm -f "$BIN.old"
	echo "$SVC installed; follow it with: tail -f $LOG_FILE"
	exit 0
fi

cat >"$UNIT_FILE" <<UNIT
[Unit]
Description=probe agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$BIN --interval $INTERVAL${INSECURE:+ --insecure}
Restart=always
RestartSec=5
# A fixed user rather than DynamicUser=: when the mount namespace cannot be
# created, as in an LXC container without nesting, systemd skips ProtectSystem=
# and the other mount sandboxing for a unit with a static User=, but refuses to
# start one with DynamicUser= and exits 226/NAMESPACE. DynamicUser= also implied
# RestrictSUIDSGID=, which is therefore stated below.
User=$USER_NAME
NoNewPrivileges=yes
RestrictSUIDSGID=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
# AF_NETLINK is how getifaddrs(3) obtains this host's own addresses from the
# kernel; without it the agent reports none.
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK
MemoryMax=64M
# The agent needs no capability: it reads /proc, opens one socket, and runs as
# a plain user. The empty set makes that structural.
CapabilityBoundingSet=
# Kernel surfaces the agent never touches. Each is a mount-namespace option, so
# a container that cannot create one degrades to a warning rather than a unit
# that refuses to start.
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
# The agent creates no namespaces at run time.
RestrictNamespaces=yes
SystemCallArchitectures=native
# Sockets, files and the timer loop; reading /proc is unaffected, since a
# syscall filter says nothing about which paths are open to the service.
SystemCallFilter=@system-service
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null
# restart rather than `enable --now`: --now leaves an already-running service
# untouched, so reinstalling over a live agent would keep the old binary
# running.
systemctl restart "$SVC"
# Type=simple counts the service started once it is forked, so `restart` above
# succeeds also for one that fails at once -- a user it cannot resolve
# (217/USER), a binary that exits -- and is then restarted every RestartSec.
# Checked inside that window, so a batch run shows the failure on the machine
# where it happened rather than a line reading "installed".
sleep 3
systemctl is-active --quiet "$SVC" || not_started "journalctl -u $SVC -n 20"
rm -f "$BIN.old"
echo "$SVC installed; follow it with: journalctl -u $SVC -f"
