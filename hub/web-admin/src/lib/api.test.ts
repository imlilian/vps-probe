/// <reference types="node" />
import assert from "node:assert/strict"
import { addressFromOrigin, badIfaceName, behind, changes, currentIface, GIB, groupsOf, healthProbe, ifaceChoice, ifaceSpec, inGroup, loopbackOrigin, outdatedAgents, provisioningSite, provisionRefusal, shortAddress, trafficCorrection } from "./api.ts"

assert.deepEqual(changes({ public: true, price: 5 }, { price: 20 }), { price: 20 })
assert.deepEqual(changes({ total_rx: "100", month_tx: "2" }, { total_rx: "100", month_tx: "3" }), { month_tx: "3" })
assert.deepEqual(changes({ expires_at: "2030-01-01" as string | null }, { expires_at: null }), { expires_at: null })
assert.equal(provisioningSite("https://monitor.example.com:8443/"), "https://monitor.example.com:8443")
for (const site of ["http://monitor.example.com", "https://127.0.0.1", "https://[::1]", "https://2130706433", "https://0x7f000001", "https://localhost", "https://user@monitor.example.com", "https://monitor.example.com/path"]) {
  assert.equal(provisioningSite(site), "", site)
}
// A tunnelled panel: the hub allows it alongside --site, so the panel must read
// the same addresses as loopback, and a name merely beginning with one as not.
for (const origin of ["http://127.0.0.1:9911", "http://localhost:9911", "http://[::1]:9911", "https://127.0.0.1"]) {
  assert.equal(loopbackOrigin(origin), true, origin)
}
for (const origin of ["https://monitor.example.com", "http://127.0.0.1.example.com", "ftp://127.0.0.1", "nonsense"]) {
  assert.equal(loopbackOrigin(origin), false, origin)
}
// The address the panel offers to fill in, taken from the bar: only an https
// entry qualifies, and the port travels with it because the setting keeps one.
assert.equal(addressFromOrigin("https://monitor.example.com"), "monitor.example.com")
assert.equal(addressFromOrigin("https://monitor.example.com:8443"), "monitor.example.com:8443")
for (const origin of ["http://monitor.example.com", "http://127.0.0.1:28080", "nonsense", ""]) {
  assert.equal(addressFromOrigin(origin), "", origin)
}

// The address an outside monitor is given, and whether it can leave this host:
// a tunnel's loopback port is an address only the hub's own machine could ask.
// Plain http is not refused here, unlike an install command -- a checker beside
// the hub is a legitimate one.
assert.deepEqual(healthProbe("https://hub.example.com"), { url: "https://hub.example.com/api/health", external: true })
assert.deepEqual(healthProbe("https://hub.example.com:8443/"), { url: "https://hub.example.com:8443/api/health", external: true })
assert.deepEqual(healthProbe("http://127.0.0.1:28080"), { url: "http://127.0.0.1:28080/api/health", external: false })
assert.deepEqual(healthProbe("https://hub.example.com/nested"), { url: "https://hub.example.com/api/health", external: true })
for (const nothing of ["", "nonsense"]) {
  assert.deepEqual(healthProbe(nothing), { url: "", external: false }, nothing)
}

// The refusal names the cause the operator can act on, as the hub decides it.
// A loopback address is a bad address, not a missing one -- and "missing" now
// names both ways to give it, the flag and the panel's own setting.
for (const [origin, site, cause] of [
  ["https://monitor.example.com", "", ""],
  ["https://monitor.example.com", "https://hub.example.com", ""],
  ["http://127.0.0.1:9911", "https://hub.example.com", ""],
  ["http://127.0.0.1:9911", "", "站点 URL"],
  ["http://127.0.0.1:9911", "http://127.0.0.1:28080", "不是 https 域名"],
  ["https://monitor.example.com", "https://198.51.100.1", "不是 https 域名"],
  ["http://198.51.100.1:28080", "https://hub.example.com", "请通过 HTTPS 域名"],
]) {
  const refusal = provisionRefusal(origin, site)
  assert.ok(cause ? refusal.includes(cause) : refusal === "", `${origin} ${site}: ${refusal}`)
}
// A node that never reported carries no version, an unreachable GitHub leaves no
// published one, and a locally built agent ahead of the release is not one to
// upgrade: none of the three is an upgrade to offer.
const fleet = [{ agent_version: "1.1.0" }, { agent_version: "1.0.9" }, { agent_version: "" }, { agent_version: "1.1.1" }]
assert.deepEqual(outdatedAgents(fleet, "1.1.0"), [{ agent_version: "1.0.9" }])
assert.deepEqual(outdatedAgents(fleet, ""), [])
assert.deepEqual(outdatedAgents([{ agent_version: "1.2" }], "1.2.0"), [])
assert.deepEqual(outdatedAgents([{ agent_version: "1.2.0-dev" }], "1.2.0"), [{ agent_version: "1.2.0-dev" }])
// The hub's own version goes through the same comparison.
assert.equal(behind("1.2.0", "1.10.0"), true)
assert.equal(behind("1.3.0", "1.2.0"), false)
assert.equal(behind("1.2.0", ""), false)
// An inherited asset re-publishes a component's own version unchanged: equal
// versions are no update, so a hub-only release never marks the agent card.
assert.equal(behind("1.2.0", "1.2.0"), false)
assert.equal(behind("", "1.2.0"), false)

// An emptied traffic field means the counter is not to be corrected. Sent as 0
// it would clear a lifetime total, which must never decrease.
const shown = { total_rx: "1.5", total_tx: "2", month_rx: "0.25", month_tx: "1" }
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "" }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "   " }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "0" }), { total_rx: 0 })
assert.deepEqual(trafficCorrection(shown, { ...shown, total_tx: "3" }), { total_tx: 3 * GIB })
assert.deepEqual(trafficCorrection(shown, shown), {})
// A long IPv6 keeps two groups each side; short ones and IPv4 are left whole,
// and a :: in what is kept survives.
assert.equal(shortAddress("2605:52c0:1:ca9:be24:11ff:fe84:2c48"), "2605:52c0…fe84:2c48")
assert.equal(shortAddress("2604:a880:800:10::7a1:e001"), "2604:a880…7a1:e001")
assert.equal(shortAddress("2a0e:1d80:ffff:ffff::1234"), "2a0e:1d80…ffff::1234")
assert.equal(shortAddress("2001:db8:1054:84::a4"), "2001:db8:1054:84::a4")
assert.equal(shortAddress("203.0.113.84"), "203.0.113.84")
console.log("partial edits, traffic corrections and provisioning checks passed")

// --iface from the two lists the install dialogs show, and back.
assert.equal(ifaceSpec({ only: " eth1, pppoe-wan ", skip: "" }), "eth1,pppoe-wan")
assert.equal(ifaceSpec({ only: "", skip: "vxlan100, nebula1" }), "-vxlan100,-nebula1")
assert.equal(ifaceSpec({ only: "enp1s0", skip: "enp5s0" }), "enp1s0,-enp5s0")
assert.equal(ifaceSpec({ only: "", skip: "" }), "", "both empty restores the default rules")
// Each of these the agent would refuse, or would match nothing without a word.
for (const bad of ["eth0 eth1", "eth*", "-eth0", "eth0;reboot", "eth0'"]) {
  assert.equal(ifaceSpec({ only: bad, skip: "" }), null, bad)
  assert.equal(ifaceSpec({ only: "", skip: bad }), null, bad)
}
// The dialog names the offender and marks the field it sits in.
assert.deepEqual(badIfaceName({ only: "eth0", skip: "vxlan100, eth*" }), { list: "skip", name: "eth*" })
assert.equal(badIfaceName({ only: "eth0", skip: "vxlan100" }), undefined)
assert.deepEqual(ifaceChoice("eth1,-vxlan100,pppoe-wan"), { only: "eth1,pppoe-wan", skip: "vxlan100" })
assert.equal(ifaceSpec(ifaceChoice("enp1s0,-enp5s0")), "enp1s0,-enp5s0")
// A node not reporting tells nothing; an agent predating --iface runs the default rules.
assert.equal(currentIface({ metrics: null }), undefined)
assert.equal(currentIface({ metrics: {} as never }), "")
assert.equal(currentIface({ metrics: { iface: "eth1,-eth0" } as never }), "eth1,-eth0")

// Groups follow the node order, and the filter keeps ungrouped nodes apart from
// a group whose name merely resembles a sentinel.
const fleet2 = [{ group: "东京" }, { group: "" }, { group: "none" }, { group: "东京" }, {}]
assert.deepEqual(groupsOf(fleet2), ["东京", "none"])
assert.equal(inGroup(fleet2, "all").length, 5)
assert.equal(inGroup(fleet2, "none").length, 2)
assert.deepEqual(inGroup(fleet2, "=none"), [{ group: "none" }])
assert.equal(inGroup(fleet2, "=东京").length, 2)


