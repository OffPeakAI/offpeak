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
