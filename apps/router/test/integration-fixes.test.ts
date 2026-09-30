import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditCourtAbi } from "@offpeak/abis"
import { channelAuthHeader, domain, hostChatBody, hostEmbeddingsBody, hourIndex, promptHashOf, voucherTypes, type Hex } from "@offpeak/shared"
import { decodeFunctionData, keccak256, toBytes } from "viem"
import { sheetFromJson, sheetHashOf, sheetToJson, sheetTypedData } from "../../host-agent/src/sheets.ts"
import { anvilAccount, roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootRouter, payeeAccount } from "../src/boot.ts"
import { assertKeySeparation } from "../src/env.ts"
import { issueKey } from "../src/pipeline.ts"
import { recordLoad } from "../src/offpeak/forecast.ts"
import { writeHostStats } from "../src/pricing/stats.ts"
import { insertUsage } from "../src/store.ts"
import { bootStack } from "./support/stack.ts"
import { uptoHeader } from "./support/upto.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const bearer = (booted: Booted) => ({ authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" })

const chatBody = (over: Record<string, unknown> = {}) => ({ model: "ofm-8b", messages: [{ role: "user", content: "hello there" }], ...over })

const chat = (booted: Booted, body: object, headers: Record<string, string> = bearer(booted)) => booted.app.request("/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })

type Served = { offpeak_usage: { record: { reqId: Hex; promptHash: Hex; tokensIn: number; tokensOut: number } } }

/** Keeps every body the router sends a host, exactly as sent. */
function capture(booted: Booted) {
  const sent: { path: string; body: string }[] = []
  const { request } = booted.stack.hosts
  booted.stack.hosts = {
    request: (host, endpoint, path, init) => {
      if (typeof init.body === "string" && !path.endsWith("/sign")) sent.push({ path, body: init.body })
      return request(host, endpoint, path, init)
    },
  }
  return sent
}

const raisePrices = (booted: Booted, by: bigint) => {
  const sheet = booted.stack.sheets[0]!
  Object.assign(sheet, { baseIn: sheet.baseIn.map((price) => price * by), baseOut: sheet.baseOut.map((price) => price * by), floorIn: sheet.floorIn * by, floorOut: sheet.floorOut * by })
}

describe("promptHash covers the body as sent to the host", () => {
  test("a chat record hashes what the host received, not what the buyer sent", async () => {
    const booted = await bootStack()
    const sent = capture(booted)
    const body = chatBody({ max_completion_tokens: 12 })
    const { offpeak_usage: usage } = (await (await chat(booted, body)).json()) as Served
    expect(usage.record.promptHash).toBe(promptHashOf(JSON.parse(sent[0]!.body)))
    expect(usage.record.promptHash).not.toBe(promptHashOf(body))
    expect(usage.record.promptHash).toBe(promptHashOf(hostChatBody(body, 12)))
  })

  test("an embeddings record does too", async () => {
    const booted = await bootStack()
    const sent = capture(booted)
    const res = await booted.app.request("/v1/embeddings", { method: "POST", headers: bearer(booted), body: JSON.stringify({ model: "ofm-embed", input: "embed me" }) })
    const { offpeak_usage: usage } = (await res.json()) as Served
    expect(usage.record.promptHash).toBe(promptHashOf(JSON.parse(sent[0]!.body)))
    expect(usage.record.promptHash).toBe(promptHashOf(hostEmbeddingsBody({ input: "embed me" })))
  })
})

describe("the 402 quote", () => {
  const unpaid = { "content-type": "application/json" }
  const offers = async (res: Response) => ((await res.json()) as { accepts: { scheme: string; maxAmountRequired?: string }[] }).accepts

  test("a large request is quoted its real maximum cost, above any flat figure", async () => {
    const booted = await bootStack()
    raisePrices(booted, 100n)
    const res = await chat(booted, chatBody({ max_tokens: 4000 }), unpaid)
    expect(res.status).toBe(402)
    const [channel, upto] = await offers(res)
    expect(channel!.scheme).toBe("channel")
    expect(upto!.scheme).toBe("upto")
    expect(BigInt(upto!.maxAmountRequired!)).toBeGreaterThan(50_000n)
  })

  test("what the paid retry must cover fits inside the quote, even after load lifts the price", async () => {
    const booted = await bootStack()
    raisePrices(booted, 100n)
    const body = chatBody({ max_tokens: 4000 })
    const required: string[] = []
    const { verify } = booted.stack.facilitator
    booted.stack.facilitator.verify = (input: never) => {
      required.push((input as { paymentRequirements: { maxAmountRequired: string } }).paymentRequirements.maxAmountRequired)
      return verify.call(booted.stack.facilitator, input)
    }
    const quoted = BigInt((await offers(await chat(booted, body, unpaid)))[1]!.maxAmountRequired!)
    // Load lifts the live price a few percent off its floor, as it can between the 402 and the retry.
    booted.stack.load.note(booted.host, booted.modelDigest, "output", 22, booted.stack.clock())
    booted.stack.candidateCache.clear()
    await chat(booted, body, { ...unpaid, "payment-signature": await uptoHeader(booted.stack, roleAccount("buyer"), keccak256(toBytes("retry"))) })
    expect(BigInt(required[0]!)).toBeLessThanOrEqual(quoted)
    expect(BigInt(required[0]!) * 11n).toBeGreaterThan(quoted * 10n)
  })

  test("a request under 0.05 USDG offers channels only, per 3.10", async () => {
    const booted = await bootStack()
    expect((await offers(await chat(booted, chatBody(), unpaid))).map((row) => row.scheme)).toEqual(["channel"])
  })

  test("an unknown model or a bad body is refused before anyone is asked to pay", async () => {
    const booted = await bootStack()
    expect((await chat(booted, chatBody({ model: "nope" }), unpaid)).status).toBe(404)
    expect((await chat(booted, { model: "ofm-8b", messages: [] }, unpaid)).status).toBe(400)
  })

  test("no host and a price over the cap answer as they would for a paid request", async () => {
    const booted = await bootStack()
    expect((await chat(booted, chatBody(), { ...unpaid, "x-offpeak-max-price": "in=0.000001,out=0.000001" })).status).toBe(429)
    booted.stack.probesOk.clear()
    booted.stack.candidateCache.clear()
    expect((await chat(booted, chatBody(), unpaid)).status).toBe(503)
  })
})

describe("stream events", () => {
  test("the wire still carries the named event, then [DONE], and its data is the envelope", async () => {
    const booted = await bootStack()
    const text = await (await chat(booted, chatBody({ stream: true }))).text()
    const blocks = text.trim().split("\n\n")
    expect(blocks.at(-1)).toBe("data: [DONE]")
    expect(blocks.at(-2)!.startsWith("event: offpeak.usage\n")).toBe(true)
    const data = JSON.parse(blocks.at(-2)!.split("\n")[1]!.slice("data: ".length))
    expect(data).toMatchObject({ v: 1, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    expect(data.record.reqId).toBe(data.id)
  })
