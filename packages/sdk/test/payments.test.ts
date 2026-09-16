import { describe, expect, test } from "bun:test"
import { addressOf } from "@offpeak/abis"
import { PERMIT2, leafFor, merkleProof, merkleRoot, permitWitnessTypes } from "@offpeak/shared"
import { keccak256, recoverTypedDataAddress, toBytes, type Hex, type PublicClient } from "viem"
import { addChannel, ask, BASE, bootRouter, buyerAccount, client, costOf, inProcess } from "./support.ts"
import { Offpeak, OffpeakError, microToUsd, usdToMicro, type ChatQueued, type ChatResult, type ChatStream, type UptoRequirement } from "../src/index.ts"

const now = () => Math.floor(Date.now() / 1000)

const requirement = (overrides: Partial<UptoRequirement> & { extra?: Partial<UptoRequirement["extra"]> } = {}): UptoRequirement => {
  const { extra, ...rest } = overrides
  return {
    scheme: "upto",
    network: "eip155:4663",
    asset: addressOf("MockUSDG"),
    maxAmountRequired: "50000",
    payTo: addressOf("OffpeakVault"),
    ...rest,
    extra: { permit2: PERMIT2, spender: addressOf("X402Escrow"), reqId: keccak256(toBytes("sdk-upto")), validBefore: now() + 600, witness: "UptoWitness", ...extra },
  }
}

describe("money strings", () => {
  test("converts without floats, exact to the last micro", () => {
    expect(microToUsd(150_000n)).toBe("0.150000")
    expect(microToUsd(1n)).toBe("0.000001")
    expect(microToUsd(123_456_789_012_345_678n)).toBe("123456789012.345678")
    expect(usdToMicro("0.15")).toBe(150_000n)
    expect(usdToMicro("0.000001")).toBe(1n)
    expect(usdToMicro("3")).toBe(3_000_000n)
    expect(() => usdToMicro("0.0000001")).toThrow(OffpeakError)
    expect(() => usdToMicro("1e3")).toThrow(OffpeakError)
  })
})

describe("chat options", () => {
  test("maxPrice passes under the cap and fails with the router's detail above it", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const fine = (await op.chat(ask("under"), { maxPrice: { inPerM: 10_000_000n, outPerM: 10_000_000n } })) as ChatResult
    expect(fine.envelope.record.payMode).toBe(0)
    const err = (await op.chat(ask("over"), { maxPrice: { inPerM: 1n, outPerM: 1n } }).catch((e) => e)) as OffpeakError
    expect(err).toBeInstanceOf(OffpeakError)
    expect(err.status).toBe(429)
    expect(err.code).toBe("price_above_cap")
    expect(err.detail?.next_cheaper_hour).toBeGreaterThan(0)
    expect(err.detail?.best_price).toBeDefined()
  })

  test("flex waits for a cheaper hour instead of failing", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const job = (await op.chat(ask("later"), { maxPrice: { inPerM: 1n, outPerM: 1n }, flex: new Date(Date.now() + 12 * 3_600_000) })) as ChatQueued
    expect(job.queued).toBe(true)
    expect(job.jobId).toStartWith("batch_")
  })

  test("windowId draws the Window and needs an API key", async () => {
    const booted = await bootRouter()
    const { stack, indexer, host, buyer } = booted
    indexer.windows.set("7", { id: 7n, host: host as Hex, modelDigest: stack.models[0]!.digest, t0: BigInt(stack.clock() - 10), t1: BigInt(stack.clock() + 3600), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false })
    indexer.holders.set(`7:${buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
    const op = client(booted, { apiKey: booted.key.token })
    const drawn = (await op.chat(ask("draw"), { windowId: 7n })) as ChatResult
    expect(drawn.envelope.record.payMode).toBe(4)
    expect((await op.verifyUsage(drawn.envelope)).ok).toBe(true)
    await expect(client(booted).chat(ask("draw"), { windowId: 7n })).rejects.toMatchObject({ code: "window_needs_key" })
  })

  test("a Window draw on a key still works while a channel is open", async () => {
    const booted = await bootRouter()
    const { stack, indexer, host, buyer } = booted
    indexer.windows.set("8", { id: 8n, host: host as Hex, modelDigest: stack.models[0]!.digest, t0: BigInt(stack.clock() - 10), t1: BigInt(stack.clock() + 3600), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false })
    indexer.holders.set(`8:${buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
    const op = client(booted, { apiKey: booted.key.token })
    await op.channels.attach(addChannel(booted, 5_000_000n))
    expect(((await op.chat(ask("draw"), { windowId: 8 })) as ChatResult).envelope.record.payMode).toBe(4)
    expect(((await op.chat(ask("channel"))) as ChatResult).envelope.record.payMode).toBe(3)
  })

  test("with no verified host a sealed chat stops, and the prompt never leaves", async () => {
    const booted = await bootRouter()
    const posts: unknown[] = []
    const send = inProcess(booted.app)
    const op = client(booted, {
      apiKey: booted.key.token,
      sealed: { trustRouterVerification: true },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") posts.push(init.body)
        return send(input, init)
      }) as typeof fetch,
    })
    await expect(op.chat(ask("secret"), { sealed: true })).rejects.toMatchObject({ code: "sealed_no_host" })
    expect(posts).toEqual([])
  })

  test("a client with no verifier of its own stops before anything leaves, and other calls still work", async () => {
    const booted = await bootRouter()
    const posts: unknown[] = []
    const send = inProcess(booted.app)
    const op = client(booted, {
      apiKey: booted.key.token,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        posts.push(input)
        return send(input, init)
      }) as typeof fetch,
    })
    await expect(op.chat(ask("secret"), { sealed: true })).rejects.toMatchObject({ code: "sealed_verifier_required" })
    await expect(op.sealed.hosts("ofm-8b")).rejects.toMatchObject({ code: "sealed_verifier_required" })
    expect(posts).toEqual([])
    expect(((await op.chat(ask("open"))) as ChatResult).text.length).toBeGreaterThan(0)
  })

  test("a bad request is stopped before it leaves", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    await expect(op.chat({ model: "", messages: [] })).rejects.toThrow()
  })

  test("the openai client works on an API key", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const done = await op.openai.chat.completions.create(ask("key"))
    expect(done.choices[0]?.message.content).toBeTruthy()
    expect(op.usageRecord(done.id)?.record.payMode).toBe(0)
    expect((await op.openai.models.list()).data.length).toBeGreaterThan(0)
  })
