import { describe, expect, test } from "bun:test"
import { bootStack } from "./support/stack.ts"
import { deployedFlags } from "../src/context.ts"

const ZERO = "0x0000000000000000000000000000000000000000"
const ADDRESS = "0xabababababababababababababababababababab"

const chat = (booted: Awaited<ReturnType<typeof bootStack>>, headers: Record<string, string>) =>
  booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "hello" }], max_tokens: 8 }),
  })

describe("deployedFlags", () => {
  test("a P1 deployment leaves every later feature off", () => {
    const flags = deployedFlags({ OffpeakVault: ADDRESS, ChannelManager: ZERO, X402Escrow: ZERO, WindowMarket: ZERO })
    expect(flags).toMatchObject({ channels: false, upto: false, night_jobs: false, windows: false, sealed: false, token_hooks: false, beta_cap: true })
  })

  test("a missing address counts as not deployed", () => {
    expect(deployedFlags({})).toMatchObject({ channels: false, upto: false, night_jobs: false, windows: false })
  })

  test("P2 turns on channels, x402 and night jobs, and not Windows", () => {
    expect(deployedFlags({ ChannelManager: ADDRESS, X402Escrow: ADDRESS, WindowMarket: ZERO })).toMatchObject({ channels: true, upto: true, night_jobs: true, windows: false })
  })

  test("night jobs need both P2 contracts", () => {
    expect(deployedFlags({ ChannelManager: ADDRESS, X402Escrow: ZERO }).night_jobs).toBe(false)
  })

  test("nothing a deployment file says turns on token hooks, sealed or lifts the beta cap", () => {
    const flags = deployedFlags({ ChannelManager: ADDRESS, X402Escrow: ADDRESS, WindowMarket: ADDRESS, OfpkHooks: ADDRESS })
    expect(flags).toMatchObject({ token_hooks: false, sealed: false, beta_cap: true })
  })
})

describe("a feature that is off", () => {
  const p1 = async () => {
    const booted = await bootStack()
    booted.stack.flags = deployedFlags({})
    return booted
  }

  test("refuses channel requests", async () => {
    const booted = await p1()
    const res = await chat(booted, { "x-offpeak-channel": `0x${"ab".repeat(32)}` })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("feature_off")
  })

  test("refuses x402 payments", async () => {
    const res = await chat(await p1(), { "payment-signature": "e30=" })
    expect(res.status).toBe(403)
  })

  test("refuses Window draws, flex and Window calldata", async () => {
    const booted = await p1()
    const auth = { authorization: `Bearer ${booted.key.token}` }
    expect((await chat(booted, { ...auth, "x-offpeak-window": "1" })).status).toBe(403)
    expect((await chat(booted, { ...auth, "x-offpeak-flex": new Date(booted.stack.clock() * 1000 + 3_600_000).toISOString() })).status).toBe(403)
    const buy = await booted.app.request("/v1/windows/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "1" }) })
    expect(buy.status).toBe(403)
  })

  test("refuses night jobs", async () => {
    const booted = await p1()
    const res = await booted.app.request("/v1/batches", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body: "{}" })
    expect(res.status).toBe(403)
  })

  test("leaves prepaid chat working and offers nothing unpaid", async () => {
    const booted = await p1()
    expect((await chat(booted, { authorization: `Bearer ${booted.key.token}` })).status).toBe(200)
    const unpaid = await chat(booted, {})
    expect(unpaid.status).toBe(402)
    expect(((await unpaid.json()) as { accepts: unknown[] }).accepts).toEqual([])
  })

  test("status reports it off", async () => {
    const booted = await p1()
    const status = (await (await booted.app.request("/v1/status")).json()) as { features: Record<string, boolean> }
    expect(status.features).toMatchObject({ channels: false, upto: false, night_jobs: false, windows: false, token_hooks: false, beta_cap: true })
  })
})
