import { describe, expect, test } from "bun:test"
import type { Hex } from "viem"
import { keccak256, toBytes } from "viem"
import { WindowPerf, sweepWindows } from "../src/pay/window-perf.ts"
import { firstTokenLimitMs, startCost } from "../src/routing/dispatch.ts"
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

  test("a host asked that serves nothing to a holder shows demand and no throughput", async () => {
    const booted = await bootStack({ failHost: true })
    holdWindow(booted)
    expect((await draw(booted, "anyone")).status).toBe(503)
    await sweepAfter(booted, 2)
    const row = (await samples(booted)).rows.find((r) => r.demanded)!
    expect(row.tokens_per_s).toBe(0)
  })

  /** Asks every minute of an outage, then reads the Window the way settlement and the contract do. */
  async function outage(booted: Booted, minutes: number, minTps: number) {
    for (let i = 0; i < minutes; i++) {
      expect((await draw(booted, "anyone")).status).toBe(503)
      booted.stack.setClock(booted.stack.clock() + MINUTE)
    }
    const rows = (await samples(booted)).rows.filter((row) => row.demanded)
    const below = rows.filter((row) => row.tokens_per_s < minTps).length
    return { measured: rows.length, below, failed: below * 10_000 > 2_000 * rows.length }
  }

  test("a Window host that is down shows demand and no throughput", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.probesOk.clear()
    booted.stack.candidateCache.clear()
    expect((await draw(booted, "anyone")).status).toBe(503)
    expect((await samples(booted)).rows.filter((row) => row.demanded).length).toBe(1)
    await sweepAfter(booted, 2)
    const row = (await samples(booted)).rows.find((r) => r.demanded)!
    expect(row.tokens_per_s).toBe(0)
  })

  test("thirty minutes of a host down fails the Window", async () => {
    const booted = await bootStack()
    holdWindow(booted, 100)
    booted.stack.probesOk.clear()
    booted.stack.candidateCache.clear()
    expect(await outage(booted, 30, 100)).toEqual({ measured: 30, below: 30, failed: true })
  })

  test("a good start does not hide an outage, once the errors unroute the host", async () => {
    const booted = await bootStack()
    holdWindow(booted, 1)
    for (let i = 0; i < 10; i++) {
      expect((await draw(booted, "good")).status).toBe(200)
      booted.stack.setClock(booted.stack.clock() + MINUTE)
    }
    const real = booted.hostApps.get(booted.host)!
    booted.hostApps.set(booted.host, { request: (path: string, init: RequestInit) => (path === "/offpeak/v1/chat/completions" ? new Response("boom", { status: 500 }) : real.request(path, init)) } as never)
    const seen = await outage(booted, 30, 1)
    expect(booted.stack.load.errorRate(booted.host)).toBeGreaterThanOrEqual(0.05)
    expect(seen).toEqual({ measured: 40, below: 30, failed: true })
  })

  test("a Window host that has left the market fails its holders too", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.sheets.length = 0
    booted.stack.candidateCache.clear()
    expect((await draw(booted, "anyone")).status).toBe(503)
    expect((await samples(booted)).rows.filter((row) => row.demanded).length).toBe(1)
  })

  test("a host slow to first tokens is still asked, so what it serves is what goes on record", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    for (let i = 0; i < 20; i++) booted.stack.load.noteTtft(booted.host, 2_000)
    booted.stack.candidateCache.clear()
    expect((await draw(booted, "anyone")).status).toBe(200)
    const rows = (await samples(booted)).rows.filter((row) => row.demanded)
    expect(rows.length).toBe(1)
    expect(rows[0]!.tokens_per_s).toBeGreaterThan(0)
  })

  test("a holder's load that unroutes the host leaves no demand", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.load.util = () => 1
    booted.stack.candidateCache.clear()
    expect((await draw(booted, "anyone")).status).toBe(503)
    await sweepAfter(booted, 2)
    expect((await samples(booted)).rows.every((row) => !row.demanded)).toBe(true)
  })

  /** Answers with nothing but a `stop`, the way an engine does when a buyer's stop string matches at once. */
  function replyEmpty(booted: Booted) {
    const real = booted.hostApps.get(booted.host)!
    const empty = 'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    booted.hostApps.set(booted.host, {
      request: async (path: string, init: RequestInit) => {
        const res = await real.request(path, init)
        return path === "/offpeak/v1/chat/completions" ? new Response(empty, { headers: { "content-type": "text/event-stream" } }) : res
      },
    } as never)
  }

  test("a reply that finished empty is no failure of the host, streamed or not", async () => {
    for (const stream of [false, true]) {
      const booted = await bootStack()
      holdWindow(booted)
      replyEmpty(booted)
      const res = await draw(booted, "anyone", stream)
      await res.text()
      await sweepAfter(booted, 2)
      expect((await samples(booted)).rows.every((row) => !row.demanded)).toBe(true)
    }
  })

  test("a reply that broke before its first token is one", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const real = booted.hostApps.get(booted.host)!
    const broken = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
        controller.error(new Error("host died"))
      },
    })
    booted.hostApps.set(booted.host, { request: (path: string, init: RequestInit) => (path === "/offpeak/v1/chat/completions" ? new Response(broken, { headers: { "content-type": "text/event-stream" } }) : real.request(path, init)) } as never)
    await (await draw(booted, "anyone")).text()
    await sweepAfter(booted, 2)
    const row = (await samples(booted)).rows.find((r) => r.demanded)!
    expect(row.tokens_per_s).toBe(0)
  })

  test("an idle minute of an active Window is on record as no demand, and a closed Window stops", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    for (let i = 0; i < 4; i++) await sweepAfter(booted, 1)
    expect((await samples(booted)).rows.length).toBeGreaterThan(0)
    expect((await samples(booted)).rows.every((row) => !row.demanded)).toBe(true)
    booted.indexer.windows.clear()
    const count = (await samples(booted)).rows.length
    await sweepAfter(booted, 2)
    await sweepAfter(booted, 2)
    expect((await samples(booted)).rows.length).toBeLessThanOrEqual(count + 1)
  })

  test("two routers merge one minute, and it is written once", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const { db } = booted.stack
    const minute = Math.floor(booted.stack.clock() / MINUTE)
    const flush = (tokens: number, busy: number) =>
      db.query(
        `INSERT INTO serving.window_minutes (window_id, minute, tokens, busy_ms, demanded) VALUES (7,$1,$2,$3,true)
         ON CONFLICT (window_id, minute) DO UPDATE SET tokens = serving.window_minutes.tokens + EXCLUDED.tokens, busy_ms = GREATEST(serving.window_minutes.busy_ms, EXCLUDED.busy_ms)`,
        [minute, tokens, busy],
      )
    await flush(100, 1_000)
    await flush(100, 500)
    await sweepAfter(booted, 2)
    await sweepAfter(booted, 1)
    const row = (await samples(booted)).rows.find((r) => r.demanded)!
    expect(row.tokens_per_s).toBe(200)
  })

  test("a failure to write a sample cannot fail a request", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    await booted.stack.db.exec("ALTER TABLE shared.window_perf RENAME TO window_perf_gone")
    expect((await draw(booted, "draw")).status).toBe(200)
  })

  test("a demanded minute stays demanded when the sweep finds no flush for it, as after a crash", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    expect((await draw(booted, "one")).status).toBe(200)
    booted.stack.windowPerf.take(booted.stack.clock() + MINUTE)
    await booted.stack.db.query("UPDATE shared.window_perf SET tokens_per_s = 42")
    const minute = Math.floor(booted.stack.clock() / MINUTE)
    await booted.stack.db.query("INSERT INTO serving.window_minutes (window_id, minute) VALUES (7, $1)", [minute])
    await sweepAfter(booted, 2)
    const row = (await samples(booted)).rows.find((r) => Number(r.minute) === minute)!
    expect(row.demanded).toBe(true)
    expect(row.tokens_per_s).toBe(42)
  })
})

describe("the wait for a first token", () => {
  const LONG = "x ".repeat(3_000)

  /** A host that takes this long to answer, and gives up on an abort the way a real fetch does. */
  function slowHost(booted: Booted, waitMs: (payload: string) => number) {
    const real = booted.stack.hosts.request
    booted.stack.hosts.request = (host, endpoint, path, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(real(host, endpoint, path, init)), waitMs(String(init?.body)))
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new DOMException("The operation was aborted", "AbortError"))
        })
      })
  }

  const demanded = async (booted: Booted) => (await samples(booted)).rows.filter((row) => row.demanded)

  test("grows with the prompt past the length TTFT is scaled to, and stops at the longest a request runs", async () => {
    const { stack } = await bootStack()
    expect(firstTokenLimitMs(stack, 10)).toBe(3_000)
    expect(firstTokenLimitMs(stack, 1_024)).toBe(3_000)
    expect(firstTokenLimitMs(stack, 8_192)).toBe(24_000)
    expect(firstTokenLimitMs(stack, 10_000_000)).toBe(600_000)
  })

  test("a long prompt inside its time is served", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.ttftFailoverMs = 20
    slowHost(booted, (payload) => (payload.length > 1_000 ? 40 : 0))
    expect((await draw(booted, LONG)).status).toBe(200)
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
  })

  test("a long prompt that runs out of time leaves the error rate and window_perf as they were, and the host in routing", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.ttftFailoverMs = 5
    slowHost(booted, (payload) => (payload.length > 1_000 ? 10_000 : 0))
    expect((await draw(booted, LONG)).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
    await sweepAfter(booted, 2)
    expect(await demanded(booted)).toEqual([])
    booted.stack.candidateCache.clear()
    expect((await draw(booted, "short")).status).toBe(200)
  })

  test("a host silent on a short prompt still counts", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.ttftFailoverMs = 5
    slowHost(booted, () => 10_000)
    expect((await draw(booted, "short")).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(1)
    await sweepAfter(booted, 2)
    expect((await demanded(booted))[0]!.tokens_per_s).toBe(0)
  })

  /** A short prompt with `extra` on the body, from a holder or, with `hold` off, an ordinary buyer. */
  const drawWith = (booted: Booted, extra: object, hold = true) =>
    booted.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", ...(hold ? { "x-offpeak-window": WINDOW } : {}) },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "short" }], max_tokens: 8, ...extra }),
    })

  const schemaOf = (bytes: number) => ({ type: "json_schema", json_schema: { name: "s", schema: { description: "x".repeat(bytes) } } })

  test("counts the whole body and any compiling, not only the prompt", () => {
    expect(startCost(10, "x".repeat(100), {})).toEqual({ tokens: 25, compiles: false })
    expect(startCost(10, "x".repeat(40_000), {})).toEqual({ tokens: 10_000, compiles: false })
    expect(startCost(10, "x".repeat(100), { temperature: 0.5 } as object)).toEqual({ tokens: 25, compiles: false })
    expect(startCost(10, "x".repeat(100), { response_format: { type: "json_object" } })).toEqual({ tokens: 4_096, compiles: true })
    expect(startCost(10, "x".repeat(100), { tools: [] })).toEqual({ tokens: 4_096, compiles: true })
  })

  test("a 4 MB schema on a short prompt is refused unsent, and leaves the error rate and window_perf as they were", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    let asked = 0
    const real = booted.stack.hosts.request
    booted.stack.hosts.request = (host, endpoint, path, init) => {
      asked += 1
      return real(host, endpoint, path, init)
    }
    const res = await drawWith(booted, { response_format: schemaOf(4_000_000) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("response_format_too_large")
    expect(asked).toBe(0)
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
    await sweepAfter(booted, 2)
    expect(await demanded(booted)).toEqual([])
  })

  test("a schema that runs out of time on a short prompt leaves the error rate and window_perf as they were, and the host in routing", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.ttftFailoverMs = 5
    slowHost(booted, (payload) => (payload.includes("response_format") ? 10_000 : 0))
    expect((await drawWith(booted, { response_format: schemaOf(1_000) })).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
    await sweepAfter(booted, 2)
    expect(await demanded(booted)).toEqual([])
    booted.stack.candidateCache.clear()
    expect((await drawWith(booted, {}, false)).status).toBe(200)
  })

  test("a padded body that runs out of time on a short prompt is no failure of the host either", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.ttftFailoverMs = 5
    slowHost(booted, (payload) => (payload.includes("padding") ? 10_000 : 0))
    expect((await drawWith(booted, { padding: "x".repeat(20_000) })).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
    await sweepAfter(booted, 2)
    expect(await demanded(booted)).toEqual([])
  })

  test("a first token slowed by a schema does not read as a slow host", async () => {
    const booted = await bootStack()
    booted.stack.ttftFailoverMs = 1_000
    slowHost(booted, (payload) => (payload.includes("response_format") ? 30 : 0))
    expect((await drawWith(booted, { response_format: schemaOf(1_000) }, false)).status).toBe(200)
    expect(booted.stack.load.ttftP95(booted.host)).toBe(0)
  })

  test("a host silent on a short prompt with ordinary settings still counts", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.ttftFailoverMs = 5
    slowHost(booted, () => 10_000)
    expect((await drawWith(booted, { temperature: 0.7, top_p: 0.9 })).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(1)
    await sweepAfter(booted, 2)
    expect((await demanded(booted))[0]!.tokens_per_s).toBe(0)
  })
})

describe("strings that are not well-formed", () => {
  /** A holder's raw JSON, with the host counting how often it is asked. */
  function rawDraw(booted: Booted) {
    let asked = 0
    const real = booted.stack.hosts.request
    booted.stack.hosts.request = (host, endpoint, path, init) => {
      if (path === "/offpeak/v1/chat/completions") asked += 1
      return real(host, endpoint, path, init)
    }
    const send = (body: string) =>
      booted.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", "x-offpeak-window": WINDOW },
        body,
      })
    return { send, asked: () => asked }
  }

  const records = async (booted: Booted) => (await booted.stack.db.query("SELECT 1 FROM shared.usage_records")).rows.length

  test("a lone surrogate anywhere in the body is refused before the Window flow, and bills nothing", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const { send, asked } = rawDraw(booted)
    const user = { role: "user", content: "hi" }
    const bodies = [
      { model: "ofm-8b", messages: [{ role: "user", content: "hi \ud800" }] },
      { model: "ofm-8b", messages: [{ role: "user", content: [{ type: "text", text: "\udc00 reversed \ud83d" }] }] },
      { model: "ofm-8b", messages: [user], stop: ["\ud800"] },
      { model: "ofm-8b", messages: [user], response_format: { type: "json_schema", json_schema: { schema: { "\ud800": 1 } } } },
    ]
    for (const body of bodies) {
      const res = await send(JSON.stringify(body))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_unicode")
    }
    expect(asked()).toBe(0)
    expect(await records(booted)).toBe(0)
    await sweepAfter(booted, 2)
    expect((await samples(booted)).rows.filter((row) => row.demanded)).toEqual([])
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
  })

  test("normal Unicode is served, written out or escaped as a pair", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const { send } = rawDraw(booted)
    expect((await send(JSON.stringify({ model: "ofm-8b", max_tokens: 8, messages: [{ role: "user", content: "naïve 日本語 😀" }] }))).status).toBe(200)
    expect((await send('{"model":"ofm-8b","max_tokens":8,"messages":[{"role":"user","content":"\\ud83d\\ude00 and a literal \\\\ud800"}]}')).status).toBe(200)
    expect(await records(booted)).toBe(2)
  })

  test("a body nested too deep to walk by recursion is still refused cleanly", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const { send, asked } = rawDraw(booted)
    const deep = "[".repeat(1_000_000) + "]".repeat(1_000_000)
    const res = await send(`{"model":"ofm-8b","messages":[{"role":"user","content":"hi"}],"junk":${deep}}`)
    expect(res.status).toBe(400)
    expect(asked()).toBe(0)
  })
})

describe("X-Offpeak-Window", () => {
  test("a Window for another model does not draw, and says why", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const row = booted.indexer.windows.get(WINDOW)! as { modelDigest: Hex }
    row.modelDigest = keccak256(toBytes("another-model"))
    const res = await draw(booted, "wrong")
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("window_wrong_model")
    expect((await draw(booted, "fallback", false, { "x-offpeak-window-fallback": "prepaid" })).status).toBe(200)
    const records = await booted.stack.db.query<{ pay_mode: number }>("SELECT pay_mode FROM shared.usage_records")
    expect(records.rows.map((r) => r.pay_mode)).toEqual([0])
  })

  test("outside its hours a Window says so", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    booted.stack.setClock(booted.stack.clock() + 8_000)
    const res = await draw(booted, "late")
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("window_not_active")
  })

  test("a price cap does not apply to tokens already paid for, and the price shown is zero", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    const res = await draw(booted, "capped", false, { "x-offpeak-max-price": "in=0.000001,out=0.000001" })
    expect(res.status).toBe(200)
    expect(res.headers.get("x-offpeak-price")).toBe("in=0,out=0")
  })

  test("everyone else is served from what is left of a Window's host", async () => {
    const booted = await bootStack()
    holdWindow(booted, 70)
    await sweepWindows(booted.stack)
    expect(booted.stack.windowShares.get(`${booted.host}:${booted.modelDigest}`)).toBe(0.7)
    const prepaid = () =>
      booted.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "outside" }], max_tokens: 8 }),
      })
    expect((await prepaid()).status).toBe(200)
    booted.stack.load.note(booted.host, booted.modelDigest, "output", 40, booted.stack.clock() - 1)
    booted.stack.candidateCache.clear()
    booted.stack.load.util = () => 0.5
    expect((await prepaid()).status).toBe(503)
    expect((await draw(booted, "holder")).status).toBe(200)
  })

  test("the share a Window keeps is capped, and an ended Window keeps none", async () => {
    const booted = await bootStack()
    holdWindow(booted, 500)
    await sweepWindows(booted.stack)
    expect(booted.stack.windowShares.get(`${booted.host}:${booted.modelDigest}`)).toBe(0.7)
    booted.stack.setClock(booted.stack.clock() + 8_000)
    await sweepWindows(booted.stack)
    expect(booted.stack.windowShares.size).toBe(0)
  })
})
