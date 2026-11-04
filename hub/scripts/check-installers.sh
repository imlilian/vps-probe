#!/bin/sh
# Checks the contract the two installers share, which neither file can see.
#
# install-hub.sh and install-agent.sh run side by side on a hub that also reports
# for itself, and both write under one directory. They are deliberately separate
# files -- each is fetched on its own, one from a release, one from the hub, so
# neither can source the other -- which leaves three things stated twice:
#
#   1. the directory is the same, or the two cannot find each other's files
#   2. the two accounts differ, or the agent can read the hub's database, which
#      holds every node token in the fleet
#   3. account() and ours() agree, since they are the same test written twice
#
# Run from anywhere; CI runs it beside shellcheck.
set -eu
cd "$(dirname "$0")/.."

HUB=install-hub.sh
AGENT=install-agent.sh
FAIL=0

fail() { printf '  ✗ %s\n' "$1" >&2; FAIL=1; }
pass() { printf '  ✓ %s\n' "$1"; }

# The value of a `NAME="value"` line, empty when there is none.
value() { sed -n "s/^$2=\"\([^\"]*\)\"\$/\1/p" "$1" | head -n 1; }

# The account each script runs its service as. Both name it through a single
# constant rather than writing it at the useradd call, so there is one value to
# compare and a rename stays one line.
hub_svc="$(value "$HUB" SERVICE)"
agent_svc="$(value "$AGENT" SVC)"
[ -n "$hub_svc" ] || fail "$HUB 里找不到 SERVICE="
[ -n "$agent_svc" ] || fail "$AGENT 里找不到 SVC="
grep -q '^USER_NAME="\$SERVICE"$' "$HUB" ||
	fail "$HUB 的账号名应当派生自 SERVICE，而不是另写一个"
grep -q '^USER_NAME="\$SVC"$' "$AGENT" ||
	fail "$AGENT 的账号名应当派生自 SVC，而不是另写一个"

if [ "$hub_svc" = "$agent_svc" ]; then
	fail "两个服务用同一个账号（$hub_svc）：agent 就能读到 hub 的数据库，里面是整支舰队的 token"
else
	pass "账号分开：hub $hub_svc / agent $agent_svc"
fi

hub_root="$(value "$HUB" ROOT)"
agent_root="$(value "$AGENT" ROOT)"
if [ -z "$hub_root" ] || [ "$hub_root" != "$agent_root" ]; then
	fail "共享目录不一致：hub [$hub_root] / agent [$agent_root]"
else
	pass "共享目录：$hub_root"
fi

# The two copies of the account test, compared whole. Extracted by their opening
# and closing braces, which both fenced their bodies with.
copy() { sed -n "/^$2() {/,/^}\$/p" "$1"; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for fn in account ours; do
	copy "$HUB" "$fn" >"$tmp/hub.$fn"
	copy "$AGENT" "$fn" >"$tmp/agent.$fn"
	if [ ! -s "$tmp/hub.$fn" ] || [ ! -s "$tmp/agent.$fn" ]; then
		fail "$fn() 在两个脚本里没有都找到"
	elif ! diff -u "$tmp/hub.$fn" "$tmp/agent.$fn" >"$tmp/diff.$fn"; then
		fail "$fn() 两份实现不一致（同一台机器上的同一件事）："
		sed -n '3,$p' "$tmp/diff.$fn" >&2
	else
		pass "$fn() 两份实现一致"
	fi
done

exit "$FAIL"
