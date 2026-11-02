import { describe, expect, test } from "bun:test"
import { PERMIT2, channelAuthHeader, channelPaymentId, domain, parseRecord, permitWitnessTypes, recordToMessage, signTyped, usageTypes, voucherTypes } from "@offpeak/shared"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"
import { uptoHeader } from "./support/upto.ts"
import { absorb, boundedText, emptyAssembly, hostEvents } from "../src/routing/dispatch.ts"

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
