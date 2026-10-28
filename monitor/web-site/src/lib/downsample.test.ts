/// <reference types="node" />
// The charts draw at most one sample per CSS pixel, and the hub's rounding is
// only half of that promise: a hub from before `points`, or a response already
// in flight when the window narrowed, still lands at a day of minutes. These
// pin the second gate -- and, above all, that thinning never invents a line
// across an outage or flattens a spike.
import assert from "node:assert/strict"

import { decimate, lttb, samples } from "./downsample.ts"

// What the screen asks the hub for, in the unit the line is drawn in. These are
// the numbers P1 turns on: a 24h window must not arrive in more samples than
// the panel has pixels.
{
  // 1440-wide window, page column 1352, two panels sharing it across a 12px gap.
  assert.equal(samples(1352, 2, 12, 720), 670, "a desktop's half-width panel")
  // The same window on the latency tab, which spans the column, capped at what
  // the hub answers fastest.
  assert.equal(samples(1352, 1, 12, 1200), 1200)
  // A phone: one column, 360 CSS pixels of panel.
  assert.equal(samples(360, 1, 12, 720), 360, "one sample per pixel, not two per device pixel")
  // Narrower than the floor still asks for the floor, or a spike falls between
  // two samples.
  assert.equal(samples(200, 1, 12, 720), 240)
  // Nothing measured yet is not a request.
  assert.equal(samples(0, 2, 12, 720), 0)
  console.log("the budget is one sample per CSS pixel")
}

type Row = { ts: number; cpu?: number | null; rx?: number | null }

/** A run of `n` readings a minute apart, `cpu` from the given series. */
const run = (n: number, at: (i: number) => number = (i) => 10 + (i % 7)): Row[] =>
  Array.from({ length: n }, (_, i) => ({ ts: 1_700_000_000 + i * 60, cpu: at(i) }))

/** The row `withGaps` inserts where the node was silent: a timestamp only. */
const hole = (ts: number): Row => ({ ts })
const cpu = (row: Row) => row.cpu

// A window that already fits the budget comes back unchanged, holes included.
{
  const rows = [...run(100), hole(1_700_009_000), ...run(100).map((r) => ({ ...r, ts: r.ts + 10_000 }))]
  const out = lttb(rows, 400, cpu)
  assert.deepEqual(out, rows)
  console.log("a window inside the budget is returned untouched")
}

// A day of minutes into a 480-wide panel.
{
  const rows = run(1_440)
  const out = lttb(rows, 480, cpu)
  assert.equal(out.length, 480)
  assert.equal(out[0].ts, rows[0].ts, "the first reading is the start of the window")
  assert.equal(out.at(-1)?.ts, rows.at(-1)?.ts, "and the last is its end")
  // Order is the axis: picks are always taken left to right.
  for (let i = 1; i < out.length; i++) assert.ok(out[i].ts > out[i - 1].ts)
  console.log("a day thins to the panel's width, ends intact")
}

// A spike is the far corner of its bucket, which is what LTTB exists to keep.
// Averaging a bucket would erase this one: 1 of 600 readings.
{
  const rows = run(600)
  rows[300].cpu = 96
  const out = lttb(rows, 120, cpu)
  assert.ok(out.some((row) => row.cpu === 96), "the peak survives the thinning")
  console.log("a single spike is kept")
}

// The hole is not data. It is carried through as it arrived, and the runs on
// either side are thinned separately -- a pick cannot reach across it, so the
// drawn line still breaks where the node was silent.
{
  const left = run(200)
  const right = run(200, (i) => 40 + (i % 5)).map((row) => ({ ...row, ts: row.ts + 200 * 60 }))
  const gapTs = left.at(-1)!.ts + 30
  const rows = [...left, hole(gapTs), ...right]

  const out = lttb(rows, 60, cpu)
  const at = out.findIndex((row) => row.ts === gapTs)
  assert.ok(at > 0, "the gap row is still there")
  assert.equal(out[at].cpu, undefined, "and still carries no reading")
  assert.equal(out[0].ts, left[0].ts, "the left run keeps its start")
  assert.equal(out.at(-1)?.ts, right.at(-1)?.ts, "the right run keeps its end")
  // Nothing from the left run may land after the gap, or the two would be drawn
  // as one line with a kink in it.
  assert.ok(out.slice(0, at).every((row) => row.ts < gapTs))
  assert.ok(out.slice(at + 1).every((row) => row.ts > gapTs))
  assert.ok(out.slice(at + 1).length >= 3, "both runs keep enough to have a shape")
  console.log("a hole splits the series and is kept as it came")
}

// A run too short to thin keeps every reading: three points drawn as three
// points, not resampled into two.
{
  const rows = [...run(2), hole(1_700_000_300), ...run(2).map((row) => ({ ...row, ts: row.ts + 600 }))]
  const out = lttb(rows, 100, cpu)
  assert.equal(out.length, rows.length)
  console.log("short runs are left whole")
}

// The four resource panels share one row set, so every series gets a vote: a
// flat CPU must not be allowed to cut the network panel's peak.
{
  const rows: Row[] = Array.from({ length: 400 }, (_, i) => ({ ts: i * 60, cpu: 12, rx: 1_000 + (i % 4) }))
  rows[250].rx = 90_000
  const out = lttb(rows, 80, [(row) => row.cpu, (row) => row.rx])
  assert.ok(out.some((row) => row.rx === 90_000), "the rate's peak survives a flat CPU")
  console.log("each series votes on what is kept")
}

// An empty reading is a break, not a value.
{
  const rows: Row[] = [
    { ts: 1, cpu: 10 },
    { ts: 2, cpu: null },
    { ts: 3, cpu: 10 },
    ...Array.from({ length: 240 }, (_, i) => ({ ts: 4 + i * 60, cpu: 10 + (i % 3) })),
  ]
  const out = lttb(rows, 40, cpu)
  assert.ok(out.some((row) => row.ts === 2 && row.cpu === null), "and it is kept")
  assert.ok(out.length <= 40 + 3, "at no more than its own run's floor")
  console.log("an empty reading is a break, not a value")
}

// The guard is only for an answer still denser than the panel: it divides the
// budget between the series, keeps the ends and the peaks, and never exceeds
// the budget by more than one floor per series.
{
  const rows: Row[] = Array.from({ length: 10_080 }, (_, i) => ({
    ts: i * 60_000,
    cpu: 10 + (i % 7),
    rx: 1_000 + (i % 11),
  }))
  rows[5_000]!.cpu = 96
  rows[7_000]!.rx = 90_000
  const out = decimate(rows, 600, [(row) => row.cpu, (row) => row.rx])
  assert.ok(out.length <= 600 + 4, "two series stay within the guard")
  assert.equal(out[0]!.ts, rows[0]!.ts, "the first point is kept")
  assert.equal(out.at(-1)!.ts, rows.at(-1)!.ts, "the last point is kept")
  assert.ok(out.some((row) => row.cpu === 96), "the CPU peak survives")
  assert.ok(out.some((row) => row.rx === 90_000), "the network peak survives")
  console.log("the decimation guard keeps every series' peak")
}
{
  const rows = [...run(120), hole(1_700_009_000), ...run(120).map((row) => ({ ...row, ts: row.ts + 20_000 }))]
  const out = decimate(rows, 60, cpu)
  assert.ok(out.some((row) => row.ts === 1_700_009_000), "a hole is still a hole")
  assert.ok(out.length <= 64, "and the guard stays near budget")
}
{
  const rows = run(50)
  assert.deepEqual(decimate(rows, 100, cpu), rows, "a window inside the guard is untouched")
}
