import { describe, expect, spyOn, test } from "bun:test"
import { CHANNEL_CREDIT_CAP_MICRO, PERMIT2, canonicalJson, channelAuthHeader, channelPaymentId, domain, parseRecord, permitWitnessTypes, recordToMessage, signTyped, usageTypes, voucherTypes } from "@offpeak/shared"
import { keccak256, toBytes, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"
import { resignedOverbill } from "./support/overbill.ts"
import { uptoHeader } from "./support/upto.ts"
import { flagMetering } from "../src/openai/commit.ts"
import { sweepSessions } from "../src/auth/siwe.ts"
import { clientIp } from "../src/http.ts"
import * as tokenize from "../src/metering/tokenize.ts"
import { loadFactorBps } from "../src/pricing/live.ts"
import { LoadMeter } from "../src/pricing/load.ts"
import { reserveChannel } from "../src/pay/channel-store.ts"
import { absorb, boundedText, emptyAssembly, hostEvents } from "../src/routing/dispatch.ts"
import { selectHost, type HostCandidate } from "../src/routing/select.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const buyer = roleAccount("buyer")
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const chat = (booted: Booted, body = chatBody("hello")) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body })
const records = (booted: Booted) => booted.stack.db.query<{ req_id: string }>("SELECT req_id FROM shared.usage_records")
const flags = async (booted: Booted) => (await booted.stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")).rows.map((row) => row.reason)

/** Rewrites what the host answers on one path, and leaves the rest alone. */
function rewriteReply(booted: Booted, path: string, rewrite: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const inner = booted.stack.hosts.request
  booted.stack.hosts = {
    request: async (host, endpoint, target, init) => {
      const res = await inner(host, endpoint, target, init)
      if (target !== path || !res.ok) return res
      return Response.json(await rewrite((await res.json()) as Record<string, unknown>))
    },
  }
}

describe("the host's signature on a record", () => {
  test("a signature from another key leaves no record, and the hold goes back", async () => {
    const booted = await bootStack()
    rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostSig: await roleAccount("settlerB").signMessage({ message: "not a usage record" }) }))
    const res = await chat(booted)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unbilled")
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bad_host_sig"])
    expect(await booted.stack.ledger.committed(booted.buyer, 0n)).toBe(0n)
  })

  test("a signature that cannot be read is refused the same way", async () => {
    const booted = await bootStack()
    rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostSig: "0xjunk" }))
    expect((await chat(booted)).status).toBe(502)
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bad_host_sig"])
  })

  test("the host's own signature is stored", async () => {
    const booted = await bootStack()
    expect((await chat(booted)).status).toBe(200)
    expect((await records(booted)).rows.length).toBe(1)
    expect(await flags(booted)).toEqual([])
  })
})

const channelId = keccak256(toBytes("audit-channel"))

function openChannel(booted: Booted, id: Hex = channelId, deposit = 50_000_000n) {
  booted.indexer.channels.set(id, { payer: booted.buyer as Hex, deposit, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false })
}

/** Serves one channel request, which leaves a boundary a voucher can land on. */
async function owedOnChannel(booted: Booted, id: Hex = channelId) {
  const body = chatBody("one cheap call", { max_tokens: 4 })
  const auth = await channelAuthHeader(buyer, { channelId: id, ts: booted.stack.clock(), body })
  const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
  expect(res.status).toBe(200)
  return BigInt(res.headers.get("x-offpeak-channel-owed")!)
}

async function postVoucher(booted: Booted, seq: bigint, cumulative: bigint) {
  const sig = await buyer.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId, seq, cumulative } })
  return booted.app.request(`/v1/channels/${channelId}/voucher`, { method: "POST", body: JSON.stringify({ seq: seq.toString(), cumulative: cumulative.toString(), sig }) })
}

async function exactHeader(booted: Booted, reqId: Hex, amount: bigint) {
  const { stack } = booted
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const witness = { reqId, payee: stack.vault as Hex, amount, validBefore: deadline, resourceHash: keccak256(toBytes("resource")) }
  const message = { permitted: { token: stack.usdg as Hex, amount }, spender: stack.escrow as Hex, nonce: BigInt(`0x${reqId.slice(2, 10)}`), deadline, witness }
  const signature = await buyer.signTypedData({ domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 }, types: permitWitnessTypes("ExactWitness"), primaryType: "PermitWitnessTransferFrom", message } as never)
  return JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    payload: { signature, permitted: { token: stack.usdg, amount: amount.toString() }, spender: stack.escrow, nonce: message.nonce.toString(), deadline: deadline.toString(), witness: { ...witness, amount: amount.toString(), validBefore: deadline.toString() } },
  })
}

const streamed = (booted: Booted, payment: string) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "payment-signature": payment }, body: chatBody("write a long reply", { stream: true, max_tokens: 64 }) })
const embedded = (booted: Booted, payment: string) => booted.app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", "payment-signature": payment }, body: JSON.stringify({ model: "ofm-embed", input: "hello embeddings" }) })
const embedQuote = async (booted: Booted) => {
  const res = await booted.app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "ofm-embed", input: "hello embeddings" }) })
  const payment = (await res.json()) as { accepts: { scheme: string; maxAmountRequired?: string; maxAmount?: string }[] }
  const exact = payment.accepts.find((row) => row.scheme === "exact")!
  return BigInt(exact.maxAmountRequired ?? exact.maxAmount!)
}

describe("x402 payment ids", () => {
  async function paidVoucher(booted: Booted) {
    openChannel(booted)
    const owed = await owedOnChannel(booted)
    expect((await postVoucher(booted, 1n, owed)).status).toBe(200)
    return channelPaymentId(channelId, 1n)
  }

  test("an upto reqId equal to a voucher's payment id is refused before a host is asked", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const paymentId = await paidVoucher(booted)
    const before = (await records(booted)).rows.length
    const res = await streamed(booted, await uptoHeader(booted.stack, buyer, paymentId))
    expect(res.status).toBe(402)
    expect(await errorCode(res)).toBe("payment_id_taken")
    expect((await records(booted)).rows.length).toBe(before)
    expect(booted.facilitator.captured.length).toBe(0)
  })

  test("an exact reqId equal to a voucher's payment id takes no money", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    const paymentId = await paidVoucher(booted)
    const res = await embedded(booted, await exactHeader(booted, paymentId, await embedQuote(booted)))
    expect(res.status).toBe(402)
    expect(await errorCode(res)).toBe("payment_id_taken")
    expect((await booted.stack.db.query("SELECT 1 FROM serving.x402_requests")).rows.length).toBe(0)
  })

  test("a voucher cannot land on the id of a payment already being served", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    openChannel(booted)
    const owed = await owedOnChannel(booted)
    const res = await streamed(booted, await uptoHeader(booted.stack, buyer, channelPaymentId(channelId, 1n)))
    expect(res.status).toBe(200)
    const refused = await postVoucher(booted, 1n, owed)
    expect(refused.status).toBe(409)
    expect(await errorCode(refused)).toBe("payment_id_taken")
    expect(await res.text()).toContain("offpeak.usage")
    expect((await postVoucher(booted, 2n, owed)).status).toBe(200)
  })

  test("an unserved upto gives its id back", async () => {
    const booted = await bootStack({ failHost: true })
    booted.facilitator.delayMs = 1
    const reqId = keccak256(toBytes("never-served"))
    expect((await streamed(booted, await uptoHeader(booted.stack, buyer, reqId))).status).toBe(503)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.x402_requests")).rows.length).toBe(0)
  })

  test("a fresh reqId is billed and captured", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 1
    await paidVoucher(booted)
    const before = (await records(booted)).rows.length
    const res = await streamed(booted, await uptoHeader(booted.stack, buyer, keccak256(toBytes("a-fresh-req-id"))))
    expect(await res.text()).toContain("offpeak.usage")
    expect((await records(booted)).rows.length).toBe(before + 1)
  })
})

describe("reading a channel", () => {
  const read = (booted: Booted, headers: Record<string, string> = {}) => booted.app.request(`/v1/channels/${channelId}`, { headers })

  test("what is owed is not public", async () => {
    const booted = await bootStack()
    openChannel(booted)
    await owedOnChannel(booted)
    const res = await read(booted)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe("bad_channel_auth")
  })

  test("a stranger's proof and a proof signed over a body are refused, and neither can be replayed", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const stranger = await channelAuthHeader(roleAccount("settlerB"), { channelId, ts: booted.stack.clock(), body: "" })
    expect((await read(booted, { "x-offpeak-channel-auth": stranger })).status).toBe(401)
    const other = await channelAuthHeader(buyer, { channelId, ts: booted.stack.clock(), body: "{}" })
    expect((await read(booted, { "x-offpeak-channel-auth": other })).status).toBe(401)
    const once = await channelAuthHeader(buyer, { channelId, ts: booted.stack.clock(), body: "" })
    expect((await read(booted, { "x-offpeak-channel-auth": once })).status).toBe(200)
    expect((await read(booted, { "x-offpeak-channel-auth": once })).status).toBe(401)
  })

  test("the payer reads it", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const owed = await owedOnChannel(booted)
    const res = await read(booted, { "x-offpeak-channel-auth": await channelAuthHeader(buyer, { channelId, ts: booted.stack.clock(), body: "" }) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { owed: string }).owed).toBe(owed.toString())
  })

  test("an unknown channel is still not found", async () => {
    const booted = await bootStack()
    expect((await read(booted)).status).toBe(404)
  })
})

describe("host replies", () => {
  const toolChunk = (index: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: "a", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`

  /** A host that sends `reply` and signs whatever it is asked to. */
  function hostAnswers(booted: Booted, reply: string) {
    booted.stack.hosts = {
      request: async (_host, _endpoint, path, init) => {
        if (path === "/offpeak/v1/chat/completions") return new Response(reply, { status: 200, headers: { "content-type": "text/event-stream" } })
        const { record } = JSON.parse(String(init?.body))
        const hostSig = await signTyped(roleAccount("host") as never, { domain: domain("OffpeakUsage", booted.stack.usageLedger), types: usageTypes, primaryType: "UsageRecord", message: recordToMessage(parseRecord(record)) as never })
        return Response.json({ hostSig, hostCounts: {} })
      },
    }
  }

  const toolEvent = (index: unknown) => ({ choices: [{ delta: { tool_calls: [{ index: index as number, id: "from-host", type: "from-host" }] } }] })

  test("a large index does not grow the assembly", () => {
    const state = emptyAssembly()
    expect(() => absorb(state, toolEvent(1 << 25))).toThrow("bad tool call index")
    expect(() => absorb(state, toolEvent(1))).toThrow("bad tool call index")
    expect(state.toolCalls.length).toBe(0)
  })

  test("an index that is not a small integer never reaches the array", () => {
    for (const index of ["__proto__", "length", -1, 0.5, Number.NaN]) expect(() => absorb(emptyAssembly(), toolEvent(index))).toThrow("bad tool call index")
    expect(([] as unknown as { id?: string }).id).toBeUndefined()
  })

  test("tool calls stop at the limit", () => {
    const state = emptyAssembly()
    for (let index = 0; index < 128; index += 1) absorb(state, toolEvent(index))
    expect(state.toolCalls.length).toBe(128)
    expect(() => absorb(state, toolEvent(128))).toThrow("bad tool call index")
  })

  test("calls in order fold together", () => {
    const state = emptyAssembly()
    absorb(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{" } }] } }] })
    absorb(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] })
    absorb(state, { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "g", arguments: "{}" } }] } }] })
    expect(state.toolCalls.map((call) => call.function.arguments)).toEqual(["{}", "{}"])
  })

  test("a bad index on the first chunk ends the reply without hanging the hold", async () => {
    const booted = await bootStack()
    hostAnswers(booted, toolChunk(1 << 25))
    const started = performance.now()
    const res = await chat(booted)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: { finish_reason: string; message: { tool_calls?: unknown[] } }[] }
    expect(body.choices[0]!.finish_reason).toBe("length")
    expect(body.choices[0]!.message.tool_calls).toBeUndefined()
  })

  test("a normal tool call still bills", async () => {
    const booted = await bootStack()
    hostAnswers(booted, toolChunk(0))
    const res = await chat(booted)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason).toBe("tool_calls")
  })

  test("a stream past the byte limit stops, with no more read", async () => {
    let sent = 0
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1 << 20
        controller.enqueue(new Uint8Array(1 << 20).fill(32))
      },
    })
    const read = async () => {
      for await (const _ of hostEvents(new Response(huge))) continue
    }
    await expect(read()).rejects.toThrow("too large")
    expect(sent).toBeLessThanOrEqual(10 << 20)
  })

  test("a sign reply past its limit is not parsed", async () => {
    await expect(boundedText(new Response("x".repeat(1024)), 16)).rejects.toThrow("too large")
    expect(await boundedText(new Response("short"), 16)).toBe("short")
    const booted = await bootStack()
    const inner = booted.stack.hosts.request
    booted.stack.hosts = { request: async (host, endpoint, path, init) => (path === "/offpeak/v1/sign" ? new Response(JSON.stringify({ hostSig: "x".repeat(1 << 20) })) : inner(host, endpoint, path, init)) }
    expect((await chat(booted)).status).toBe(502)
    expect((await records(booted)).rows.length).toBe(0)
  })
})

describe("the load meter", () => {
  const setMaxTps = (booted: Booted, maxTps: number) => {
    for (const host of booted.indexer.hosts.values()) for (const model of host.models) model.maxTps = maxTps
  }
  const start = 1_762_000_000
  const large = chatBody("x ".repeat(4000), { max_tokens: 1 })

  test("a host twenty times over capacity reads above one, and priced at the top", () => {
    const meter = new LoadMeter()
    for (let t = start; t < start + 120; t++) {
      for (let r = 0; r < 100; r++) {
        meter.note("h", "m", "prefill", 40, t)
        meter.note("h", "m", "output", 200, t)
      }
    }
    const u = meter.util("h", "m", 1000, start + 119)
    expect(u).toBeGreaterThanOrEqual(1)
    expect(loadFactorBps(u)).toBe(12_000)
  })

  test("a host held at capacity reads one, however the tokens split across requests", () => {
    const meter = new LoadMeter()
    for (let t = start; t < start + 900; t++) for (let r = 0; r < 10; r++) meter.note("h", "m", "output", 100, t)
    expect(meter.util("h", "m", 1000, start + 899)).toBeCloseTo(1, 6)
  })

  test("half of capacity reads a half, and the reading fades once traffic stops", () => {
    const meter = new LoadMeter()
    for (let t = start; t < start + 900; t++) meter.note("h", "m", "output", 500, t)
    const end = start + 899
    expect(meter.util("h", "m", 1000, end)).toBeCloseTo(0.5, 6)
    expect(meter.util("h", "m", 1000, end + 60)).toBeLessThan(0.2)
    expect(meter.util("h", "m", 1000, end + 400)).toBe(0)
  })

  test("two requests in the same second both count", () => {
    const meter = new LoadMeter()
    meter.note("h", "m", "output", 600, start)
    meter.note("h", "m", "output", 600, start)
    const one = new LoadMeter()
    one.note("h", "m", "output", 1200, start)
    expect(meter.util("h", "m", 1000, start)).toBe(one.util("h", "m", 1000, start))
  })

  test("one large request leaves an idle host routed, for the next buyer and in the same second", async () => {
    const booted = await bootStack()
    setMaxTps(booted, 1000)
    expect((await chat(booted, large)).status).toBe(200)
    expect(booted.stack.load.util(booted.host, booted.modelDigest, 1000, booted.stack.clock())).toBeLessThan(0.05)
    booted.stack.candidateCache.clear()
    expect((await chat(booted)).status).toBe(200)
  })

  test("two large requests leave a two-host model in service", async () => {
    const booted = await bootStack({ secondHost: true })
    setMaxTps(booted, 1000)
    for (let i = 0; i < 2; i++) {
      expect((await chat(booted, large)).status).toBe(200)
      booted.stack.candidateCache.clear()
    }
    expect((await chat(booted)).status).toBe(200)
  })

  test("a run of large requests is real load, and stops the host being routed", () => {
    const meter = new LoadMeter()
    for (let t = start; t < start + 300; t++) meter.note("h", "m", "prefill", 8000, t)
    expect(meter.util("h", "m", 1000, start + 299)).toBeGreaterThanOrEqual(0.95)
  })

  const candidate = (meter: LoadMeter): HostCandidate => ({ host: "h", endpoint: "", priceIn: 1n, priceOut: 1n, sheetHash: "", bondUsdg: 1n, routingBonusBps: 0, strikes: 0, auditedSamples: 0, util: 0, healthy: true, ttftP95Ms: meter.ttftP95("h"), errorRate: 0, status: "Active", sealedOk: false, modelDigest: "m", maxTps: 1 })

  test("slow first tokens on long prompts do not take a host out", () => {
    const meter = new LoadMeter()
    for (let i = 0; i < 188; i++) meter.noteTtft("h", 200, 40)
    for (let i = 0; i < 12; i++) meter.noteTtft("h", 2000, 8000)
    expect(selectHost([candidate(meter)], { sealed: false, interactive: true })).toHaveLength(1)
  })

  test("slow first tokens on ordinary prompts still do", () => {
    const meter = new LoadMeter()
    for (let i = 0; i < 188; i++) meter.noteTtft("h", 200, 40)
    for (let i = 0; i < 12; i++) meter.noteTtft("h", 2000, 400)
    expect(selectHost([candidate(meter)], { sealed: false, interactive: true })).toHaveLength(0)
  })
})

describe("channel credit across a payer's channels", () => {
  const DEPOSIT = 2_500_000n
  const open = (booted: Booted, label: string) => {
    const id = keccak256(toBytes(label))
    openChannel(booted, id, DEPOSIT)
    return id
  }

  async function call(booted: Booted, id: Hex, i: number) {
    const body = chatBody(`longform ${i}`, { max_tokens: 800 })
    const auth = await channelAuthHeader(buyer, { channelId: id, ts: booted.stack.clock(), body })
    return booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
  }

  /** Serves until the channel refuses, signing no voucher at all. */
  async function drain(booted: Booted, id: Hex) {
    for (let i = 0; i < 40; i++) {
      const res = await call(booted, id, i)
      if (res.status !== 200) return errorCode(res)
    }
    return "never refused"
  }

  const owed = async (booted: Booted) => BigInt((await booted.stack.db.query<{ total: string }>("SELECT COALESCE(SUM(unvouchered_micro), 0) AS total FROM serving.channels_local")).rows[0]!.total)

  function dearer(booted: Booted) {
    const sheet = booted.stack.sheets[0]!
    sheet.baseIn = sheet.baseIn.map((value) => value * 100n)
    sheet.baseOut = sheet.baseOut.map((value) => value * 100n)
    sheet.floorIn *= 100n
    sheet.floorOut *= 100n
    for (const host of booted.indexer.hosts.values()) for (const model of host.models) model.maxTps = 1_000_000
  }

  test("three channels from one payer share one limit", async () => {
    const booted = await bootStack()
    dearer(booted)
    for (const label of ["a", "b", "c"]) expect(await drain(booted, open(booted, label))).toBe("credit_limit")
    expect(await owed(booted)).toBeLessThanOrEqual(CHANNEL_CREDIT_CAP_MICRO)
  })

  test("one channel still gets its whole limit", async () => {
    const booted = await bootStack()
    dearer(booted)
    expect(await drain(booted, open(booted, "one"))).toBe("credit_limit")
    expect(await owed(booted)).toBeGreaterThan(CHANNEL_CREDIT_CAP_MICRO / 2n)
  })

  test("a reservation held on one channel counts against the next", async () => {
    const booted = await bootStack()
    const [a, b] = [open(booted, "a"), open(booted, "b")]
    const row = (id: Hex) => booted.indexer.channels.get(id)!
    const held = await reserveChannel(booted.stack.db, row(a), a, 200_000n, booted.stack.clock())
    expect(held.ok).toBe(true)
    expect(await reserveChannel(booted.stack.db, row(b), b, 200_000n, booted.stack.clock())).toEqual({ ok: false, error: "credit_limit" })
    expect((await reserveChannel(booted.stack.db, row(b), b, 40_000n, booted.stack.clock())).ok).toBe(true)
  })

  test("reservations at once cannot both take the last of it", async () => {
    const booted = await bootStack()
    const ids = ["a", "b", "c", "d"].map((label) => open(booted, label))
    const rows = await Promise.all(ids.map((id) => reserveChannel(booted.stack.db, booted.indexer.channels.get(id)!, id, 100_000n, booted.stack.clock())))
    expect(rows.filter((row) => row.ok).length).toBe(2)
  })

  test("another payer has its own limit", async () => {
    const booted = await bootStack()
    const a = open(booted, "a")
    expect((await reserveChannel(booted.stack.db, booted.indexer.channels.get(a)!, a, 240_000n, booted.stack.clock())).ok).toBe(true)
    const other = keccak256(toBytes("other"))
    booted.indexer.channels.set(other, { ...booted.indexer.channels.get(a)!, payer: `0x${"ab".repeat(20)}` })
    expect((await reserveChannel(booted.stack.db, booted.indexer.channels.get(other)!, other, 240_000n, booted.stack.clock())).ok).toBe(true)
  })

  test("a voucher gives the room back", async () => {
    const booted = await bootStack()
    dearer(booted)
    const a = open(booted, "a")
    const body = chatBody("one call", { max_tokens: 100 })
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": a, "x-offpeak-channel-auth": await channelAuthHeader(buyer, { channelId: a, ts: booted.stack.clock(), body }) }, body })
    const cumulative = BigInt(res.headers.get("x-offpeak-channel-owed")!)
    expect(await owed(booted)).toBe(cumulative)
    const sig = await buyer.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: a, seq: 1n, cumulative } })
    expect((await booted.app.request(`/v1/channels/${a}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: cumulative.toString(), sig }) })).status).toBe(200)
    expect(await owed(booted)).toBe(0n)
  })
})

describe("routes anyone can reach", () => {
  const wallet = `0x${"ab".repeat(20)}`
  const post = (booted: Booted, path: string, body: unknown, headers: Record<string, string> = {}) => booted.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  const sessions = async (booted: Booted) => (await booted.stack.db.query("SELECT 1 FROM serving.siwe_sessions")).rows.length

  test("a nonce needs a real wallet, and no row is written for anything else", async () => {
    const booted = await bootStack()
    expect((await post(booted, "/v1/auth/nonce", { wallet: "0x1" })).status).toBe(400)
    expect((await post(booted, "/v1/auth/nonce", { wallet: "x".repeat(1024 * 1024) })).status).toBe(413)
    expect((await booted.app.request("/v1/auth/nonce", { method: "POST", body: "not json" })).status).toBe(400)
    expect(await sessions(booted)).toBe(0)
    expect((await post(booted, "/v1/auth/nonce", { wallet })).status).toBe(200)
    expect(await sessions(booted)).toBe(1)
  })

  test("nonces stop at the limit for one address, not for the next, and come back the next minute", async () => {
    const booted = await bootStack()
    booted.stack.proxyHops = 1
    const from = (ip: string) => post(booted, "/v1/auth/nonce", { wallet }, { "x-forwarded-for": `1.1.1.1, ${ip}` })
    for (let i = 0; i < 30; i++) expect((await from("9.9.9.9")).status).toBe(200)
    const refused = await from("9.9.9.9")
    expect(refused.status).toBe(429)
    expect(await errorCode(refused)).toBe("ip_limit")
    expect(await sessions(booted)).toBe(30)
    expect((await from("8.8.8.8")).status).toBe(200)
    booted.stack.setClock(booted.stack.clock() + 60)
    expect((await from("9.9.9.9")).status).toBe(200)
  })

  test("a login that cannot be read is refused without a throw", async () => {
    const booted = await bootStack()
    expect((await post(booted, "/v1/auth/login", { message: 1 })).status).toBe(401)
    expect((await post(booted, "/v1/auth/login", { message: "m".repeat(5000), signature: "0x12" })).status).toBe(401)
  })

  test("nonces nobody spent are swept, and live rows stay", async () => {
    const booted = await bootStack()
    await post(booted, "/v1/auth/nonce", { wallet })
    await booted.stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ('sess_live', $1, '', to_timestamp($2))", [wallet, booted.stack.clock() + 86_400])
    await sweepSessions(booted.stack)
    expect(await sessions(booted)).toBe(2)
    booted.stack.setClock(booted.stack.clock() + 601)
    await sweepSessions(booted.stack)
    expect((await booted.stack.db.query<{ id: string }>("SELECT id FROM serving.siwe_sessions")).rows).toEqual([{ id: "sess_live" }])
  })

  async function registration(booted: Booted, endpoint = "https://host.example/") {
    const account = privateKeyToAccount(generatePrivateKey())
    const operator = account.address.toLowerCase() as Hex
    return { operator, endpoint, sig: await account.signMessage({ message: canonicalJson({ endpoint, operator }) }), models: [{ digest: booted.modelDigest, maxTps: 1 }], imageDigest: booted.imageDigest, gpuClass: booted.imageDigest }
  }
  const hostRows = async (booted: Booted) => (await booted.stack.db.query("SELECT 1 FROM serving.hosts_cache")).rows.length

  test("registration bounds every field it stores", async () => {
    const booted = await bootStack()
    expect((await post(booted, "/v1/hosts/register", await registration(booted, `https://${"a".repeat(1024 * 1024)}.example/`))).status).toBe(413)
    expect((await post(booted, "/v1/hosts/register", await registration(booted, `https://${"a".repeat(600)}.example/`))).status).toBe(400)
    expect((await post(booted, "/v1/hosts/register", { operator: "0x1" })).status).toBe(400)
    expect(await hostRows(booted)).toBe(0)
    expect((await post(booted, "/v1/hosts/register", await registration(booted))).status).toBe(200)
    expect(await hostRows(booted)).toBe(1)
  })

  test("fresh keys stop at the limit for one address", async () => {
    const booted = await bootStack()
    for (let i = 0; i < 10; i++) expect((await post(booted, "/v1/hosts/register", await registration(booted))).status).toBe(200)
    expect((await post(booted, "/v1/hosts/register", await registration(booted))).status).toBe(429)
    expect(await hostRows(booted)).toBe(10)
  })

  test("the address is the socket's unless a proxy is trusted, and then only what that proxy wrote", () => {
    const req = new Request("http://router.test", { headers: { "x-forwarded-for": "6.6.6.6, 2.2.2.2" } })
    const server = { requestIP: () => ({ address: "3.3.3.3" }) }
    expect(clientIp(req, server, 0)).toBe("3.3.3.3")
    expect(clientIp(req, server, 1)).toBe("2.2.2.2")
    expect(clientIp(req, server, 2)).toBe("6.6.6.6")
    expect(clientIp(new Request("http://router.test"), undefined, 0)).toBe("unknown")
  })
})

describe("counting tokens", () => {
  const big = "lorem ipsum dolor ".repeat(Math.floor((3.9 * 1024 * 1024) / 18))
  const embedBody = (input: string) => JSON.stringify({ model: "ofm-embed", input })
  const chatLong = (input: string) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: input }] })
  const send = (booted: Booted, path: string, body: string, headers: Record<string, string> = {}) => booted.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })

  function counts() {
    const inputs = spyOn(tokenize, "countInputs")
    const chats = spyOn(tokenize, "countChat")
    inputs.mockClear()
    chats.mockClear()
    return {
      total: () => inputs.mock.calls.length + chats.mock.calls.length,
      restore: () => {
        inputs.mockRestore()
        chats.mockRestore()
      },
    }
  }

  test("a key that does not exist is turned away first", async () => {
    const booted = await bootStack()
    const seen = counts()
    try {
      const res = await send(booted, "/v1/embeddings", embedBody("hello"), { authorization: "Bearer op_live_nobody" })
      expect(res.status).toBe(401)
      expect(seen.total()).toBe(0)
    } finally {
      seen.restore()
    }
  })

  test("a channel header with no proof is turned away first, on both routes", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const seen = counts()
    try {
      const bare = { "x-offpeak-channel": channelId }
      expect((await send(booted, "/v1/embeddings", embedBody("hello"), bare)).status).toBe(401)
      expect((await send(booted, "/v1/chat/completions", chatLong(big), bare)).status).toBe(401)
      expect((await send(booted, "/v1/chat/completions", chatLong(big), { "x-offpeak-channel": `0x${"cd".repeat(32)}` })).status).toBe(402)
      expect(seen.total()).toBe(0)
    } finally {
      seen.restore()
    }
  })

  test("a channel's proof is spent once, and a proved request still bills", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const body = chatBody("hello")
    const auth = await channelAuthHeader(buyer, { channelId, ts: booted.stack.clock(), body })
    const headers = { "x-offpeak-channel": channelId, "x-offpeak-channel-auth": auth }
    expect((await send(booted, "/v1/chat/completions", body, headers)).status).toBe(200)
    expect((await send(booted, "/v1/chat/completions", body, headers)).status).toBe(401)
  })

  test("long unpaid bodies draw on their address, and stop before the tokenizer", async () => {
    const booted = await bootStack()
    const seen = counts()
    try {
      expect((await send(booted, "/v1/embeddings", embedBody(big))).status).toBe(402)
      expect((await send(booted, "/v1/embeddings", embedBody(big))).status).toBe(402)
      const before = seen.total()
      expect(before).toBe(2)
      const res = await send(booted, "/v1/embeddings", embedBody(big))
      expect(res.status).toBe(429)
      expect(await errorCode(res)).toBe("ip_limit")
      expect((await send(booted, "/v1/chat/completions", chatLong(big))).status).toBe(429)
      expect(seen.total()).toBe(before)
    } finally {
      seen.restore()
    }
  })

  test("a junk x402 header draws on the same budget", async () => {
    const booted = await bootStack()
    const junk = { "payment-signature": JSON.stringify({ scheme: "upto", payload: {} }) }
    for (let i = 0; i < 2; i++) await send(booted, "/v1/chat/completions", chatLong(big), junk)
    const res = await send(booted, "/v1/chat/completions", chatLong(big), junk)
    expect(res.status).toBe(429)
  })

  test("small quotes and keyed requests are not held up", async () => {
    const booted = await bootStack()
    for (let i = 0; i < 40; i++) expect((await send(booted, "/v1/embeddings", embedBody("hello"))).status).toBe(402)
    expect((await send(booted, "/v1/embeddings", embedBody("hello"), { authorization: `Bearer ${booted.key.token}` })).status).toBe(200)
  })
})

describe("metering flags", () => {
  const reqId = `0x${"12".repeat(32)}`
  const flagRows = (booted: Booted) => booted.stack.db.query<{ req_id: string; reason: string; router_counts: unknown; host_counts: unknown }>("SELECT req_id, reason, router_counts, host_counts FROM serving.metering_flags")

  const hostSays = (booted: Booted, counts: (mine: { tokensIn: number; tokensOut: number }) => object) => rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostCounts: counts(body.hostCounts as { tokensIn: number; tokensOut: number }) }))

  test("a signed record whose counts the host does not share is flagged, with the record kept", async () => {
    const booted = await bootStack()
    hostSays(booted, (mine) => ({ ...mine, tokensOut: mine.tokensOut + 50 }))
    expect((await chat(booted)).status).toBe(200)
    const [row] = (await flagRows(booted)).rows
    expect(row!.reason).toBe("counts")
    expect((await records(booted)).rows.map((record) => record.req_id)).toEqual([row!.req_id])
  })

  test("counts inside the tolerance, or none at all, are not a difference", async () => {
    const booted = await bootStack()
    hostSays(booted, (mine) => ({ ...mine, tokensOut: mine.tokensOut + 2 }))
    expect((await chat(booted)).status).toBe(200)
    expect(await flags(booted)).toEqual([])
    const quiet = await bootStack()
    hostSays(quiet, () => ({}))
    expect((await chat(quiet)).status).toBe(200)
    expect(await flags(quiet)).toEqual([])
  })

  test("a flag against the host takes over a flag from the router's own side", async () => {
    const booted = await bootStack()
    await flagMetering(booted.stack, reqId, booted.host, {}, {}, "over_hold")
    await flagMetering(booted.stack, reqId, booted.host, { tokensOut: 9 }, { tokensOut: 90 }, "counts")
    expect((await flagRows(booted)).rows).toEqual([{ req_id: reqId, reason: "counts", router_counts: { tokensOut: 9 }, host_counts: { tokensOut: 90 } }])
  })

  test("a flag against the host stays, whatever comes after it", async () => {
    const booted = await bootStack()
    await flagMetering(booted.stack, reqId, booted.host, {}, {}, "counts")
    await flagMetering(booted.stack, reqId, booted.host, {}, {}, "bill_failed")
    await flagMetering(booted.stack, reqId, booted.host, {}, {}, "dispute_upheld")
    expect(await flags(booted)).toEqual(["counts"])
  })

  test("a dispute upheld on a record the router flagged for itself reaches the auditor", async () => {
    const booted = await bootStack()
    const body = chatBody("count my tokens")
    const res = await chat(booted, body)
    const json = (await res.json()) as { choices: { message: { content: string } }[]; offpeak_usage: { record: { reqId: string; tokensOut: number } } }
    const { reqId: id, tokensOut } = json.offpeak_usage.record
    await flagMetering(booted.stack, id, booted.host, {}, {}, "over_hold")
    await resignedOverbill(booted, id, tokensOut + 500)
    await booted.stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ('sess_test', $1, '', to_timestamp($2))", [booted.buyer, booted.stack.clock() + 86_400])
    const disputed = await booted.app.request("/v1/disputes", { method: "POST", headers: { authorization: "Bearer sess_test" }, body: JSON.stringify({ req_ids: [id], reason: "too many", material: { prompt: JSON.parse(body), output: json.choices[0]!.message.content } }) })
    expect(((await disputed.json()) as { outcome: string }).outcome).toBe("upheld")
    expect(await flags(booted)).toEqual(["dispute_upheld"])
  })
})
