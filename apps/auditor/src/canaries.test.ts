import { describe, expect, test } from "bun:test"
import { mulberry32, publishedBaseline } from "@offpeak/audit-tests"
import { HOST_STATUS, weekIndex, type Hex } from "@offpeak/shared"
import type { Db } from "../../../services/common/src/db.ts"
import { Metrics } from "../../../services/common/src/metrics.ts"
import { issueKey } from "../../router/src/pipeline.ts"
import { bootStack } from "../../router/test/support/stack.ts"
import {
  CANARY_BOOST,
  CANARY_SHARE,
  MIN_AUDITED_PER_WEEK,
  answerAccepted,
  arrivals,
  canaryRate,
  canaryThreshold,
  chooseCanary,
  deterministicCanary,
  deterministicPool,
  drawShape,
  normaliseAnswer,
  openCanary,
  planCanaries,
  refreshAccepted,
  sendCanary,
  type CanaryAccount,
} from "./canaries.ts"
import { SAMPLE_CORPUS_PATH, corpusFigures, readCorpus } from "./corpus.ts"
import type { AuditDeps } from "./deps.ts"
import { trafficShape, type TrafficShape } from "./sample.ts"

const TOKEN = "internal-token-0123456789abcdef-0123"
const corpus = readCorpus(SAMPLE_CORPUS_PATH)
const shape = (over: Partial<TrafficShape> = {}): TrafficShape => ({ temperature: 0.7, topP: null, maxTokens: 256, tools: 0, stream: false, system: false, turns: 1, format: null, seed: false, stop: false, ...over })

type Seen = { path: string; headers: string[]; body: Record<string, unknown>; bodyKeys: string[] }

/** The router stack, with everything a host receives written down. */
async function stackWithTap() {
  const booted = await bootStack({ secondHost: true })
  booted.stack.internalToken = TOKEN
  const seen: Seen[] = []
  const inner = booted.stack.hosts.request
  booted.stack.hosts.request = async (host, endpoint, path, init) => {
    const headers = [...new Headers(init.headers).keys()].sort()
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>
    seen.push({ path, headers, body, bodyKeys: Object.keys(body) })
    return inner(host, endpoint, path, init)
  }
  return { ...booted, seen }
}

function depsFor(booted: Awaited<ReturnType<typeof stackWithTap>>, account: CanaryAccount, seed = 7): AuditDeps {
  return {
    env: "local",
    db: booted.stack.db,
    chain: booted.stack.indexer,
    fetcher: (url, init) => Promise.resolve(booted.app.request(new URL(url).pathname, init)),
    account: {} as never,
    reader: {} as never,
    writer: {} as never,
    contracts: {},
    metrics: new Metrics(),
    kek: Buffer.alloc(32),
    routerUrl: "http://router.local",
    indexerUrl: "http://indexer.local",
    internalToken: TOKEN,
    accounts: [account],
    corpus,
    models: [{ name: "ofm-8b", digest: booted.modelDigest }],
    enqueueCanary: async () => undefined,
    fileThroughput: false,
    rng: mulberry32(seed),
    clock: () => booted.stack.clock(),
  }
}

async function canaryAccount(booted: Awaited<ReturnType<typeof stackWithTap>>): Promise<CanaryAccount> {
  const wallet = "0xabab000000000000000000000000000000000001" as Hex
  booted.indexer.buyers.set(wallet, { ...booted.indexer.buyers.get(booted.buyer)! })
  const key = await issueKey(booted.stack, wallet)
  return { wallet, label: "demo-account", apiKey: key.token, openedAt: 0, activeFrom: 0, activeTo: 23, weight: 1, dailyLimit: 10_000 }
}

const buyerRequest = (booted: Awaited<ReturnType<typeof stackWithTap>>, body: object) =>
  booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })

describe("what a host can see", () => {
  test("a canary reaches the host with the same headers and body shape as a buyer's request", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    const request = { model: "ofm-8b", messages: [{ role: "user", content: "same request" }], max_tokens: 8, temperature: 0.7 }
    expect((await buyerRequest(booted, request)).status).toBe(200)
    const ordinary = booted.seen.splice(0)
    const res = await booted.app.request("/internal/audit/canary", {
      method: "POST",
      headers: { authorization: `Bearer ${account.apiKey}`, "content-type": "application/json", "x-offpeak-internal": TOKEN, "x-offpeak-canary-host": booted.host },
      body: JSON.stringify(request),
    })
    expect(res.status).toBe(200)
    const canary = booted.seen.splice(0)
    expect(canary.map((row) => row.path)).toEqual(ordinary.map((row) => row.path))
    for (const [i, row] of canary.entries()) {
      expect(row.headers).toEqual(ordinary[i]!.headers)
      expect(row.bodyKeys).toEqual(ordinary[i]!.bodyKeys)
    }
    const chat = (rows: Seen[]) => rows.find((row) => row.path.endsWith("/chat/completions"))!.body
    expect(chat(canary)).toEqual(chat(ordinary))
    expect(JSON.stringify(canary)).not.toMatch(/canary|internal|audit/i)
  })

  test("the sign request names the same fields, and no wallet", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    await depsFor(booted, account)
    const request = { model: "ofm-8b", messages: [{ role: "user", content: "signed" }], max_tokens: 8 }
    await buyerRequest(booted, request)
    const ordinary = booted.seen.splice(0).find((row) => row.path.endsWith("/sign"))!
    await booted.app.request("/internal/audit/canary", { method: "POST", headers: { authorization: `Bearer ${account.apiKey}`, "x-offpeak-internal": TOKEN, "x-offpeak-canary-host": booted.host }, body: JSON.stringify(request) })
    const canary = booted.seen.splice(0).find((row) => row.path.endsWith("/sign"))!
    expect(Object.keys(canary.body.record as object).sort()).toEqual(Object.keys(ordinary.body.record as object).sort())
    expect(JSON.stringify(canary.body)).not.toContain(account.wallet)
  })

  test("a canary's response looks like any other to its caller, with nothing added", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    const request = { model: "ofm-8b", messages: [{ role: "user", content: "headers" }], max_tokens: 8 }
    const plain = await buyerRequest(booted, request)
    const canary = await booted.app.request("/internal/audit/canary", { method: "POST", headers: { authorization: `Bearer ${account.apiKey}`, "x-offpeak-internal": TOKEN, "x-offpeak-canary-host": booted.host }, body: JSON.stringify(request) })
    expect([...canary.headers.keys()].sort()).toEqual([...plain.headers.keys()].sort())
  })

  test("canaries are billed as ordinary prepaid usage", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    const deps = depsFor(booted, account)
    await sendCanary(deps, { host: booted.host, modelDigest: booted.modelDigest })
    const rows = await booted.stack.db.query<{ pay_mode: number; payer: string; status: string }>("SELECT pay_mode, payer, status FROM shared.usage_records")
    expect(rows.rows).toEqual([{ pay_mode: 0, payer: account.wallet, status: "final" }])
  })
})

describe("the canary route", () => {
  test("needs the internal token", async () => {
    const booted = await stackWithTap()
    const res = await booted.app.request("/internal/audit/canary", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "x-offpeak-canary-host": booted.host }, body: "{}" })
    expect(res.status).toBe(403)
    const wrong = await booted.app.request("/internal/audit/canary", { method: "POST", headers: { "x-offpeak-internal": "nope", "x-offpeak-canary-host": booted.host }, body: "{}" })
    expect(wrong.status).toBe(403)
  })

  test("is closed when no internal token is configured", async () => {
    const booted = await stackWithTap()
    booted.stack.internalToken = undefined
    const res = await booted.app.request("/internal/audit/canary", { method: "POST", headers: { "x-offpeak-canary-host": booted.host }, body: "{}" })
    expect(res.status).toBe(403)
  })

  test("reaches the host it names, not the cheapest one", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    const second = [...booted.indexer.hosts.keys()].find((host) => host !== booted.host)!
    const deps = depsFor(booted, account)
    const sent = await sendCanary(deps, { host: second, modelDigest: booted.modelDigest })
    expect(sent).not.toBeNull()
    const rows = await booted.stack.db.query<{ host: string }>("SELECT host FROM shared.usage_records")
    expect(rows.rows[0]!.host).toBe(second)
  })

  test("reaches a probation host, which ordinary routing never does", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    booted.indexer.hosts.set(booted.host, { ...booted.indexer.hosts.get(booted.host)!, status: HOST_STATUS.Probation, routable: false })
    const second = [...booted.indexer.hosts.keys()].find((host) => host !== booted.host)!
    booted.indexer.hosts.delete(second)
    expect((await buyerRequest(booted, { model: "ofm-8b", messages: [{ role: "user", content: "x" }], max_tokens: 4 })).status).toBe(503)
    expect(await sendCanary(depsFor(booted, account), { host: booted.host, modelDigest: booted.modelDigest })).not.toBeNull()
  })

  test("refuses a frozen host", async () => {
    const booted = await stackWithTap()
    const account = await canaryAccount(booted)
    booted.indexer.hosts.set(booted.host, { ...booted.indexer.hosts.get(booted.host)!, status: HOST_STATUS.Frozen })
    expect(await sendCanary(depsFor(booted, account), { host: booted.host, modelDigest: booted.modelDigest })).toBeNull()
  })
})

describe("canary requests", () => {
  test("the corpus has real variety", () => {
    expect(corpusFigures(corpus).open).toBeGreaterThanOrEqual(10)
    expect(corpusFigures(corpus).deterministic).toBeGreaterThanOrEqual(10)
    const rng = mulberry32(1)
    const prompts = new Set(Array.from({ length: 500 }, () => JSON.stringify(openCanary(corpus, "m", shape(), rng).body.messages)))
    expect(prompts.size).toBeGreaterThan(200)
  })

  test("parameters a shape leaves out stay out of the body", () => {
    const body = openCanary(corpus, "m", shape({ temperature: null, maxTokens: null }), mulberry32(2)).body
    expect(Object.keys(body).sort()).toEqual(["messages", "model"])
  })

  test("parameters a shape carries go in", () => {
    const { body } = openCanary(corpus, "m", shape({ topP: 0.9, stream: true, tools: 2, seed: true, stop: true, format: "json_object", system: true, turns: 3 }), mulberry32(3))
    expect(body).toMatchObject({ top_p: 0.9, stream: true, response_format: { type: "json_object" } })
    expect((body.tools as unknown[]).length).toBe(2)
    expect((body.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"])
  })

  test("drawn shapes follow the live distribution", () => {
    const rng = mulberry32(4)
    const rows = [{ shape: trafficShape({ temperature: 0.2 }), n: 900 }, { shape: trafficShape({ temperature: 1 }), n: 100 }]
    let low = 0
    for (let i = 0; i < 10_000; i++) if (drawShape(rows, rng).temperature === 0.2) low++
    expect(low).toBeGreaterThan(8_700)
    expect(low).toBeLessThan(9_300)
  })

  test("a canary's shape reads back as the shape it was drawn from", () => {
    const rng = mulberry32(5)
    const wanted = shape({ temperature: 0.3, topP: 0.95, maxTokens: 512, stream: true, tools: 1, system: true, turns: 2 })
    expect(JSON.parse(trafficShape(openCanary(corpus, "m", wanted, rng).body))).toEqual(wanted)
  })

  test("deterministic canaries run at temperature 0 and keep their framing", () => {
    const rng = mulberry32(6)
    const [row] = deterministicPool(corpus, rng)
    const canary = deterministicCanary(corpus, "m", { ...row!, accepted: ["paris"] }, shape({ temperature: 0.9, tools: 2, stream: true }), rng)
    expect(canary.body).toMatchObject({ temperature: 0, stream: true, messages: row!.messages })
    expect(canary.body.tools).toBeUndefined()
    expect(canary.deterministic).toBe(true)
  })

  test("nothing in a canary's text gives it away", () => {
    const rng = mulberry32(8)
    for (let i = 0; i < 300; i++) expect(JSON.stringify(openCanary(corpus, "m", shape({ system: true, turns: 2 }), rng).body)).not.toMatch(/canary|audit|offpeak|test prompt/i)
    expect(JSON.stringify(deterministicPool(corpus, rng))).not.toMatch(/canary|audit|offpeak/i)
  })

  test("about one canary in five is deterministic once answer sets exist", async () => {
    const booted = await stackWithTap()
    const deps = depsFor(booted, await canaryAccount(booted))
    await booted.stack.db.query(
      `INSERT INTO serving.canary_expected (prompt_id, model_digest, body, accepted, gpu_classes, observed_at) VALUES ('sum:1',$1,$2::jsonb,'["3"]'::jsonb,'[]'::jsonb,0)`,
      [booted.modelDigest, JSON.stringify({ messages: [{ role: "user", content: "1+2" }] })],
    )
    let deterministic = 0
    for (let i = 0; i < 500; i++) if ((await chooseCanary(deps, corpus, "ofm-8b", booted.modelDigest, 0)).deterministic) deterministic++
    expect(deterministic).toBeGreaterThan(70)
    expect(deterministic).toBeLessThan(130)
  })
})

describe("canary rate", () => {
  const base = { hourlyRequests: 10_000, shareOfRemaining: 0.01, audited: 500, projected: 0, probation: false, boosted: false }

  test("is 0.5% of a busy host's traffic", () => {
    expect(canaryRate(base)).toBeCloseTo(10_000 * CANARY_SHARE, 8)
  })

  test("rises after an unconfirmed flag", () => {
    expect(canaryRate({ ...base, boosted: true })).toBeCloseTo(10_000 * CANARY_SHARE * CANARY_BOOST, 8)
  })

  test("a quiet host gets its shortfall to the weekly minimum", () => {
    const rate = canaryRate({ ...base, hourlyRequests: 0, audited: 40, shareOfRemaining: 1 / 100 })
    expect(rate).toBeCloseTo((MIN_AUDITED_PER_WEEK - 40) / 100, 8)
  })

  test("a host already on course gets no extras", () => {
    expect(canaryRate({ ...base, audited: 100, projected: 100 })).toBeCloseTo(50, 8)
  })

  test("a multiple of near-zero traffic is not the boost: the fresh shortfall is", () => {
    const rate = canaryRate({ ...base, hourlyRequests: 0, boosted: true, freshShortfall: 220, shareOfBoost: 1 / 165 })
    expect(rate).toBeCloseTo(220 / 165, 8)
    expect(canaryRate({ ...base, hourlyRequests: 0, boosted: true })).toBe(0)
  })

  test("probation hosts get canaries only, up to the minimum", () => {
    const rate = canaryRate({ ...base, hourlyRequests: 500, probation: true, audited: 0, shareOfRemaining: 1 / 72 })
    expect(rate).toBeCloseTo(MIN_AUDITED_PER_WEEK / 72, 8)
  })

  test("arrivals are Poisson: right count, no regular spacing", () => {
    const rng = mulberry32(12)
    const runs = Array.from({ length: 3_000 }, () => arrivals(5, rng))
    const mean = runs.reduce((sum, run) => sum + run.length, 0) / runs.length
    expect(Math.abs(mean - 5)).toBeLessThan(0.15)
    const gaps = runs.flatMap((run) => run.slice(1).map((at, i) => at - run[i]!))
    const gapMean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    const gapSd = Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - gapMean) ** 2, 0) / gaps.length)
    expect(gapSd / gapMean).toBeGreaterThan(0.85)
  })

  test("no rate means no arrivals", () => {
    expect(arrivals(0, mulberry32(1))).toEqual([])
  })
})

describe("planning", () => {
  test("a week's plan keeps a quiet host at 200 audited responses", async () => {
    const booted = await stackWithTap()
    const deps = depsFor(booted, await canaryAccount(booted))
    const start = 1_762_128_000
    let total = 0
    for (let hour = 0; hour < 168; hour++) {
      const plans = await planCanaries(deps, start + hour * 3_600)
      for (const plan of plans) {
        total++
        expect(plan.delayS).toBeGreaterThanOrEqual(0)
        expect(plan.delayS).toBeLessThan(3_600)
      }
      const scored = plans.length
      for (let i = 0; i < scored; i++) {
        await booted.stack.db.query("INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, ts) VALUES ($1,'0xh',$2,'b',-1,0,'0xr',$3)", [`${hour}:${i}:${plans[i]!.host}`, booted.modelDigest, start + hour * 3_600])
        await booted.stack.db.query("UPDATE serving.audit_scores SET host = $1 WHERE req_id = $2", [plans[i]!.host, `${hour}:${i}:${plans[i]!.host}`])
      }
    }
    const hosts = booted.indexer.hosts.size
    expect(total / hosts).toBeGreaterThan(MIN_AUDITED_PER_WEEK * 0.75)
    expect(total / hosts).toBeLessThan(MIN_AUDITED_PER_WEEK * 1.25)
  }, 60_000)

  test("frozen hosts get none", async () => {
    const booted = await stackWithTap()
    for (const [address, host] of booted.indexer.hosts) booted.indexer.hosts.set(address, { ...host, status: HOST_STATUS.Frozen })
    expect(await planCanaries(depsFor(booted, await canaryAccount(booted)), 1_762_128_000)).toEqual([])
  })

  test("no corpus means no canaries, and nothing falls back to prompts a host could hold", async () => {
    const booted = await stackWithTap()
    const deps = { ...depsFor(booted, await canaryAccount(booted)), corpus: null }
    expect(await planCanaries(deps, 1_762_128_000)).toEqual([])
    expect(await sendCanary(deps, { host: booted.host, modelDigest: booted.modelDigest })).toBeNull()
    expect(await refreshAccepted(deps, booted.modelDigest)).toBe(0)
  })
