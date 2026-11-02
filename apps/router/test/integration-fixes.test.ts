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

  test("a channel stream's owed event is a chunk too", async () => {
    const booted = await bootStack()
    const id = keccak256(toBytes("stream-channel"))
    booted.indexer.channels.set(id, { payer: booted.buyer as Hex, deposit: 50_000_000n, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false })
    const body = JSON.stringify(chatBody({ stream: true }))
    const auth = await channelAuthHeader(roleAccount("buyer"), { channelId: id, ts: booted.stack.clock(), body })
    const text = await (await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })).text()
    const owed = text.split("\n\n").find((block) => block.startsWith("event: offpeak.channel"))!
    expect(JSON.parse(owed.split("\n")[1]!.slice("data: ".length))).toMatchObject({ object: "chat.completion.chunk", choices: [{ delta: {} }], owed: expect.stringMatching(/^\d+$/) })
  })
})

describe("usage API", () => {
  test("GET /v1/usage/:reqId gives the whole envelope, the same one the response carried", async () => {
    const booted = await bootStack()
    const { offpeak_usage: usage } = (await (await chat(booted, chatBody())).json()) as Served
    const view = (await (await booted.app.request(`/v1/usage/${usage.record.reqId}`)).json()) as { envelope: unknown; proof: unknown }
    expect(view.envelope).toEqual(usage)
    expect(view.proof).toBeNull()
    expect((await booted.app.request("/v1/usage/not-an-id")).status).toBe(404)
  })

  test("a key lists its own records, newest first, in pages, and never another buyer's", async () => {
    const booted = await bootStack()
    const first = (await (await chat(booted, chatBody())).json()) as Served
    booted.stack.setClock(booted.stack.clock() + 10)
    const second = (await (await chat(booted, chatBody())).json()) as Served
    const list = async (query: string, headers = bearer(booted)) => booted.app.request(`/v1/usage${query}`, { headers })
    const all = (await (await list("")).json()) as { records: { envelope: { record: { reqId: string } }; status: string }[]; next: unknown }
    expect(all.records.map((row) => row.envelope.record.reqId)).toEqual([second.offpeak_usage.record.reqId, first.offpeak_usage.record.reqId])
    expect(all.records[0]!.status).toBe("final")
    expect(all.next).toBeNull()
    const page = (await (await list("?limit=1")).json()) as { records: { envelope: { record: { reqId: string } } }[]; next: { before_ts: number; before_id: string } }
    expect(page.records).toHaveLength(1)
    const rest = (await (await list(`?limit=1&before_ts=${page.next.before_ts}&before_id=${page.next.before_id}`)).json()) as typeof page
    expect(rest.records[0]!.envelope.record.reqId).toBe(first.offpeak_usage.record.reqId)
    const since = booted.stack.clock()
    expect(((await (await list(`?since=${since}`)).json()) as typeof all).records).toHaveLength(1)
    expect(((await (await list(`?since=${new Date(since * 1000).toISOString()}`)).json()) as typeof all).records).toHaveLength(1)
    expect((await list("?since=soon")).status).toBe(400)
  })

  test("listing needs a key, and a key sees only its wallet", async () => {
    const booted = await bootStack()
    await chat(booted, chatBody())
    expect((await booted.app.request("/v1/usage")).status).toBe(401)
    expect((await booted.app.request("/v1/usage", { headers: { authorization: "Bearer op_live_nope" } })).status).toBe(401)
    const other = await issueKey(booted.stack, "0x000000000000000000000000000000000000dead")
    const seen = (await (await booted.app.request("/v1/usage", { headers: { authorization: `Bearer ${other.token}` } })).json()) as { records: unknown[] }
    expect(seen.records).toEqual([])
  })
})

describe("GET /v1/prices", () => {
  test("lists every host, keys the forecast by absolute hour, and uses buyer prices", async () => {
    const booted = await bootStack({ secondHost: true })
    const board = (await (await booted.app.request("/v1/prices?model=ofm-8b")).json()) as {
      digest: string
      now: { in: string; out: string; host: string }
      hosts: { host: string; live: { in: string }; base: { in: string }; floor: { in: string }; effective_discount_30d_bps: number | null; sealed: boolean }[]
      next168h: { hour: number; forecast_in: string; forecast_out: string }[]
    }
    expect(board.digest).toBe(booted.modelDigest)
    expect(board.hosts).toHaveLength(2)
    expect(Object.keys(board.hosts[0]!).sort()).toEqual(["base", "effective_discount_30d_bps", "floor", "host", "live", "sealed"])
    expect(board.now.host).toBe(booted.host)
    expect(board.next168h).toHaveLength(168)
    expect(board.next168h[0]!.hour).toBe(hourIndex(booted.stack.clock()))
    expect(board.next168h[167]!.hour).toBe(hourIndex(booted.stack.clock()) + 167)
    expect(Object.keys(board.next168h[0]!).sort()).toEqual(["forecast_in", "forecast_out", "hour"])
    expect(board.hosts[0]!.floor.in).toBe("104000")
  })

  test("a key prices the board at its own fee", async () => {
    const booted = await bootStack()
    await booted.stack.db.query("UPDATE serving.accounts SET audit_opt_in = true")
    const { token } = await issueKey(booted.stack, booted.buyer)
    const anon = (await (await booted.app.request("/v1/prices")).json()) as { now: { in: string } }
    const mine = (await (await booted.app.request("/v1/prices", { headers: { authorization: `Bearer ${token}` } })).json()) as { now: { in: string } }
    expect(BigInt(mine.now.in)).toBeLessThan(BigInt(anon.now.in))
  })

  test("an unknown model is a 404, and a bad key is refused", async () => {
    const booted = await bootStack()
    expect((await booted.app.request("/v1/prices?model=nope")).status).toBe(404)
    expect((await booted.app.request("/v1/prices", { headers: { authorization: "Bearer op_live_nope" } })).status).toBe(401)
  })
})

describe("POST /v1/hosts/price-sheet", () => {
  const signed = async (booted: Booted, over: Record<string, unknown> = {}) => {
    const sheet = sheetFromJson({
      host: booted.host,
      modelDigest: booted.modelDigest,
      baseIn: Array(168).fill("200000"),
      baseOut: Array(168).fill("800000"),
      floorIn: "100000",
      floorOut: "400000",
      validFrom: booted.stack.clock() + 7200,
      nonce: "2",
      ...over,
    } as never)
    const sig = await roleAccount("host").signTypedData(sheetTypedData(sheet, booted.stack.registry) as never)
    return { sheet, body: { sheet: sheetToJson(sheet), sig } }
  }
  const post = (booted: Booted, body: unknown) => booted.app.request("/v1/hosts/price-sheet", { method: "POST", body: JSON.stringify(body) })

  test("takes the JSON the host CLI posts, stores it, and serves it", async () => {
    const booted = await bootStack()
    const { sheet, body } = await signed(booted)
    const res = await post(booted, body)
    expect(res.status).toBe(200)
    const hash = sheetHashOf(sheet, booted.stack.registry)
    expect(await res.json()).toEqual({ ok: true, sheetHash: hash })
    expect(booted.stack.sheets.at(-1)!.nonce).toBe(2n)
    const rows = await booted.stack.db.query<{ sheet_hash: string }>("SELECT sheet_hash FROM serving.price_sheets")
    expect(rows.rows.map((row) => row.sheet_hash)).toEqual([hash])
  })

  test("the floor rule, the lead time, the signature and a bad body are each refused", async () => {
    const booted = await bootStack()
    const refused = async (body: unknown) => {
      const res = await post(booted, body)
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: string }).error
    }
    expect(await refused((await signed(booted, { floorIn: "120001" })).body)).toBe("floor_above_0_6_min_base")
    expect(await refused((await signed(booted, { validFrom: booted.stack.clock() + 60 })).body)).toBe("valid_from_too_soon")
    const { body } = await signed(booted)
    expect(await refused({ ...body, sig: await anvilAccount(7).signTypedData(sheetTypedData(sheetFromJson(body.sheet), booted.stack.registry) as never) })).toBe("bad_signature")
    expect(await refused({ sheet: { ...body.sheet, baseIn: [1] }, sig: body.sig })).toBe("bad_sheet")
    expect(await refused(null)).toBe("bad_sheet")
  })

  test("the nonce must rise per model, and a host gets 24 changes a week", async () => {
    const booted = await bootStack()
    expect((await post(booted, (await signed(booted, { nonce: "5" })).body)).status).toBe(200)
    expect((await (await post(booted, (await signed(booted, { nonce: "5" })).body)).json()) as object).toEqual({ ok: false, error: "nonce_not_increasing" })
    await booted.stack.db.query("UPDATE serving.sheet_counts SET n = 24")
    expect((await (await post(booted, (await signed(booted, { nonce: "6" })).body)).json()) as object).toEqual({ ok: false, error: "weekly_sheet_limit" })
  })
})

describe("keys and audit responses", () => {
  test("a new key keeps the audit opt-in", async () => {
    const booted = await bootStack()
    await booted.stack.db.query("UPDATE serving.accounts SET audit_opt_in = true WHERE wallet = $1", [booted.buyer])
    await issueKey(booted.stack, booted.buyer)
    const rows = await booted.stack.db.query<{ audit_opt_in: boolean }>("SELECT audit_opt_in FROM serving.accounts WHERE wallet = $1", [booted.buyer])
    expect(rows.rows[0]!.audit_opt_in).toBe(true)
  })

  test("audit-response calldata goes to this deployment's court", async () => {
    const booted = await bootStack()
    booted.stack.auditCourt = "0x00000000000000000000000000000000000c0a7c"
    const res = await booted.app.request("/v1/hosts/audit-response", { method: "POST", body: JSON.stringify({ challengeId: "7", response: "my answer" }) })
    const body = (await res.json()) as { to: string; data: Hex; responseHash: Hex }
    expect(body.to).toBe(booted.stack.auditCourt)
    expect(decodeFunctionData({ abi: auditCourtAbi, data: body.data }).args).toEqual([7n, body.responseHash])
    expect((await booted.app.request("/v1/hosts/audit-response", { method: "POST", body: "{}" })).status).toBe(400)
    booted.stack.auditCourt = ""
    expect((await booted.app.request("/v1/hosts/audit-response", { method: "POST", body: JSON.stringify({ challengeId: "7", response: "x" }) })).status).toBe(503)
  })
})

describe("channel view", () => {
  test("shows the vouchered cumulative beside what is owed", async () => {
    const booted = await bootStack()
    const id = keccak256(toBytes("view-channel"))
    booted.indexer.channels.set(id, { payer: booted.buyer as Hex, deposit: 50_000_000n, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false })
    const view = async () => {
      const proof = await channelAuthHeader(roleAccount("buyer"), { channelId: id, ts: booted.stack.clock(), body: "" })
      return (await (await booted.app.request(`/v1/channels/${id}`, { headers: { "x-offpeak-channel-auth": proof } })).json()) as { cumulative: string; owed: string }
    }
    expect(await view()).toMatchObject({ cumulative: "0", owed: "0" })
    const body = JSON.stringify(chatBody())
    const auth = await channelAuthHeader(roleAccount("buyer"), { channelId: id, ts: booted.stack.clock(), body })
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
    const owed = res.headers.get("x-offpeak-channel-owed")!
    expect(await view()).toMatchObject({ cumulative: "0", owed })
    const sig = await roleAccount("buyer").signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: BigInt(owed) } })
    expect((await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: owed, sig }) })).status).toBe(200)
    expect(await view()).toMatchObject({ cumulative: owed, owed })
  })
})

describe("load and stats", () => {
  test("recordLoad writes one row per host and model, with requests in flight", async () => {
    const booted = await bootStack()
    booted.stack.load.enter(booted.host, booted.modelDigest)
    booted.stack.load.enter(booted.host, booted.modelDigest)
    booted.stack.load.leave(booted.host, booted.modelDigest)
    await recordLoad(booted.stack)
    const rows = await booted.stack.db.query<{ host: string; inflight: number; healthy: boolean }>("SELECT host, inflight, healthy FROM serving.host_load")
    expect(rows.rows).toEqual([{ host: booted.host, inflight: 1, healthy: true }])
  })

  test("a finished chat leaves nothing in flight", async () => {
    const booted = await bootStack()
    expect((await chat(booted, chatBody())).status).toBe(200)
    await (await chat(booted, chatBody({ stream: true }))).text()
    expect(booted.stack.load.inflight(booted.host, booted.modelDigest)).toBe(0)
  })

  test("the stats job fills host_stats, the price board shows the discount, and it can run again", async () => {
    const booted = await bootStack()
    expect((await chat(booted, chatBody())).status).toBe(200)
    await writeHostStats(booted.stack)
    await writeHostStats(booted.stack)
    const rows = await booted.stack.db.query<{ host: string; served_tokens: string; billed_host_micro: string; base_value_micro: string; effective_discount_bps: number }>("SELECT * FROM serving.host_stats")
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]!
    expect(row.host).toBe(booted.host)
    expect(Number(row.served_tokens)).toBeGreaterThan(0)
    expect(BigInt(row.base_value_micro)).toBeGreaterThan(BigInt(row.billed_host_micro))
    expect(row.effective_discount_bps).toBeGreaterThan(0)
    const board = (await (await booted.app.request("/v1/prices")).json()) as { hosts: { effective_discount_30d_bps: number }[] }
    expect(board.hosts[0]!.effective_discount_30d_bps).toBe(row.effective_discount_bps)
  })

  test("Window draws say nothing about a discount", async () => {
    const booted = await bootStack()
    const ts = booted.stack.clock()
    const hash = `0x${"12".repeat(32)}`
    await insertUsage(booted.stack.db, {
      reqId: hash,
      hour: hourIndex(ts),
      ts,
      payer: booted.buyer,
      buyerRef: hash,
      host: booted.host,
      modelDigest: booted.modelDigest,
      tokensIn: 1_000,
      tokensOut: 1_000,
      promptHash: hash,
      outputHash: hash,
      priceIn: 0n,
      priceOut: 0n,
      hostCostMicro: 0n,
      feeMicro: 0n,
      feeBps: 0,
      payMode: 4,
      payRef: hash,
      sheetHash: booted.stack.sheets[0]!.sheetHash,
      windowId: "1",
      routerSig: "0x00",
      hostSig: "0x00",
      leaf: hash,
      sealed: false,
    })
    await writeHostStats(booted.stack)
    expect((await booted.stack.db.query("SELECT * FROM serving.host_stats")).rows).toEqual([])
  })
})

describe("router boot", () => {
  const key = (byte: string) => `0x${byte.repeat(32)}`
  const dir = mkdtempSync(join(tmpdir(), "offpeak-boot-"))
  const models = join(dir, "models.json")
  writeFileSync(models, JSON.stringify([{ name: "ofm-8b", digest: `0x${"12".repeat(32)}`, contextLength: 8192, kind: "chat" }]))
  const env = {
    OFFPEAK_ENV: "mainnet",
    OFFPEAK_DEPLOYMENT_FILE: "unused",
    OFFPEAK_MODELS_FILE: models,
    OFFPEAK_DATABASE_URL: "pglite://memory",
    OFFPEAK_REDIS_URL: "redis://127.0.0.1:36999",
    OFFPEAK_INDEXER_URL: "http://127.0.0.1:36999",
    OFFPEAK_FACILITATOR_URL: "http://127.0.0.1:36999",
    OFFPEAK_INTERNAL_TOKEN: "x".repeat(32),
    OFFPEAK_ROUTER_SIGNER_KEY: key("11"),
    OFFPEAK_CHANNEL_PAYEE: roleAccount("host").address,
    OFFPEAK_PUBLIC_BASE_URL: "http://127.0.0.1:36999",
  }

  test("on mainnet a model with no tokenizer stops the boot, before anything opens", async () => {
    await expect(bootRouter(env)).rejects.toThrow("no tokenizer for model ofm-8b")
  })

  test("the payee key is read from the environment, empty means none, and the wrong one stops the boot", async () => {
    await expect(bootRouter({ ...env, OFFPEAK_CHANNEL_PAYEE_KEY: "" })).rejects.toThrow("no tokenizer")
    await expect(bootRouter({ ...env, OFFPEAK_CHANNEL_PAYEE_KEY: key("22") })).rejects.toThrow("not the key of OFFPEAK_CHANNEL_PAYEE")
    await expect(bootRouter({ ...env, OFFPEAK_CHANNEL_PAYEE_KEY: key("11") })).rejects.toThrow("two roles on one key")
  })

  const own: Parameters<typeof assertKeySeparation>[1] = ["OFFPEAK_ROUTER_SIGNER_KEY", "OFFPEAK_CHANNEL_PAYEE_KEY"]

  test("the router may hold its signer and the payee key, as two keys", () => {
    expect(() => assertKeySeparation({ OFFPEAK_ROUTER_SIGNER_KEY: key("11"), OFFPEAK_CHANNEL_PAYEE_KEY: key("22") }, own)).not.toThrow()
    expect(() => assertKeySeparation({ OFFPEAK_ROUTER_SIGNER_KEY: key("11") }, own)).not.toThrow()
  })

  test("a payee key for another address stops the boot, and no key leaves close off", () => {
    const account = roleAccount("host")
    expect(() => payeeAccount(key("11"), account.address)).toThrow("not the key of OFFPEAK_CHANNEL_PAYEE")
    expect(payeeAccount(undefined, account.address)).toBeUndefined()
    const own = `0x${Buffer.from(account.getHdKey().privateKey!).toString("hex")}`
    expect(payeeAccount(own, account.address)?.address).toBe(account.address)
  })

  test("one key in both roles, or another service's key, stops the boot", () => {
    expect(() => assertKeySeparation({ OFFPEAK_ROUTER_SIGNER_KEY: key("11"), OFFPEAK_CHANNEL_PAYEE_KEY: key("11") }, own)).toThrow("two roles on one key")
    expect(() => assertKeySeparation({ OFFPEAK_ROUTER_SIGNER_KEY: key("11"), OFFPEAK_KEEPER_KEY: key("22") }, own)).toThrow("another role key")
  })
})
