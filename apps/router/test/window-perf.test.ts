import { describe, expect, test } from "bun:test"
import type { Hex } from "viem"
import { keccak256, toBytes } from "viem"
import { WindowPerf, sweepWindows } from "../src/pay/window-perf.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const WINDOW = "7"
const MINUTE = 60

function holdWindow(booted: Booted, minTps = 1) {
  const now = booted.stack.clock()
  booted.indexer.windows.set(WINDOW, { id: 7n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: BigInt(now - 10), t1: BigInt(now + 7200), minTps, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
  booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
}

const draw = (booted: Booted, text: string, stream = false, extra: Record<string, string> = {}) =>
  booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", "x-offpeak-window": WINDOW, ...extra },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: text }], max_tokens: 8, stream }),
  })

const samples = (booted: Booted) =>
  booted.stack.db.query<{ window_id: string; minute: string; tokens_per_s: number; demanded: boolean }>("SELECT window_id, EXTRACT(EPOCH FROM ts)::bigint / 60 AS minute, tokens_per_s, demanded FROM shared.window_perf ORDER BY ts")

async function sweepAfter(booted: Booted, minutes: number) {
  booted.stack.setClock(booted.stack.clock() + minutes * MINUTE)
  await sweepWindows(booted.stack)
}

/** A clock and a stopwatch the test moves by hand. */
function manualPerf(start = 6_000) {
  let seconds = start
  let ms = 0
  return { perf: new WindowPerf(() => seconds, () => ms), tick: (by: number) => (ms += by), minute: () => (seconds += MINUTE) }
}

describe("the throughput meter", () => {
  test("a run of small quick requests reads at their real speed, not their token count", () => {
    const { perf, tick, minute } = manualPerf()
    for (let i = 0; i < 20; i++) {
      const flow = perf.begin(7n)
      tick(300) // Time to first token is not throughput.
      flow.tokens(1)
      tick(100)
      flow.tokens(9)
      flow.end()
      tick(2_000)
    }
    minute()
    const [row] = perf.take(minute())
    expect(row!.demanded).toBe(true)
    expect(row!.tokens).toBe(200)
    expect(row!.busyMs).toBe(2_000)
    expect((row!.tokens * 1000) / row!.busyMs).toBe(100)
  })

  test("a holder who got nothing reads zero, and the wait counts", () => {
    const { perf, tick, minute } = manualPerf()
    const flow = perf.begin(7n)
    tick(1_500)
    flow.end()
    const [row] = perf.take(minute())
    expect(row).toEqual({ windowId: 7n, minute: 100, tokens: 0, busyMs: 1_500, demanded: true })
  })

  test("two requests at once are one stretch of busy time, and a long one lands in the minutes it ran", () => {
    const { perf, tick, minute } = manualPerf()
    const a = perf.begin(7n)
    const b = perf.begin(7n)
    a.tokens(5)
    b.tokens(5)
    tick(1_000)
    a.tokens(5)
    b.tokens(5)
    a.end()
    minute()
    tick(2_000)
    b.tokens(10)
    b.end()
    const rows = perf.take(minute()).sort((x, y) => x.minute - y.minute)
    expect(rows.map((row) => [row.minute, row.tokens, row.busyMs])).toEqual([
      [100, 20, 1_000],
      [101, 10, 2_000],
    ])
  })

  test("a minute in progress is not handed over, and is not lost", () => {
    const { perf, tick } = manualPerf()
    const flow = perf.begin(7n)
    flow.tokens(1)
    tick(10)
    expect(perf.take(6_030)).toEqual([])
    flow.end()
    expect(perf.take(6_060).length).toBe(1)
    expect(perf.take(6_120)).toEqual([])
  })
})

describe("shared.window_perf", () => {
  test("many requests in one minute are one row, read the way settlement reads it", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    for (const text of ["one", "two", "three"]) expect((await draw(booted, text)).status).toBe(200)
    expect((await draw(booted, "four", true)).status).toBe(200)
    // On record at once, so a router that dies now cannot hide the demand.
    expect((await samples(booted)).rows.filter((row) => row.demanded).length).toBe(1)
    await sweepAfter(booted, 1)
    await sweepAfter(booted, 1)
    const rows = (await samples(booted)).rows.filter((row) => row.demanded)
    expect(rows.length).toBe(1)
    expect(rows[0]!.tokens_per_s).toBeGreaterThan(0)
    expect(String(rows[0]!.window_id)).toBe(WINDOW)
    const seconds = await booted.stack.db.query<{ second: string }>("SELECT EXTRACT(SECOND FROM ts)::int AS second FROM shared.window_perf")
    expect(seconds.rows.every((row) => Number(row.second) === 0)).toBe(true)
  })

  test("a host that serves nothing to a holder shows demand and no throughput", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.probesOk.clear()
    booted.stack.candidateCache.clear()
    expect((await draw(booted, "anyone")).status).toBe(503)
    await sweepAfter(booted, 2)
    const row = (await samples(booted)).rows.find((r) => r.demanded)!
    expect(row.tokens_per_s).toBe(0)
  })
