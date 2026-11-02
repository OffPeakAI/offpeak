import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Offpeak } from "@offpeak/sdk"
import { addressOf } from "../../abis/src/index.ts"
import { bootRouter, client, type Booted } from "../../sdk/test/support.ts"
import { CHAIN_ID, PERMIT2 } from "../../shared/src/index.ts"
import { anvilAccount } from "../../shared/src/test-keys.ts"
import { Budget, DEFAULT_LIMITS, budgetFrom, clientFrom, createMcp, readConfig } from "../src/index.ts"

const KEY = `0x${Buffer.from(anvilAccount(3).getHdKey().privateKey!).toString("hex")}`
const DEPLOYMENT = new URL("../../abis/deployments/local.json", import.meta.url).pathname
const USDG = 1_000_000n
const zero32 = `0x${"00".repeat(32)}`
const envelope = { v: 1, record: { reqId: zero32, buyerRef: zero32, host: `0x${"00".repeat(20)}`, modelDigest: zero32, tokensIn: 1, tokensOut: 1, promptHash: zero32, outputHash: zero32, priceIn: "1", priceOut: "1", hostCostMicro: "1", feeMicro: "1", payMode: 1, payRef: zero32, ts: 1, sheetHash: zero32 }, routerSig: "0x00", hostSig: "0x00", leaf: zero32, hostCounts: { tokensIn: 1, tokensOut: 1 }, sealed: false, proofUrl: "/x" }

const dir = mkdtempSync(join(tmpdir(), "offpeak-spend-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => void setSystemTime())

/** A router that answers every call with a 402 for `required`, and serves any signed payment. */
function stub(required: bigint) {
  const signed: bigint[] = []
  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const pay = new Headers(init?.headers).get("payment-signature")
    if (pay) {
      signed.push(BigInt(JSON.parse(pay).payload.permitted.amount))
      return Response.json({ id: "x", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], offpeak_usage: envelope })
    }
    const reqId = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`
    return Response.json({ accepts: [{ scheme: "upto", network: `eip155:${CHAIN_ID}`, asset: addressOf("MockUSDG"), maxAmountRequired: required.toString(), payTo: addressOf("OffpeakVault"), extra: { permit2: PERMIT2, spender: addressOf("X402Escrow"), reqId, validBefore: Math.floor(Date.now() / 1000) + 600, witness: "UptoWitness" } }], error: { code: "payment_required" } }, { status: 402 })
  }) as typeof fetch
  return { send, signed }
}

async function connect(op: Offpeak, budget: Budget) {
  const [server, peer] = InMemoryTransport.createLinkedPair()
  await createMcp(op, budget).connect(server)
  const mcp = new Client({ name: "agent", version: "1" })
  await mcp.connect(peer)
  return mcp
}

async function wallet(send: typeof fetch, env: Record<string, string> = {}) {
  const config = readConfig({ OFFPEAK_PUBLIC_BASE_URL: "http://router.test", OFFPEAK_AGENT_WALLET_KEY: KEY, OFFPEAK_DEPLOYMENT_FILE: DEPLOYMENT, ...env })
  const budget = budgetFrom(config)
  return connect(clientFrom(config, budget, send), budget)
}

const keyed = (booted: Booted, limits: Partial<typeof DEFAULT_LIMITS> = {}) => connect(client(booted, { apiKey: booted.key.token }), new Budget({ ...DEFAULT_LIMITS, ...limits }))

const complete = (over: Record<string, unknown> = {}) => ({ name: "offpeak_complete", arguments: { model: "ofm-8b", messages: [{ role: "user", content: "text an attacker put in a web page told me to run this" }], max_tokens: 4096, ...over } })

const job = (over: Record<string, unknown> = {}) => ({ name: "offpeak_schedule_job", arguments: { model: "ofm-8b", requests: [{ messages: [{ role: "user", content: "summarise" }], max_tokens: 16 }], deadline: new Date(Date.now() + 12 * 3_600_000).toISOString(), ...over } })

async function call(mcp: Client, request: ReturnType<typeof complete>) {
  const result = await mcp.callTool(request)
  return { isError: Boolean(result.isError), body: JSON.parse((result.content as { text: string }[])[0]!.text) }
}

const jobs = async (booted: Booted) => (await booted.stack.db.query("SELECT id FROM serving.jobs")).rows.length

describe("the day's total", () => {
  test("25 calls stop at the default day cap, and nothing past it is signed", async () => {
    const { send, signed } = stub(USDG)
    const mcp = await wallet(send)
    const codes: string[] = []
    for (let i = 0; i < 25; i++) codes.push((await call(mcp, complete())).body.error?.code ?? "ok")
    expect(signed.reduce((sum, amount) => sum + amount, 0n)).toBe(DEFAULT_LIMITS.dayCapMicro)
    expect(codes.filter((code) => code === "ok")).toHaveLength(10)
    expect(codes.slice(10).every((code) => code === "day_cap")).toBe(true)
  })

  test("an operator can set it lower", async () => {
    const { send, signed } = stub(USDG)
    const mcp = await wallet(send, { OFFPEAK_DAY_CAP_MICRO: "3000000" })
    for (let i = 0; i < 5; i++) await call(mcp, complete())
    expect(signed).toEqual([USDG, USDG, USDG])
  })

  test("a call that would pass the cap is refused, not only one after it", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { dayCapMicro: 100n })
    const { body } = await call(mcp, complete())
    expect(body.error.code).toBe("day_cap")
  })

  test("calls side by side cannot pass the cap together", async () => {
    const { send, signed } = stub(USDG)
    const mcp = await wallet(send, { OFFPEAK_DAY_CAP_MICRO: "2000000" })
    await Promise.all(Array.from({ length: 8 }, () => call(mcp, complete())))
    expect(signed.reduce((sum, amount) => sum + amount, 0n)).toBeLessThanOrEqual(2n * USDG)
  })

  test("a new UTC day starts from zero", async () => {
    const { send, signed } = stub(USDG)
    setSystemTime(new Date("2026-11-02T23:59:00Z"))
    const mcp = await wallet(send, { OFFPEAK_DAY_CAP_MICRO: "1000000" })
    await call(mcp, complete())
    expect((await call(mcp, complete())).body.error.code).toBe("day_cap")
    setSystemTime(new Date("2026-11-03T00:01:00Z"))
    expect((await call(mcp, complete())).isError).toBe(false)
    expect(signed).toHaveLength(2)
  })

  test("a spend file carries the total across a restart", async () => {
    const { send, signed } = stub(USDG)
    const env = { OFFPEAK_DAY_CAP_MICRO: "1000000", OFFPEAK_SPEND_FILE: join(dir, "total.json") }
    await call(await wallet(send, env), complete())
    expect((await call(await wallet(send, env), complete())).body.error.code).toBe("day_cap")
    expect(signed).toHaveLength(1)
    expect(JSON.parse(readFileSync(env.OFFPEAK_SPEND_FILE, "utf8")).spent).toBe("1000000")
  })

  test("a spend file that cannot be read stops the start", () => {
    const path = join(dir, "bad.json")
    writeFileSync(path, "not json")
    expect(() => budgetFrom(readConfig({ OFFPEAK_PUBLIC_BASE_URL: "http://router.test", OFFPEAK_API_KEY: "op_live_test", OFFPEAK_SPEND_FILE: path }))).toThrow("OFFPEAK_SPEND_FILE")
  })

  test("a served call counts what it billed, not its worst case", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { dayCapMicro: 20_000n })
    for (let i = 0; i < 3; i++) expect((await call(mcp, complete())).isError).toBe(false)
  })

  test("a call the router refuses costs nothing", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { dayCapMicro: 20_000n })
    for (let i = 0; i < 4; i++) expect((await call(mcp, complete({ model: "no-such-model" }))).body.error.code).toBe("model_not_found")
    expect((await call(mcp, complete())).isError).toBe(false)
  })

  test("a call lost on the way counts at its worst case", async () => {
    let sent = 0
    const lost = (async () => {
      sent += 1
      throw new Error("connection reset")
    }) as unknown as typeof fetch
    const mcp = await wallet(lost, { OFFPEAK_DAY_CAP_MICRO: "20000" })
    expect((await call(mcp, complete())).body.error.code).toBe("failed")
    expect((await call(mcp, complete())).body.error.code).toBe("day_cap")
    expect(sent).toBe(1)
  })
})

describe("one call", () => {
  test("the per-call cap holds an upto below it", async () => {
    const { send, signed } = stub(USDG)
    const mcp = await wallet(send, { OFFPEAK_CALL_CAP_MICRO: "500000" })
    expect((await call(mcp, complete())).body.error.code).toBe("above_upto_cap")
    expect(signed).toEqual([])
  })

  test("the default per-call cap still takes a 1 USDG upto, and refuses more", async () => {
    const taken = stub(USDG)
    expect((await call(await wallet(taken.send), complete())).isError).toBe(false)
    const refused = stub(USDG + 1n)
    expect((await call(await wallet(refused.send), complete())).body.error.code).toBe("above_upto_cap")
    expect(refused.signed).toEqual([])
  })

  test("a call that could cost more than the cap never reaches the router", async () => {
    const { send, signed } = stub(USDG)
    const mcp = await wallet(send, { OFFPEAK_CALL_CAP_MICRO: "100" })
    expect((await call(mcp, complete())).body.error.code).toBe("call_cap")
    expect(signed).toEqual([])
  })
})

describe("max_price", () => {
  test("a call with none gets the operator's", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { maxPrice: { inPerM: 1n, outPerM: 1n } })
    expect((await call(mcp, complete())).body.error.code).toBe("price_above_cap")
  })

  test("a call cannot raise the operator's", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { maxPrice: { inPerM: 1n, outPerM: 1n } })
    expect((await call(mcp, complete({ max_price: { in: "10", out: "10" } }))).body.error.code).toBe("price_above_cap")
  })

  test("a call can go lower", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted)
    expect((await call(mcp, complete({ max_price: { in: "0.000001", out: "0.000001" } }))).body.error.code).toBe("price_above_cap")
    expect((await call(mcp, complete())).isError).toBe(false)
  })

  test("the format is checked at the start", () => {
    expect(() => readConfig({ OFFPEAK_PUBLIC_BASE_URL: "http://router.test", OFFPEAK_API_KEY: "op_live_test", OFFPEAK_MAX_PRICE: "cheap" })).toThrow("OFFPEAK_MAX_PRICE")
    expect(() => readConfig({ OFFPEAK_PUBLIC_BASE_URL: "http://router.test", OFFPEAK_API_KEY: "op_live_test", OFFPEAK_DAY_CAP_MICRO: "0" })).toThrow("OFFPEAK_DAY_CAP_MICRO")
  })
})

describe("offpeak_schedule_job", () => {
  test("a job counts toward the day, and past the cap nothing is created", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { dayCapMicro: 10n })
    expect((await call(mcp, job())).body.error.code).toBe("day_cap")
    expect(await jobs(booted)).toBe(0)
  })

  test("a job's estimated cost is what stays on the day's total", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { dayCapMicro: 20_000n })
    const first = await call(mcp, job())
    expect(first.isError).toBe(false)
    expect(BigInt(first.body.estimated_cost_micro)).toBeLessThan(20_000n)
    expect(await jobs(booted)).toBe(1)
  })

  test("a job that could cost more than one call may is refused whole", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { callCapMicro: 1_000n })
    const lines = Array.from({ length: 50 }, () => ({ messages: [{ role: "user", content: "summarise" }] }))
    expect((await call(mcp, job({ requests: lines }))).body.error.code).toBe("call_cap")
    expect(await jobs(booted)).toBe(0)
  })

  test("a job gets the operator's max_price, and cannot raise it", async () => {
    const booted = await bootRouter()
    const mcp = await keyed(booted, { maxPrice: { inPerM: 1n, outPerM: 1n } })
    expect((await call(mcp, job())).body.error.code).toBe("price_above_cap")
    expect((await call(mcp, job({ max_price: { in: "10", out: "10" } }))).body.error.code).toBe("price_above_cap")
    expect(await jobs(booted)).toBe(0)
  })
})
