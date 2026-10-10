import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { join } from "node:path"
import { Hono } from "hono"
import { channelAuthHeader, domain, hourIndex, manifestDigest, promptHashOf, readManifest, voucherTypes, type ChannelChain } from "@offpeak/shared"
import { hashTypedData, keccak256, toBytes, type Hex } from "viem"
import { openSample, type SampleRow } from "../../auditor/src/sample.ts"
import * as sample from "../../auditor/src/sample.ts"
import { sheetFromJson, sheetToJson, sheetTypedData } from "../../host-agent/src/sheets.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { sameSecret } from "../src/http.ts"
import { loadTokenizers } from "../src/metering/tokenize.ts"
import { dueNightSlots, runBatch } from "../src/openai/batches.ts"
import { RedisCounters, rebuildSpend } from "../src/pay/redis-holds.ts"
import { WindowPerf, sweepWindows } from "../src/pay/window-perf.ts"
import { pendingKey } from "../src/pay/window.ts"
import { bootStack } from "./support/stack.ts"
import { uptoHeader } from "./support/upto.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const buyerKey = roleAccount("buyer")
const WINDOW = "7"
const MINUTE = 60

const prepaid = (booted: Booted, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", ...extra })
const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const chat = (booted: Booted, body: string, headers: Record<string, string> = prepaid(booted)) => booted.app.request("/v1/chat/completions", { method: "POST", headers, body })
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code
const records = (booted: Booted) => booted.stack.db.query<{ req_id: string; tokens_in: number; tokens_out: number; prompt_hash: Hex; price_in: string }>("SELECT req_id, tokens_in, tokens_out, prompt_hash, price_in FROM shared.usage_records")
const flags = async (booted: Booted) => (await booted.stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")).rows.map((row) => row.reason)
const held = (booted: Booted) => booted.stack.ledger.committed(booted.buyer, 0n)

/** Numbers `JSON.parse` turns into Infinity, which `JSON.stringify` then sends on as null. */
const overflowing = (extra = '"x":1e999') => `{"model":"ofm-8b","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"stream":true,${extra}}`

/** Stands in front of the real host. `chat` answers its chat route, and it counts the requests that got there. */
function wrapHost(booted: Booted, chatRoute: (c: { req: { raw: Request } }) => Response | Promise<Response>) {
  const real = booted.hostApps.get(booted.host)!
  const seen = { chats: 0 }
  const app = new Hono()
  app.post("/offpeak/v1/chat/completions", (c) => {
    seen.chats += 1
    return chatRoute(c)
  })
  app.all("*", async (c) => real.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: c.req.method === "POST" ? await c.req.text() : undefined }))
  booted.hostApps.set(booted.host, app)
  return seen
}

const refusing = (booted: Booted, status: number) => wrapHost(booted, () => Response.json({ error: { message: "no", type: "invalid_request", code: "bad_request" } }, { status }))

/** Counts chats, and passes them on to the real host. */
function countChats(booted: Booted) {
  const real = booted.hostApps.get(booted.host)!
  return wrapHost(booted, async (c) => real.request("/offpeak/v1/chat/completions", { method: "POST", headers: c.req.raw.headers, body: await c.req.raw.text() }))
}

function holdWindow(booted: Booted) {
  const now = booted.stack.clock()
  booted.indexer.windows.set(WINDOW, { id: 7n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: BigInt(now - 10), t1: BigInt(now + 7200), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
  booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
}

const pending = (booted: Booted) => booted.stack.counters.get(pendingKey(7n, booted.buyer, hourIndex(booted.stack.clock())))
const demandedMinutes = async (booted: Booted) => (await booted.stack.db.query("SELECT 1 FROM shared.window_perf WHERE demanded")).rows.length

async function sweepPast(booted: Booted) {
  for (let i = 0; i < 3; i++) {
    booted.stack.setClock(booted.stack.clock() + MINUTE)
    await sweepWindows(booted.stack)
  }
}

function openChannel(booted: Booted, id: Hex, deposit = 50_000_000n) {
  const row: ChannelChain = { payer: booted.buyer as Hex, deposit, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false }
  booted.indexer.channels.set(id, row)
  return row
}

const channelChat = async (booted: Booted, id: Hex, body: string) =>
  chat(booted, body, { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body }) })

const uptoChat = async (booted: Booted, seed: string, body: string) => chat(booted, body, { "content-type": "application/json", "payment-signature": await uptoHeader(booted.stack, buyerKey, keccak256(toBytes(seed))) })

afterEach(() => {
  mock.restore()
})

describe("a body that cannot be hashed", () => {
  test("is refused before payment in every pay mode, so no host serves it", async () => {
    const booted = await bootStack()
    const seen = countChats(booted)
    const verify = spyOn(booted.stack.facilitator, "verify")
    holdWindow(booted)
    const channel = keccak256(toBytes("free-stream"))
    openChannel(booted, channel)
    const body = overflowing()
    const answers = [
      await chat(booted, body),
      await chat(booted, body, prepaid(booted, { "x-offpeak-window": WINDOW })),
      await channelChat(booted, channel, body),
      await uptoChat(booted, "free-stream", body),
    ]
    for (const res of answers) {
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("bad_body")
    }
    expect(seen.chats).toBe(0)
    expect(verify).not.toHaveBeenCalled()
    expect(await held(booted)).toBe(0n)
    expect(await pending(booted)).toBe(0n)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.channel_reservations")).rows.length).toBe(0)
  })

  test("is refused wherever the number sits, and the same reply goes out for one a template cannot render", async () => {
    const booted = await bootStack()
    expect((await chat(booted, overflowing('"tools":[{"type":"function","function":{"name":"f","parameters":{"max":-1e999}}}]'))).status).toBe(400)
    const manifestPath = join(import.meta.dir, "../../../packages/shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/manifest.json")
    const digest = manifestDigest(readManifest(manifestPath))
    const real = await bootStack({ modelDigest: digest })
    loadTokenizers([{ name: "ofm-8b", digest, tokenizer: { manifest: manifestPath, dir: join(manifestPath, "..") } }], false)
    const seen = countChats(real)
    const res = await chat(real, JSON.stringify({ model: "ofm-8b", max_tokens: 8, stream: true, messages: [{ role: "assistant", content: "x", tool_calls: [null] }] }))
    expect(res.status).toBe(400)
    expect(seen.chats).toBe(0)
  })
})

describe("a bill that throws after the host served", () => {
  test("keeps the hold, flags the request and says it went unbilled", async () => {
    const booted = await bootStack()
    const realRequest = booted.stack.hosts.request
    booted.stack.hosts.request = async (host, endpoint, path, init) => {
      if (path === "/offpeak/v1/sign") throw new Error("link down")
      return realRequest(host, endpoint, path, init)
    }
    const text = await (await chat(booted, chatBody("hello", { stream: true }))).text()
    expect(text).toContain("unbilled")
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bill_failed"])
    expect(await held(booted)).toBeGreaterThan(0n)
  })

  test("a host that refuses to sign still releases, as 3.4 has it", async () => {
    const booted = await bootStack()
    const real = booted.hostApps.get(booted.host)!
    const refuser = new Hono()
    refuser.post("/offpeak/v1/sign", (c) => c.json({ refused: true, reason: "counts", hostCounts: {} }, 409))
    refuser.all("*", async (c) => real.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: await c.req.text() }))
    booted.hostApps.set(booted.host, refuser)
    expect(await (await chat(booted, chatBody("hello", { stream: true }))).text()).toContain("unbilled")
    expect(await held(booted)).toBe(0n)
    expect(await flags(booted)).toEqual(["counts"])
  })
})

describe("host health", () => {
  test("a message with no role is refused at the door", async () => {
    const booted = await bootStack()
    const seen = countChats(booted)
    for (const message of [{ content: "hi" }, { role: "wizard", content: "hi" }, { role: 5, content: "hi" }, null]) {
      const res = await chat(booted, JSON.stringify({ model: "ofm-8b", messages: [message] }))
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("bad_messages")
    }
    expect(seen.chats).toBe(0)
  })

  test("a 4xx from the host is the buyer's, so the host stays in routing and the hold goes back", async () => {
    const booted = await bootStack()
    refusing(booted, 400)
    for (let i = 0; i < 5; i++) {
      const res = await chat(booted, chatBody(`bad ${i}`))
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("host_refused")
    }
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
    expect(await held(booted)).toBe(0n)
    booted.stack.candidateCache.clear()
    expect(await errorCode(await chat(booted, chatBody("still routed")))).toBe("host_refused")
  })

  test("a 5xx and a timeout still count", async () => {
    const booted = await bootStack()
    refusing(booted, 502)
    expect((await chat(booted, chatBody("down"))).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(1)
    const slow = await bootStack()
    slow.stack.ttftFailoverMs = 5
    slow.stack.hosts.request = (_host, _endpoint, _path, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("abort"))))
    expect((await chat(slow, chatBody("slow"))).status).toBe(503)
    expect(slow.stack.load.errorRate(slow.host)).toBe(1)
  })

  test("embeddings hold to the same rule", async () => {
    const booted = await bootStack()
    const real = booted.hostApps.get(booted.host)!
    const answering = new Hono()
    let status = 400
    answering.post("/offpeak/v1/embeddings", (c) => c.json({ error: { code: "too_long" } }, status as 400))
    answering.all("*", (c) => real.fetch(c.req.raw))
    booted.hostApps.set(booted.host, answering)
    const embed = () => booted.app.request("/v1/embeddings", { method: "POST", headers: prepaid(booted), body: JSON.stringify({ model: "ofm-embed", input: "hello" }) })
    const refused = await embed()
    expect(refused.status).toBe(400)
    expect(await errorCode(refused)).toBe("host_refused")
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
    status = 500
    expect((await embed()).status).toBe(503)
    expect(booted.stack.load.errorRate(booted.host)).toBe(1)
  })
})

describe("Window demand", () => {
  test("a request the host refuses leaves no demanded minute, and gives its tokens back", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    refusing(booted, 400)
    const res = await chat(booted, chatBody("forged"), prepaid(booted, { "x-offpeak-window": WINDOW }))
    expect(res.status).toBe(400)
    expect(await pending(booted)).toBe(0n)
    await sweepPast(booted)
    expect(await demandedMinutes(booted)).toBe(0)
  })

  test("a host that fails a holder still leaves one", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    refusing(booted, 503)
    expect((await chat(booted, chatBody("real"), prepaid(booted, { "x-offpeak-window": WINDOW }))).status).toBe(503)
    await sweepPast(booted)
    expect(await demandedMinutes(booted)).toBe(1)
  })

  test("a holder who hangs up before the first token leaves none", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    wrapHost(booted, (c) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
          c.req.raw.signal.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    })
    const res = await chat(booted, chatBody("gone", { stream: true }), prepaid(booted, { "x-offpeak-window": WINDOW }))
    await res.body!.cancel()
    for (let i = 0; i < 100 && (await flags(booted)).length === 0; i++) await Bun.sleep(5)
    await sweepPast(booted)
    expect(await demandedMinutes(booted)).toBe(0)
  })

  test("a dropped flow takes nothing from real demand in the same minute", () => {
    let seconds = 6_000
    let ms = 0
    const perf = new WindowPerf(() => seconds, () => ms)
    perf.begin(7n).drop()
    expect(perf.take(6_060)).toEqual([])
    const waited = perf.begin(7n)
    perf.begin(7n).drop()
    ms += 500
    waited.end()
    seconds += MINUTE
    expect(perf.take(seconds)).toEqual([{ windowId: 7n, minute: 100, tokens: 0, busyMs: 500, demanded: true }])
  })
})

describe("the audit sample", () => {
  test("holds the body as sent, so it matches the record's hash", async () => {
    const booted = await bootStack()
    const kek = "11".repeat(32)
    const before = process.env.OFFPEAK_AUDIT_SAMPLE_KEK
    process.env.OFFPEAK_AUDIT_SAMPLE_KEK = kek
    await booted.stack.db.query("UPDATE serving.accounts SET audit_opt_in = true")
    spyOn(sample, "drawsSample").mockReturnValue(true)
    expect((await chat(booted, chatBody("sampled", { max_completion_tokens: 8 }))).status).toBe(200)
    if (before === undefined) delete process.env.OFFPEAK_AUDIT_SAMPLE_KEK
    else process.env.OFFPEAK_AUDIT_SAMPLE_KEK = before
    let rows: SampleRow[] = []
    for (let i = 0; i < 100 && rows.length === 0; i++) {
      rows = (await booted.stack.db.query<SampleRow>("SELECT * FROM serving.audit_samples")).rows
      await Bun.sleep(5)
    }
    const opened = await openSample(booted.stack.db, sample.parseKek(kek)!, rows[0]!)
    expect(promptHashOf(opened!.body)).toBe((await records(booted)).rows[0]!.prompt_hash)
  })
})

describe("the output limit", () => {
  test("a compact tool call that re-renders past the limit is clamped, with no metering flag against the host", async () => {
    const booted = await bootStack()
    const body = chatBody("use a tool", { tools: [{ type: "function", function: { name: "lookup" } }] })
    expect((await chat(booted, body)).status).toBe(200)
    expect((await records(booted)).rows[0]!.tokens_out).toBe(8)
    expect(await flags(booted)).toEqual([])
  })

  test("either name must be a safe whole number", async () => {
    const booted = await bootStack()
    for (const limits of [{ max_tokens: 1e308 }, { max_tokens: 1e308, max_completion_tokens: 8 }, { max_completion_tokens: 2 ** 60 }, { max_tokens: 1.5 }]) {
      const res = await chat(booted, chatBody("big", limits))
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("bad_max_tokens")
    }
  })

  test("a batch line is held to the same rule", async () => {
    const booted = await bootStack()
    const line = JSON.stringify({ custom_id: "a", body: { model: "ofm-8b", messages: [{ role: "user", content: "hi" }], max_tokens: 1e308 } })
    const { id } = (await (await booted.app.request("/v1/files", { method: "POST", headers: prepaid(booted), body: JSON.stringify({ purpose: "batch", content: line }) })).json()) as { id: string }
    const res = await booted.app.request("/v1/batches", { method: "POST", headers: prepaid(booted), body: JSON.stringify({ input_file_id: id, completion_window: "24h" }) })
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe("bad_file")
  })

  test("audit bookkeeping that throws does not touch a final record", async () => {
    const booted = await bootStack()
    holdWindow(booted)
    // Passes the door, and overflows the audit's rounding of it.
    const text = await (await chat(booted, chatBody("hot", { stream: true, temperature: 1e308 }), prepaid(booted, { "x-offpeak-window": WINDOW }))).text()
    expect(text).toContain("offpeak.usage")
    expect(text).not.toContain("unbilled")
    const row = (await records(booted)).rows[0]!
    expect(await pending(booted)).toBe(BigInt(row.tokens_in + row.tokens_out))
    expect(await flags(booted)).toEqual([])
  })
})

describe("contract vouchers", () => {
  const id = keccak256(toBytes("seven-seven-oh-two"))
  const owner = roleAccount("settlerA")

  test("a voucher only the wallet can vouch for counts against credit, even when requests prove with the key", async () => {
    const booted = await bootStack()
    const row = openChannel(booted, id, 2_000_000n)
    const approved = new Set<string>()
    booted.stack.wallets = { hasCode: async () => true, isValidSignature: async (_address, digest) => approved.has(digest) }
    const { db } = booted.stack
    expect((await channelChat(booted, id, chatBody("first"))).status).toBe(200)
    await db.query("INSERT INTO serving.owed_boundaries (channel_id, cumulative, req_ids) VALUES ($1,199995,'{0xa}')", [id])
    await db.query("UPDATE serving.channels_local SET unvouchered_micro = 199995 WHERE channel_id = $1", [id])
    const typed = { domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: 199_995n } } as const
    approved.add(hashTypedData(typed))
    const sig = await owner.signTypedData(typed)
    expect((await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: "199995", sig }) })).status).toBe(200)
    const refused = await channelChat(booted, id, chatBody("over"))
    expect(refused.status).toBe(402)
    expect(await errorCode(refused)).toBe("credit_limit")
    row.claimed = 199_995n
    expect((await channelChat(booted, id, chatBody("landed"))).status).toBe(200)
  })

  test("a key's own voucher does not", async () => {
    const booted = await bootStack()
    openChannel(booted, id, 2_000_000n)
    const { db } = booted.stack
    expect((await channelChat(booted, id, chatBody("first"))).status).toBe(200)
    await db.query("INSERT INTO serving.owed_boundaries (channel_id, cumulative, req_ids) VALUES ($1,199995,'{0xa}')", [id])
    await db.query("UPDATE serving.channels_local SET unvouchered_micro = 199995 WHERE channel_id = $1", [id])
    const sig = await buyerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: 199_995n } })
    expect((await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: "199995", sig }) })).status).toBe(200)
    expect((await channelChat(booted, id, chatBody("fine"))).status).toBe(200)
  })
})

describe("flex with a cap", () => {
  const flexChat = (booted: Booted, cap: string) => chat(booted, chatBody("cap me"), prepaid(booted, { "x-offpeak-max-price": cap, "x-offpeak-flex": new Date((booted.stack.clock() + 12 * 3600) * 1000).toISOString() }))

  async function capLocked() {
    const booted = await bootStack()
    booted.stack.load.util = () => 0.5
    const res = await flexChat(booted, "in=0.105,out=0.42")
    expect(res.status).toBe(202)
    const { id } = (await res.json()) as { id: string }
    const job = (await booted.stack.db.query<{ hour: string; last_hour: string; deadline: string; locked_price_in: string; cap_locked: boolean }>("SELECT l.hour, j.last_hour, j.deadline, j.locked_price_in, j.cap_locked FROM serving.jobs j JOIN serving.job_lines l ON l.job_id = j.id WHERE j.id = $1", [id])).rows[0]!
    expect(job.cap_locked).toBe(true)
    expect(BigInt(job.locked_price_in)).toBeLessThan(140_000n)
    booted.stack.setClock(Number(job.last_hour) * 3600 + 5)
    booted.stack.candidateCache.clear()
    return { booted, id, job }
  }

  test("does not run above its price in the last hour, and lapses unbilled", async () => {
    const { booted, id, job } = await capLocked()
    expect(await runBatch(booted.stack, id, { hour: Number(job.hour) })).toEqual({ ran: 0, moved: 0, left: 1 })
    expect(await runBatch(booted.stack, id)).toEqual({ ran: 0, moved: 0, left: 1 })
    booted.stack.setClock(Number(job.deadline))
    await dueNightSlots(booted.stack)
    const after = await booted.stack.db.query<{ status: string }>("SELECT status FROM serving.jobs WHERE id = $1", [id])
    expect(after.rows[0]!.status).toBe("expired")
    expect((await records(booted)).rows.length).toBe(0)
  })

  test("runs if the live price comes down to it", async () => {
    const { booted, id, job } = await capLocked()
    booted.stack.load.util = () => 0
    expect((await runBatch(booted.stack, id, { hour: Number(job.hour) })).ran).toBe(1)
    expect((await records(booted)).rows[0]!.price_in).toBe(job.locked_price_in)
  })

  test("a job whose average sits under the cap keeps the ordinary last-hour rule", async () => {
    const booted = await bootStack()
    booted.stack.load.util = () => 0.7
    const res = await flexChat(booted, "in=0.17,out=0.65")
    expect(res.status).toBe(202)
    const { id } = (await res.json()) as { id: string }
    const job = (await booted.stack.db.query<{ hour: string; last_hour: string; cap_locked: boolean }>("SELECT l.hour, j.last_hour, j.cap_locked FROM serving.jobs j JOIN serving.job_lines l ON l.job_id = j.id WHERE j.id = $1", [id])).rows[0]!
    expect(job.cap_locked).toBe(false)
    booted.stack.setClock(Number(job.last_hour) * 3600 + 5)
    booted.stack.candidateCache.clear()
    expect((await runBatch(booted.stack, id, { hour: Number(job.hour) })).ran).toBe(1)
    expect((await records(booted)).rows.length).toBe(1)
  })
})

describe("upto before confirmation", () => {
  test("one wallet can have 8 requests waiting for the chain, and a slot frees when it answers", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 150
    const streams = await Promise.all(Array.from({ length: 8 }, (_, i) => uptoChat(booted, `parallel-${i}`, chatBody(`p${i}`, { stream: true }))))
    expect(streams.map((res) => res.status)).toEqual(Array(8).fill(200))
    const settle = spyOn(booted.stack.facilitator, "settle")
    const ninth = await uptoChat(booted, "parallel-8", chatBody("p8", { stream: true }))
    expect(ninth.status).toBe(429)
    expect(await errorCode(ninth)).toBe("unconfirmed_limit")
    expect(settle).not.toHaveBeenCalled()
    settle.mockRestore()
    for (const text of await Promise.all(streams.map((res) => res.text()))) expect(text).toContain("offpeak.usage")
    const again = await uptoChat(booted, "parallel-9", chatBody("p9", { stream: true }))
    expect(again.status).toBe(200)
    await again.text()
  })

  test("a failed authorization frees its slot too", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 5
    for (let i = 0; i < 12; i++) {
      const seed = `failing-${i}`
      booted.facilitator.failReqIds.add(keccak256(toBytes(seed)))
      expect(await (await uptoChat(booted, seed, chatBody("x", { stream: true }))).text()).toContain("authorize_failed")
    }
  })

  test("the budget counts the input, so a dear prompt pauses at its first token", async () => {
    const booted = await bootStack()
    booted.stack.sheets[0]!.baseIn = booted.stack.sheets[0]!.baseIn.map(() => 20_000_000_000n)
    booted.stack.preconfirmTimeoutMs = 20
    booted.facilitator.delayMs = 2_000
    const text = await (await uptoChat(booted, "dear-prompt", chatBody("longform", { stream: true, max_tokens: 800 }))).text()
    expect(text).toContain("authorize_failed")
    expect(text.split('"content"').length - 1).toBe(1)
  })
})

describe("after Redis loses its data", () => {
  function fakeRedis() {
    const values = new Map<string, string>()
    return {
      values,
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => void values.set(key, String(value)),
      hset: async () => 1,
      expire: async () => 1,
      incrby: async (key: string, by: string) => {
        const next = Number(values.get(key) ?? 0) + Number(by)
        values.set(key, String(next))
        return next
      },
    }
  }

  test("Window draws are rebuilt from the records, so a holder cannot draw them twice", async () => {
    const booted = await bootStack()
    const redis = fakeRedis()
    booted.stack.counters = new RedisCounters(redis as never)
    holdWindow(booted)
    expect((await chat(booted, chatBody("draw"), prepaid(booted, { "x-offpeak-window": WINDOW }))).status).toBe(200)
    const before = await pending(booted)
    expect(before).toBeGreaterThan(0n)
    redis.values.clear()
    expect(await pending(booted)).toBe(0n)
    const hour = hourIndex(booted.stack.clock())
    await rebuildSpend(booted.stack.db, redis as never, hour - 48)
    expect(await pending(booted)).toBe(before)
    await rebuildSpend(booted.stack.db, redis as never, hour - 48)
    expect(await pending(booted)).toBe(before)
  })
})

describe("the cheap ends of the API", () => {
  const signedSheet = async (booted: Booted, signer: ReturnType<typeof roleAccount>) => {
    const sheet = sheetFromJson({
      host: signer.address.toLowerCase(),
      modelDigest: booted.modelDigest,
      baseIn: Array(168).fill("200000"),
      baseOut: Array(168).fill("800000"),
      floorIn: "100000",
      floorOut: "400000",
      validFrom: booted.stack.clock() + 7200,
      nonce: "2",
    } as never)
    return { sheet: sheetToJson(sheet), sig: await signer.signTypedData(sheetTypedData(sheet, booted.stack.registry) as never) }
  }

  test("a price sheet needs a host in the registry", async () => {
    const booted = await bootStack()
    const post = async (signer: ReturnType<typeof roleAccount>) => booted.app.request("/v1/hosts/price-sheet", { method: "POST", body: JSON.stringify(await signedSheet(booted, signer)) })
    const stranger = await post(roleAccount("settlerB"))
    expect(stranger.status).toBe(400)
    expect(((await stranger.json()) as { error: string }).error).toBe("host_not_registered")
    expect((await booted.stack.db.query("SELECT 1 FROM serving.price_sheets")).rows.length).toBe(0)
    booted.indexer.hosts.get(booted.host)!.status = 5
    expect((await post(roleAccount("host"))).status).toBe(400)
    booted.indexer.hosts.get(booted.host)!.status = 2
    expect((await post(roleAccount("host"))).status).toBe(200)
  })

  test("uploads stop at an account's quota, and expired files do not count", async () => {
    const booted = await bootStack()
    const upload = () => booted.app.request("/v1/files", { method: "POST", headers: prepaid(booted), body: JSON.stringify({ purpose: "batch", content: "hello" }) })
    const { accountId } = booted.key
    const fill = (expiresAt: number) => booted.stack.db.query("INSERT INTO serving.files (id, account_id, purpose, bytes, sha256, storage_key, expires_at) VALUES ('file_full',$1,'batch',$2,'','file_full',to_timestamp($3))", [accountId, 512 * 1024 * 1024, expiresAt])
    await fill(booted.stack.clock() + 3600)
    const full = await upload()
    expect(full.status).toBe(429)
    expect(await errorCode(full)).toBe("file_quota")
    await booted.stack.db.query("UPDATE serving.files SET expires_at = to_timestamp($1)", [booted.stack.clock() - 1])
    expect((await upload()).status).toBe(200)
    await booted.stack.db.query("INSERT INTO serving.files (id, account_id, purpose, bytes, sha256, storage_key, expires_at) SELECT 'f' || n, $1, 'batch', 1, '', 'f' || n, to_timestamp($2) FROM generate_series(1, 200) AS n", [accountId, booted.stack.clock() + 3600])
    expect((await upload()).status).toBe(429)
  })

  test("a buyer who cannot be served gets that answer before any line is tokenized", async () => {
    const booted = await bootStack()
    const line = JSON.stringify({ custom_id: "a", body: { model: "ofm-8b", messages: [{ role: "user", content: "x".repeat(10_000) }] } })
    const { id } = (await (await booted.app.request("/v1/files", { method: "POST", headers: prepaid(booted), body: JSON.stringify({ purpose: "batch", content: line }) })).json()) as { id: string }
    booted.indexer.buyers.get(booted.buyer)!.withdrawRequestedAt = 5n
    const res = await booted.app.request("/v1/batches", { method: "POST", headers: prepaid(booted), body: JSON.stringify({ input_file_id: id, completion_window: "24h" }) })
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe("withdraw_pending")
  })

  test("internal tokens compare whole, at any length", async () => {
    expect(sameSecret("token", "token")).toBe(true)
    expect(sameSecret("token", "tokem")).toBe(false)
    expect(sameSecret("to", "token")).toBe(false)
    expect(sameSecret(undefined, "token")).toBe(false)
    const booted = await bootStack()
    booted.stack.internalToken = "secret"
    const app = (await import("../src/app.ts")).createApp(booted.stack)
    const canary = (headers: Record<string, string>) => app.request("/internal/audit/canary", { method: "POST", headers, body: "{}" })
    expect((await canary({ "x-offpeak-internal": "wrong-length" })).status).toBe(403)
    expect((await canary({ "x-offpeak-internal": "secret" })).status).toBe(400)
    expect((await app.request("/internal/night-jobs/due", { headers: { authorization: "Bearer secret" } })).status).toBe(200)
    expect((await app.request("/internal/night-jobs/due", { headers: { authorization: "Bearer other" } })).status).toBe(403)
  })
})
