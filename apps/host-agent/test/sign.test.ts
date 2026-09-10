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

  test("a second, different record for that request is refused", async () => {
    const { sign, good } = await served()
    expect((await sign(good)).status).toBe(200)
    const lower = { ...good, tokensOut: good.tokensOut - 1, hostCostMicro: hostCostMicro(good.tokensIn, good.tokensOut - 1, good.priceIn, good.priceOut) }
    expect((await sign(lower)).body.reason).toBe("already_signed")
  })

  test("two different records at once cannot both be signed", async () => {
    const { sign, good } = await served()
    const lower = { ...good, tokensOut: good.tokensOut - 1, hostCostMicro: hostCostMicro(good.tokensIn, good.tokensOut - 1, good.priceIn, good.priceOut) }
    const replies = await Promise.all([sign(good), sign(lower)])
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409])
  })

  test("a refused record can be corrected", async () => {
    const { sign, good } = await served()
    expect((await sign({ ...good, hostCostMicro: 1n })).status).toBe(409)
    expect((await sign(good)).status).toBe(200)
  })
})

describe("the signing log", () => {
  test("holds the record, both signatures and vLLM's usage, and no text", async () => {
    const { sign, good, dataDir, routerSig, tokensIn, tokensOut } = await served()
    const { body } = await sign(good)
    const [file] = readdirSync(join(dataDir, "signed"))
    expect(file).toBe(`signed-${new Date(NOW * 1000).toISOString().slice(0, 10)}.jsonl`)
    const raw = readFileSync(join(dataDir, "signed", file!), "utf8")
    const entry = JSON.parse(raw)
    expect(parseRecord(entry.record)).toEqual(parseRecord(serializeRecord(good)))
    expect(entry.routerSig).toBe(await routerSig(good))
    expect(entry.hostSig).toBe(body.hostSig)
    expect(entry.hostCounts).toEqual({ tokensIn, tokensOut })
    expect(entry.engineUsage.prompt_tokens).toBe(tokensIn)
    expect(entry.engineUsage.completion_tokens).toBe(tokensOut)
    expect(raw).not.toContain("Say something")
    expect(raw).not.toContain("neural networks")
  })

  test("a log that cannot be written stops the signature", async () => {
    const { sign, good, log } = await served()
    log.append = async () => {
      throw new Error("disk full")
    }
    const reply = await sign(good)
    expect(reply.status).toBe(500)
    expect(reply.body.hostSig).toBeUndefined()
    expect(reply.body.reason).toBe("sign_failed")
  })

  test("drops days past 30 and nothing else", async () => {
    const { dataDir } = await harness()
    const dir = join(dataDir, "signed")
    const log = new SignedLog(dir)
    const day = (back: number) => new Date((NOW - back * 86_400) * 1000).toISOString().slice(0, 10)
    for (const back of [31, 30, 1]) writeFileSync(join(dir, `signed-${day(back)}.jsonl`), "{}\n")
    writeFileSync(join(dir, "notes.txt"), "keep")
    await log.prune(NOW)
    expect(readdirSync(dir).sort()).toEqual([`signed-${day(30)}.jsonl`, `signed-${day(1)}.jsonl`, "notes.txt"].sort())
  })

  const anEntry = { at: NOW, record: {} as never, routerSig: "0x" as Hex, hostSig: "0x" as Hex, leaf: "0x" as Hex, partial: false, hostCounts: { tokensIn: 1, tokensOut: 1 }, engineUsage: null, hostOutputHash: null }

  test("an entry is on disk before append returns", async () => {
    const { dataDir } = await harness()
    const steps: string[] = []
    const watching = (async (...args: Parameters<typeof open>) => {
      const file = await open(...args)
      const { appendFile, sync } = file
      file.appendFile = (...rest: Parameters<typeof appendFile>) => (steps.push("write"), appendFile.apply(file, rest))
      file.sync = () => (steps.push("sync"), sync.apply(file))
      return file
    }) as typeof open
    const log = new SignedLog(join(dataDir, "signed"), watching)
    await log.open()
    await log.append(anEntry)
    expect(steps.slice(0, 2)).toEqual(["write", "sync"])
    steps.length = 0
    await log.append(anEntry)
    expect(steps).toEqual(["write", "sync"])
  })

  test("a line cut short by a crash stays apart from the next entry", async () => {
    const { dataDir } = await harness()
    const dir = join(dataDir, "signed")
    const file = join(dir, `signed-${new Date(NOW * 1000).toISOString().slice(0, 10)}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ whole: 1 })}\n{"cut":"sho`)
    const log = new SignedLog(dir)
    await log.open()
    await log.append(anEntry)
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('{"cut":"sho')
    expect(JSON.parse(lines[2]!).at).toBe(NOW)
  })

  test("reopening a clean log adds nothing", async () => {
    const { dataDir } = await harness()
    const dir = join(dataDir, "signed")
    const log = new SignedLog(dir)
    await log.open()
    await log.append(anEntry)
    const [name] = readdirSync(dir)
    const before = readFileSync(join(dir, name!), "utf8")
    await new SignedLog(dir).open()
    expect(readFileSync(join(dir, name!), "utf8")).toBe(before)
  })

  test("entries written at once stay whole lines", async () => {
    const { dataDir } = await harness()
    const dir = join(dataDir, "signed")
    const log = new SignedLog(dir)
    await log.open()
    await Promise.all(Array.from({ length: 50 }, () => log.append(anEntry)))
    const [name] = readdirSync(dir)
    for (const line of readFileSync(join(dir, name!), "utf8").trim().split("\n")) expect(JSON.parse(line).at).toBe(NOW)
  })

  test("appends and never rewrites", async () => {
    const { dataDir } = await harness()
    const log = new SignedLog(join(dataDir, "signed"))
    const entry = { at: NOW, record: {} as never, routerSig: "0x" as Hex, hostSig: "0x" as Hex, leaf: "0x" as Hex, partial: false, hostCounts: { tokensIn: 1, tokensOut: 1 }, engineUsage: null, hostOutputHash: null }
    await log.append(entry)
    await log.append(entry)
    const [file] = readdirSync(join(dataDir, "signed"))
    expect(readFileSync(join(dataDir, "signed", file!), "utf8").trim().split("\n")).toHaveLength(2)
  })
})

describe("what the host counts", () => {
  test("tool calls fold across chunks the way the router folds them", async () => {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q": "1"}' } }]
    const { sign, record, reqId, tokensIn } = await served({ reply: () => ({ text: "", toolCalls }) })
    const tokensOut = tokenizer.countOutput("", toolCalls, "tool_calls")
    const { status, body } = await sign(record(reqId, { tokensIn, tokensOut }))
    expect(status).toBe(200)
    expect(body.hostCounts.tokensOut).toBe(tokensOut)
  })

  test("a reply cut by max_tokens counts no end token", async () => {
    const { sign, record, reqId, tokensIn } = await served({ reply: () => ({ text: REPLY, finish: "length" }) })
    const tokensOut = tokenizer.countText(REPLY)
    expect((await sign(record(reqId, { tokensIn, tokensOut }))).body.hostCounts.tokensOut).toBe(tokensOut)
  })

  test("a prompt the template cannot render leaves the host with nothing to sign", async () => {
    const row = await harness({ model: { tokenizer: { ...pick(tokenizer), countChat: () => { throw new Error("template failed") } } } })
    const { reqId } = await row.serve()
    expect((await row.sign(row.record(reqId, { tokensIn: 1, tokensOut: 1 }))).body.reason).toBe("uncounted")
  })

  test("the digest and name in the record match the manifest", () => {
    expect(DIGEST).toBe("0x9599ee65e52af1a4254555c5d515ea86484eff63776402469bc1c640636875c9")
  })
})

function pick(source: typeof tokenizer) {
  return {
    render: source.render.bind(source),
    encode: source.encode.bind(source),
    decodeToken: source.decodeToken.bind(source),
    countChat: source.countChat.bind(source),
    countOutput: source.countOutput.bind(source),
    countInputs: source.countInputs.bind(source),
  }
}

test("no record is signed while its stream is still running", async () => {
  let release = () => {}
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const row = await harness({ hold })
  const { res, reqId } = await row.post("/offpeak/v1/chat/completions", row.chatBody())
  const reading = res.text()
  let finished = false
  const signing = row.sign(row.record(reqId, { tokensIn: 1, tokensOut: 1 }), { partial: true }).then((reply) => {
    finished = true
    return reply
  })
  await Bun.sleep(30)
  expect(finished).toBe(false)
  release()
  await reading
  const reply = await signing
  expect(reply.body.reason).toBe("counts")
  expect(reply.body.hostCounts.tokensOut).toBe(tokenizer.countOutput(REPLY, undefined, "stop"))
})
