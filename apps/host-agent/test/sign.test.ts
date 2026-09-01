import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { domain, hostCostMicro, hourOfWeek, leafFor, parseRecord, recordToMessage, recoverTyped, serializeRecord, usageTypes, type Hex } from "@offpeak/shared"
import { DIGEST, LEDGER, LIVE, NOW, REGISTRY, agentHarness, baseSheet, buyer, host, signSheet, tokenizer, week } from "./support/harness.ts"
import { nightBand, liveBand, sheetHashOf } from "../src/sheets.ts"
import { SignedLog } from "../src/signed-log.ts"

const REPLY = "Large language models are neural networks trained on text."

let stops: (() => void)[] = []
const harness = async (opts: Parameters<typeof agentHarness>[0] = {}) => {
  const row = await agentHarness(opts)
  stops.push(row.stop)
  return row
}

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

/** Serves one chat and gives back the counts both sides should agree on. */
async function served(opts: Parameters<typeof agentHarness>[0] = {}, body: Record<string, unknown> = {}) {
  const row = await harness(opts)
  const { reqId, body: sent } = await row.serve(body)
  const tokensIn = tokenizer.countChat({ messages: sent.messages as never })
  const tokensOut = tokenizer.countOutput(REPLY, undefined, "stop")
  return { ...row, reqId, tokensIn, tokensOut, good: row.record(reqId, { tokensIn, tokensOut }) }
}

describe("a record that passes", () => {
  test("gets the operator's EIP-712 signature over the router's record", async () => {
    const { sign, good, tokensIn, tokensOut } = await served()
    const { status, body } = await sign(good)
    expect(status).toBe(200)
    expect(body.hostCounts).toEqual({ tokensIn, tokensOut })
    const signer = await recoverTyped({ domain: domain("OffpeakUsage", LEDGER), types: usageTypes, primaryType: "UsageRecord", message: recordToMessage(good) as never }, body.hostSig)
    expect(signer.toLowerCase()).toBe(host.address.toLowerCase())
  })

  test("leaf and reply carry what the router reads", async () => {
    const { sign, good, routerSig } = await served()
    const { body } = await sign(good)
    expect(body.leaf).toBe(leafFor(good, await routerSig(good), body.hostSig))
  })

  test("counts inside the 3.4 tolerance pass on both sides of the host's", async () => {
    const low = await served()
    expect((await low.sign({ ...low.good, tokensOut: low.tokensOut - 2, hostCostMicro: hostCostMicro(low.tokensIn, low.tokensOut - 2, LIVE.in, LIVE.out) })).status).toBe(200)
    const high = await served()
    expect((await high.sign({ ...high.good, tokensIn: high.tokensIn + 2, hostCostMicro: hostCostMicro(high.tokensIn + 2, high.tokensOut, LIVE.in, LIVE.out) })).status).toBe(200)
  })
})

describe("counts", () => {
  test("three tokens too many is refused and served unbilled", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    const { status, body } = await sign(record(reqId, { tokensIn, tokensOut: tokensOut + 3 }))
    expect(status).toBe(409)
    expect(body.refused).toBe(true)
    expect(body.reason).toBe("counts")
    expect(body.hostCounts).toEqual({ tokensIn, tokensOut })
  })

  test("input counts are held to the same line", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    expect((await sign(record(reqId, { tokensIn: tokensIn + 3, tokensOut }))).body.reason).toBe("counts")
    expect((await sign(record(reqId, { tokensIn: tokensIn - 3, tokensOut }))).body.reason).toBe("counts")
  })

  test("a long reply gets 0.5%, not a flat two", async () => {
    const text = "word ".repeat(2000).trim()
    const { sign, record, reqId, tokensIn } = await served({ reply: () => ({ text }) })
    const tokensOut = tokenizer.countOutput(text, undefined, "stop")
    const allowance = Math.floor((tokensOut * 50) / 10_000)
    expect(allowance).toBeGreaterThan(2)
    expect((await sign(record(reqId, { tokensIn, tokensOut: tokensOut - allowance - 1 }))).body.reason).toBe("counts")
    expect((await sign(record(reqId, { tokensIn, tokensOut: tokensOut - allowance + 1 }))).status).toBe(200)
  })

  test("a partial record may bill less output than the host counted", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    expect((await sign(record(reqId, { tokensIn, tokensOut: 1 }), { partial: true })).status).toBe(200)
    expect(tokensOut).toBeGreaterThan(5)
  })

  test("a full record may not bill that little", async () => {
    const { sign, record, reqId, tokensIn } = await served()
    expect((await sign(record(reqId, { tokensIn, tokensOut: 1 }))).body.reason).toBe("counts")
  })

  test("a partial record never bills more than the host counted", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    expect((await sign(record(reqId, { tokensIn, tokensOut: tokensOut + 1 }), { partial: true })).body.reason).toBe("counts")
  })

  test("a partial record still needs the input count right", async () => {
    const { sign, record, reqId, tokensIn } = await served()
    expect((await sign(record(reqId, { tokensIn: tokensIn + 3, tokensOut: 1 }), { partial: true })).body.reason).toBe("counts")
  })
})

describe("who and what", () => {
  test("a request this host never served gets a 404", async () => {
    const { sign, record } = await harness()
    expect((await sign(record(`0x${"11".repeat(32)}`))).status).toBe(404)
  })

  test("only the router's signature on this exact record counts", async () => {
    const { sign, good, routerSig } = await served()
    expect((await sign(good, { signer: buyer })).status).toBe(401)
    expect((await sign({ ...good, feeMicro: 2n }, { sig: await routerSig(good) })).status).toBe(401)
  })

  test("a router signature for another ledger does not count", async () => {
    const { sign, good, routerSig } = await served()
    const other = await routerSig(good, undefined, `0x${"12".repeat(20)}`)
    expect((await sign(good, { sig: other })).status).toBe(401)
  })

  test("another host's record is refused", async () => {
    const { sign, good } = await served()
    expect((await sign({ ...good, host: buyer.address.toLowerCase() as Hex })).body.reason).toBe("host")
  })

  test("another model's digest is refused", async () => {
    const { sign, good } = await served()
    expect((await sign({ ...good, modelDigest: `0x${"22".repeat(32)}` })).body.reason).toBe("digest")
  })

  test("a record moved to another hour is refused", async () => {
    const { sign, good } = await served()
    expect((await sign({ ...good, ts: NOW + 3600 })).body.reason).toBe("ts")
  })

  test("malformed bodies are a 400", async () => {
    const { app, sign, good } = await served()
    const post = (body: unknown) => app.request("/offpeak/v1/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    expect((await post({})).status).toBe(400)
    expect((await post({ record: serializeRecord(good) })).status).toBe(400)
    expect((await post({ record: { ...serializeRecord(good), priceIn: "-1" }, routerSig: `0x${"11".repeat(65)}` })).status).toBe(400)
    expect((await post({ record: { ...serializeRecord(good), priceIn: (2n ** 64n).toString() }, routerSig: `0x${"11".repeat(65)}` })).status).toBe(400)
    expect((await post({ record: { ...serializeRecord(good), payMode: 9 }, routerSig: `0x${"11".repeat(65)}` })).status).toBe(400)
    expect((await sign(good)).status).toBe(200)
  })
})

describe("prices come from this host's own sheets", () => {
  test("a sheet this host never signed is refused", async () => {
    const { sign, good } = await served()
    expect((await sign({ ...good, sheetHash: `0x${"33".repeat(32)}` })).body.reason).toBe("sheet")
  })

  test("a sheet for another model is refused", async () => {
    const { sign, good, sheets } = await served()
    const other = baseSheet({ modelDigest: `0x${"44".repeat(32)}` })
    const hash = await sheets.save(other, await signSheet(other))
    expect((await sign({ ...good, sheetHash: hash })).body.reason).toBe("sheet")
  })
