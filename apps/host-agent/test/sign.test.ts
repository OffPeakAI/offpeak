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

  test("a sheet not yet valid at the record's start is refused", async () => {
    const { sign, good, sheets } = await served()
    const later = baseSheet({ validFrom: NOW + 3600, nonce: 2n })
    const hash = await sheets.save(later, await signSheet(later))
    await sheets.load()
    expect((await sign({ ...good, sheetHash: hash })).body.reason).toBe("sheet")
  })

  test("a sheet replaced before the record started is refused", async () => {
    const { sign, good, sheets } = await served()
    const newer = baseSheet({ validFrom: NOW - 60, nonce: 2n })
    await sheets.save(newer, await signSheet(newer))
    await sheets.load()
    expect((await sign(good)).body.reason).toBe("sheet")
  })

  test("the live band: lowest and highest load pass, one unit outside does not", async () => {
    const { sign, record, reqId, tokensIn, tokensOut, sheet } = await served()
    const band = liveBand(sheet, NOW)
    expect(band.in).toEqual({ low: 100_000n, high: 240_000n })
    expect(band.out).toEqual({ low: 400_000n, high: 960_000n })
    const counts = { tokensIn, tokensOut }
    expect((await sign(record(reqId, { ...counts, priceIn: band.in.low - 1n }))).body.reason).toBe("price")
    expect((await sign(record(reqId, { ...counts, priceIn: band.in.high + 1n }))).body.reason).toBe("price")
    expect((await sign(record(reqId, { ...counts, priceOut: band.out.low - 1n }))).body.reason).toBe("price")
    expect((await sign(record(reqId, { ...counts, priceOut: band.out.high + 1n }))).body.reason).toBe("price")
    expect((await sign(record(reqId, { ...counts, priceIn: band.in.low, priceOut: band.out.high }))).status).toBe(200)
  })

  test("the band follows the sheet's hour of the week", async () => {
    const { sign, record, reqId, tokensIn, tokensOut, sheets } = await served()
    const dear = baseSheet({ baseIn: week(200_000n).with(hourOfWeek(NOW), 1_000_000n), validFrom: 1, nonce: 2n })
    const sheetHash = await sheets.save(dear, await signSheet(dear))
    await sheets.load()
    const counts = { tokensIn, tokensOut, sheetHash }
    expect((await sign(record(reqId, { ...counts, priceIn: 200_000n }))).body.reason).toBe("night_jobs_off")
    expect((await sign(record(reqId, { ...counts, priceIn: 400_000n }))).status).toBe(200)
  })

  test("a host cost that does not follow from the record is refused", async () => {
    const { sign, good } = await served()
    expect((await sign({ ...good, hostCostMicro: good.hostCostMicro - 1n })).body.reason).toBe("cost")
    expect((await sign({ ...good, hostCostMicro: good.hostCostMicro + 1n })).body.reason).toBe("cost")
  })

  test("a zero output price needs zero output", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    expect((await sign(record(reqId, { tokensIn, tokensOut, priceOut: 0n }))).body.reason).toBe("price")
  })

  test("window draw-downs carry no price and must be zero throughout", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    const counts = { tokensIn, tokensOut, payMode: 4 as const, feeMicro: 0n }
    expect((await sign(record(reqId, { ...counts, priceIn: 0n, priceOut: 0n, hostCostMicro: 1n }))).body.reason).toBe("price")
    expect((await sign(record(reqId, { ...counts, priceIn: 0n, priceOut: 0n, hostCostMicro: 0n }))).status).toBe(200)
  })

  test("a zero-priced record is refused in every other pay mode", async () => {
    const { sign, record, reqId, tokensIn, tokensOut } = await served()
    expect((await sign(record(reqId, { tokensIn, tokensOut, priceIn: 0n, priceOut: 0n, payMode: 3 }))).body.reason).toBe("price")
  })

  test("a locked night price passes only on a host that opted in, and a refusal says why", async () => {
    const dear = baseSheet({ baseIn: week(200_000n).with(0, 900_000n) })
    expect(nightBand(dear).in).toEqual({ low: 100_000n, high: 1_080_000n })
    const locked = 500_000n
    const honest = await served({ nightJobs: true })
    const sheet = baseSheet({ baseIn: dear.baseIn, validFrom: 1, nonce: 2n })
    const sheetHash = await honest.sheets.save(sheet, await signSheet(sheet))
    await honest.sheets.load()
    expect((await honest.sign(honest.record(honest.reqId, { tokensIn: honest.tokensIn, tokensOut: honest.tokensOut, priceIn: locked, sheetHash }))).status).toBe(200)
    const strict = await served({ nightJobs: false })
    const hash = await strict.sheets.save(sheet, await signSheet(sheet))
    await strict.sheets.load()
    expect((await strict.sign(strict.record(strict.reqId, { tokensIn: strict.tokensIn, tokensOut: strict.tokensOut, priceIn: locked, sheetHash: hash }))).body.reason).toBe("night_jobs_off")
  })

  test("a price outside even the week's limits is still a plain price refusal", async () => {
    const strict = await served({ nightJobs: false })
    expect((await strict.sign(strict.record(strict.reqId, { tokensIn: strict.tokensIn, tokensOut: strict.tokensOut, priceIn: 90_000_000n }))).body.reason).toBe("price")
  })

  test("the agent says which models take night jobs, so a router can avoid the rest", async () => {
    const off = await served({ nightJobs: false })
    const on = await served({ nightJobs: true })
    const listed = async (row: typeof off) => ((await (await row.app.request("/offpeak/v1/info")).json()) as { nightJobModels: string[] }).nightJobModels
    expect(await listed(off)).toEqual([])
    expect(await listed(on)).toEqual([DIGEST])
  })

  test("a sheet's hash here equals the router's", async () => {
    const { sheetHashOf: routerHash } = await import("../../router/src/pricing/pricebook.ts")
    const sheet = baseSheet()
    expect(sheetHashOf(sheet, REGISTRY)).toBe(routerHash(sheet, REGISTRY))
  })

  test("a forged sheet file stops the book from loading", async () => {
    const { sheets, dataDir, sheetHash } = await harness()
    const path = join(dataDir, "sheets", `${sheetHash}.json`)
    const stored = JSON.parse(readFileSync(path, "utf8"))
    stored.sheet.floorIn = "1"
    writeFileSync(path, JSON.stringify(stored))
    await expect(sheets.load()).rejects.toThrow("is not this host's")
  })
})

describe("one signature per request", () => {
  test("a retry of the same record gets the same answer and one log line", async () => {
    const { sign, good, dataDir } = await served()
    const first = await sign(good)
    const second = await sign(good)
    expect(second.status).toBe(200)
    expect(second.body.hostSig).toBe(first.body.hostSig)
    const day = readdirSync(join(dataDir, "signed"))
    expect(day).toHaveLength(1)
    expect(readFileSync(join(dataDir, "signed", day[0]!), "utf8").trim().split("\n")).toHaveLength(1)
  })
