/// <reference types="node" />
// The card's strip is the whole point of this theme, and it is drawn from data
// rather than from the DOM: folding an hour of buckets into twenty blocks, and
// deciding which of five colours each one is. Both are pure functions, so they
// are pinned here instead of being eyeballed in a browser.
import assert from "node:assert/strict"

import {
  BLOCK, buildSlots, cardProbes, fmtLoss, fmtMs, latencySignal, lossSignal, probeStats, RECENT, slotSignal,
  type PingData, type PingRow,
} from "./ping.ts"

// Five minutes is what the card's figure is read from; the tests below name
// buckets relative to that so the number is not a magic constant here.
assert.equal(RECENT, 300, "the reading is taken from the last five minutes")

const row = (task_id: number, ts: number, latency: number | null, loss?: number): PingRow =>
  loss === undefined ? { task_id, ts, latency } : { task_id, ts, latency, loss }

// Three buckets of one block fold into one: the mean of the two that answered,
// and a third of the block's loss for the one that timed out.
{
  const slots = buildSlots([row(1, 9100, 10), row(1, 9180, 20, 33), row(1, 9260, null)], 10_000, 5, BLOCK)
  assert.equal(slots.length, 5)
  assert.deepEqual(slots[0], { ts: 9100, latency: 15, loss: 133 / 3 })
  // A block with no rows is not a block with a zero in it.
  assert.deepEqual(slots.slice(1), [null, null, null, null])
  console.log("buckets fold into blocks, and an empty block stays empty")
}

// A block is named by the minute it opens on, not by the last bucket in it.
{
  const [first] = buildSlots([row(1, 9100, 10), row(1, 9260, 10)], 10_000, 5, BLOCK)
  assert.equal(first?.ts, 9100)
  const [, second] = buildSlots([row(1, 9280, 10)], 10_000, 5, BLOCK)
  assert.equal(second?.ts, 9280)
  console.log("a block is titled by its opening minute")
}

// A window is twenty blocks wide and ends where it is asked to: a row at `until`
// belongs to the next window, not to this one's last block.
{
  const rows = Array.from({ length: 60 }, (_, i) => row(1, 10_000 - 3_600 + i * 60, 20))
  const slots = buildSlots(rows, 10_000, 20, BLOCK)
  assert.equal(slots.filter(Boolean).length, 20)
  assert.deepEqual(buildSlots([row(1, 10_000, 10)], 10_000, 20, BLOCK).filter(Boolean), [])
  console.log("twenty blocks cover the hour, half-open at the end")
}

const data: PingData = {
  ping: [
    row(1, 9100, 30, 0), row(1, 9180, 40, 0), row(1, 9260, 50, 0),
    row(1, 10_060, null), row(1, 10_120, 60, 0),
    row(2, 9100, 200, 0),
  ],
  probes: { "3": "上海移动", "1": "上海电信", "2": "上海联通", "4": "北京电信" },
  // The window's own figure, which cannot be recovered from the buckets above.
  loss: { "1": 12.5 },
}

// The reading is the last five minutes' median, not the newest sample: at a
// one-minute interval one bucket is one probe, and a single lost packet used to
// blank the card for a whole minute.
{
  const probe = probeStats(data, { id: 1, name: "上海电信" }, 10_140, 20)
  // Buckets in the window (10060 null, 10120 answered 60): the median of what
  // answered is the 60.
  assert.equal(probe.reading, 60)
  assert.equal(probe.timedOut, false)
  assert.equal(probe.typical, 45)
  console.log("the figure is the last five minutes' median, with the hour's as its norm")
}

// A minute lost to a single timeout no longer hides the line: four answers in
// five keep the number, and the loss is printed beside it.
{
  const rows = [
    row(1, 10_060, 40, 0), row(1, 10_120, 42, 0), row(1, 10_180, null),
    row(1, 10_240, 44, 0), row(1, 10_300, 46, 0),
  ]
  const probe = probeStats({ ping: rows, probes: { "1": "上海电信" } }, { id: 1, name: "上海电信" }, 10_320, 20)
  assert.equal(probe.reading, 43, "median of the four that answered")
  assert.equal(probe.timedOut, false, "one lost bucket is not a dead line")
  console.log("one timed-out bucket stays a number on the card")
}

// Every bucket in the window lost: that is a line that is down, and the figure
// says so rather than showing the last thing it saw.
{
  const rows = [row(1, 10_060, 40, 0), row(1, 10_300, null), row(1, 10_360, null), row(1, 10_420, null)]
  const probe = probeStats({ ping: rows, probes: { "1": "上海电信" } }, { id: 1, name: "上海电信" }, 10_440, 20)
  assert.equal(probe.reading, null)
  assert.equal(probe.timedOut, true)
  console.log("five minutes of nothing is a timeout, not a stale figure")
}

// A probe that samples every half hour still gets a figure: the window ends at
// its own last sample, not at the strip's right edge.
{
  const rows = [row(1, 5_000, 30, 0), row(1, 6_800, 32, 0)]
  const probe = probeStats({ ping: rows, probes: { "1": "上海电信" } }, { id: 1, name: "上海电信" }, 10_000, 20)
  assert.equal(probe.reading, 32)
  assert.equal(probe.timedOut, false)
  console.log("a slow probe is read against its own samples")
}

// Loss comes from the response's window figure. Averaging the buckets instead
// would divide by a count that is not the number of samples taken.
{
  const probe = probeStats(data, { id: 1, name: "上海电信" }, 10_140, 20)
  assert.equal(probe.loss, 12.5)
  const clean = probeStats(data, { id: 2, name: "上海联通" }, 10_140, 20)
  assert.equal(clean.loss, 0)
  // Nothing retained at all is not the same as nothing lost.
  const none = probeStats(data, { id: 9, name: "无" }, 10_140, 20)
  assert.equal(none.loss, null)
  assert.equal(none.reading, null)
  assert.equal(none.timedOut, false)
  console.log("loss is the window figure, and no rows is not zero loss")
}

// Three probes are shown by id; a fourth is left to the node's page rather than
// halving the width of the other three.
{
  const shown = cardProbes(data, 10_000)
  assert.deepEqual(shown.map((p) => p.name), ["上海电信", "上海联通", "上海移动"])
  assert.equal(shown.length, 3)
  assert.deepEqual(cardProbes({ ping: [], probes: {} }, 10_000), [])
  console.log("the card takes the first three probes by id")
}

// The window is aligned to the block grid, so the strip's blocks are clock
// minutes and the hour in progress is the last block rather than a stub.
{
  assert.equal(cardProbes(data, 10_000)[0].slots.length, 20)
  assert.equal(cardProbes(data, 9930)[0].slots.length, 20)
  console.log("the strip is always twenty blocks")
}

// Loss is judged by its own figure: 1, 5, 15 and 40 per cent are the steps up.
assert.deepEqual(
  [null, 0, 1, 2, 5, 6, 15, 16, 40, 41].map(lossSignal),
  [0, 1, 1, 2, 2, 3, 3, 4, 4, 5],
)
console.log("loss reads five steps off absolute thresholds")

// Latency is judged against fixed bands rather than against the line's own
// median: a colour has to mean the same thing on every card, or a page of them
// cannot be compared with itself.
assert.equal(latencySignal(null), 0)
assert.equal(latencySignal(12), 1)
assert.equal(latencySignal(80), 1)
assert.equal(latencySignal(81), 2)
assert.equal(latencySignal(150), 2)
assert.equal(latencySignal(200), 3)
assert.equal(latencySignal(400), 4)
assert.equal(latencySignal(401), 5)
console.log("latency reads five bands at 80, 150, 250 and 400 ms")

// A block is coloured by its latency, and by its loss only once the loss is a
// run of missing packets: 2% of an hour is not a fault and must not paint one.
assert.equal(slotSignal({ ts: 0, latency: 40, loss: 0 }), 1)
assert.equal(slotSignal({ ts: 0, latency: 40, loss: 2 }), 1)
assert.equal(slotSignal({ ts: 0, latency: 40, loss: 9 }), 1)
assert.equal(slotSignal({ ts: 0, latency: 40, loss: 12 }), 2)
assert.equal(slotSignal({ ts: 0, latency: 40, loss: 31 }), 3)
assert.equal(slotSignal({ ts: 0, latency: 40, loss: 60 }), 5)
// A slow block climbs with it, and the scale stops at five.
assert.equal(slotSignal({ ts: 0, latency: 300, loss: 0 }), 4)
assert.equal(slotSignal({ ts: 0, latency: 300, loss: 12 }), 5)
assert.equal(slotSignal({ ts: 0, latency: null, loss: 100 }), 5)
assert.equal(slotSignal(null), 0)
console.log("a block is coloured by its latency, escalated only by real loss")

assert.equal(fmtMs(3.44), "3.4")
assert.equal(fmtMs(34.6), "35")
assert.equal(fmtLoss(0), "0")
assert.equal(fmtLoss(0.05), "<0.1")
assert.equal(fmtLoss(3.25), "3.3")
assert.equal(fmtLoss(42.1), "42")
console.log("figures keep the precision their column has room for")
