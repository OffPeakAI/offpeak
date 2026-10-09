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

  test("the openai client never resends a paid request", async () => {
    let sent = 0
    const booted = await bootRouter()
    const op = client(booted, {
      apiKey: booted.key.token,
      fetch: (async () => {
        sent += 1
        return new Response(JSON.stringify({ error: { message: "Service unavailable", type: "server_error", code: "unavailable" } }), { status: 503, headers: { "content-type": "application/json" } })
      }) as typeof fetch,
    })
    const failed = (await op.openai.chat.completions.create(ask("once")).catch((err) => err)) as { status: number }
    expect(failed.status).toBe(503)
    expect(sent).toBe(1)
  })

  test("bad options are stopped before anything is sent", async () => {
    const booted = await bootRouter()
    let sent = 0
    const op = client(booted, {
      apiKey: booted.key.token,
      fetch: (async () => {
        sent += 1
        return new Response(null, { status: 500 })
      }) as typeof fetch,
    })
    await expect(op.chat(ask("x"), { flex: "tomorrow" })).rejects.toThrow()
    await expect(op.chat(ask("x"), { windowId: "7; drop" })).rejects.toThrow()
    await expect(op.chat(ask("x"), { maxPrice: { inPerM: -1n, outPerM: 1n } })).rejects.toThrow()
    expect(sent).toBe(0)
  })

  test("a stream error from the router reaches the reader", async () => {
    const booted = await bootRouter()
    const send = inProcess(booted.app)
    const op = client(booted, {
      apiKey: booted.key.token,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        await send(input, init)
        return new Response(`event: error\ndata: ${JSON.stringify({ error: { message: "Authorization did not arrive", code: "authorize_failed" } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      }) as typeof fetch,
    })
    const stream = (await op.chat({ ...ask("x"), stream: true })) as ChatStream
    await expect(stream.final()).rejects.toMatchObject({ code: "authorize_failed" })
  })
})

describe("x402 upto", () => {
  /** `upto` starts at 0.05 USDG, so these requests can cost that much. */
  async function bootDear() {
    const booted = await bootRouter()
    booted.facilitator.delayMs = 20
    const sheet = booted.stack.sheets[0]!
    Object.assign(sheet, { baseIn: sheet.baseIn.map((price) => price * 100n), baseOut: sheet.baseOut.map((price) => price * 100n), floorIn: sheet.floorIn * 100n, floorOut: sheet.floorOut * 100n })
    return booted
  }

  test("a wallet with no key or channel pays by upto on the 402", async () => {
    const booted = await bootDear()
    const op = client(booted)
    const result = (await op.chat(ask("pay per call", 4000))) as ChatResult
    expect(result.envelope.record.payMode).toBe(1)
    expect((await op.verifyUsage(result.envelope, { payer: booted.buyer })).ok).toBe(true)
    expect(booted.facilitator.captured.at(-1)?.actual).toBe(costOf(result.envelope))
  })

  test("the upto path streams too", async () => {
    const booted = await bootDear()
    const op = client(booted)
    const stream = (await op.chat({ ...ask("streamed upto", 4000), stream: true })) as ChatStream
    const final = await stream.final()
    expect(final.envelope.record.payMode).toBe(1)
  })

  test("channels come first: a channel request never signs a payment", async () => {
    const booted = await bootRouter()
    const seen: Headers[] = []
    const send = inProcess(booted.app)
    const op = client(booted, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return send(input, init)
      }) as typeof fetch,
    })
    await op.channels.attach(addChannel(booted, 5_000_000n))
    await op.chat(ask("channel first"))
    expect(seen.some((headers) => headers.has("payment-signature"))).toBe(false)
  })

  test("with no way to pay, the error carries the router's offers", async () => {
    const booted = await bootDear()
    const op = new Offpeak({ baseURL: BASE, deployment: "local", fetch: inProcess(booted.app) })
    const err = (await op.chat(ask("free?", 4000)).catch((e) => e)) as OffpeakError
    expect(err.status).toBe(402)
    expect(err.code).toBe("payment_required")
    const accepts = err.detail?.accepts as { scheme: string }[]
    expect(accepts[0]?.scheme).toBe("channel")
    expect(accepts[1]?.scheme).toBe("upto")
  })

  test("a request under 0.05 USDG hears channel only, with no payment signed", async () => {
    const booted = await bootRouter()
    const err = (await client(booted).chat(ask("small")).catch((e) => e)) as OffpeakError
    expect(err.code).toBe("payment_required")
    expect((err.detail?.accepts as { scheme: string }[]).map((row) => row.scheme)).toEqual(["channel"])
  })

  test("payUpto signs the exact Permit2 witness for the payer", async () => {
    const booted = await bootRouter()
    const op = client(booted)
    const offer = requirement()
    const payment = await op.x402.payUpto(offer)
    const { payload } = payment.payload
    const witness = payload.witness as { reqId: Hex; payee: Hex; maxAmount: string; validBefore: string; resourceHash: Hex }
    expect(witness.reqId).toBe(offer.extra.reqId as Hex)
    expect(witness.payee).toBe(offer.payTo.toLowerCase() as Hex)
    expect(witness.maxAmount).toBe("50000")
    expect(payload.deadline).toBe(String(offer.extra.validBefore))
    const signer = await recoverTypedDataAddress({
      domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 },
      types: permitWitnessTypes("UptoWitness"),
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: payload.permitted.token, amount: BigInt(payload.permitted.amount) },
        spender: payload.spender,
        nonce: BigInt(payload.nonce),
        deadline: BigInt(payload.deadline),
        witness: { reqId: witness.reqId, payee: witness.payee, maxAmount: BigInt(witness.maxAmount), validBefore: BigInt(witness.validBefore), resourceHash: witness.resourceHash },
      },
      signature: payload.signature,
    } as never)
    expect(signer).toBe(buyerAccount.address)
    const verified = await booted.facilitator.verify({ paymentPayload: JSON.parse(payment.header), paymentRequirements: { payTo: offer.payTo, asset: offer.asset } })
    expect(verified).toMatchObject({ isValid: true, payer: booted.buyer })
  })

  test("two payments never share a nonce", async () => {
    const op = client(await bootRouter())
    const [a, b] = await Promise.all([op.x402.payUpto(requirement()), op.x402.payUpto(requirement())])
    expect(a.payload.payload.nonce).not.toBe(b.payload.payload.nonce)
  })

  const elsewhere = "0x000000000000000000000000000000000000dead"
  const bad: [string, Partial<UptoRequirement> & { extra?: Partial<UptoRequirement["extra"]> }][] = [
    ["another token", { asset: elsewhere }],
    ["another payee", { payTo: elsewhere }],
    ["another spender", { extra: { spender: elsewhere } }],
    ["another Permit2", { extra: { permit2: elsewhere } }],
    ["a validBefore far ahead", { extra: { validBefore: now() + 86_400 } }],
    ["a validBefore in the past", { extra: { validBefore: now() - 1 } }],
  ]
  for (const [name, overrides] of bad) {
    test(`refuses to sign ${name}`, async () => {
      const op = client(await bootRouter())
      await expect(op.x402.payUpto(requirement(overrides))).rejects.toMatchObject({ code: "bad_requirement" })
    })
  }

  test("refuses another network and a malformed offer", async () => {
    const op = client(await bootRouter())
    await expect(op.x402.payUpto({ ...requirement(), network: "eip155:1" })).rejects.toThrow()
    await expect(op.x402.payUpto({ scheme: "upto" })).rejects.toThrow()
  })

  test("the cap stops a large ask, and the caller can raise it", async () => {
    const booted = await bootRouter()
    const ask2m = requirement({ maxAmountRequired: "2000000" })
    await expect(client(booted).x402.payUpto(ask2m)).rejects.toMatchObject({ code: "above_upto_cap" })
    const raised = await client(booted, { uptoCapMicro: 5_000_000n }).x402.payUpto(ask2m)
    expect(raised.maxAmount).toBe(2_000_000n)
  })

  test("an explicit maxAmount cannot go under the requirement", async () => {
    const op = client(await bootRouter())
    await expect(op.x402.payUpto(requirement(), { maxAmount: 1n })).rejects.toMatchObject({ code: "bad_requirement" })
    expect((await op.x402.payUpto(requirement(), { maxAmount: 80_000n })).maxAmount).toBe(80_000n)
  })

  test("a bad 402 stops the request instead of signing", async () => {
    const booted = await bootDear()
    const send = inProcess(booted.app)
    const op = client(booted, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("payment-signature")) throw new Error("should not pay")
        const res = await send(input, init)
        const body = (await res.json()) as { accepts: { extra: Record<string, unknown> }[] }
        for (const row of body.accepts) if (row.extra.spender) row.extra.spender = "0x000000000000000000000000000000000000dead"
        return Response.json(body, { status: res.status })
      }) as typeof fetch,
    })
    await expect(op.chat(ask("phish", 4000))).rejects.toMatchObject({ code: "bad_requirement" })
  })
})

describe("op.proof", () => {
  const reader = (answer: boolean | Error) =>
    ({
      readContract: async (args: unknown) => {
        calls.push(args)
        if (answer instanceof Error) throw answer
        return answer
      },
    }) as unknown as PublicClient
  const calls: unknown[] = []

  async function settled() {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token, publicClient: reader(true) })
    const { envelope } = (await op.chat(ask("prove me"))) as ChatResult
    const other = keccak256(toBytes("other leaf"))
    const leaf = leafFor(envelope.record, envelope.routerSig, envelope.hostSig)
    const leaves = [leaf, other]
    const proofRow = { hour: 500_000, leaf, proof: merkleProof(leaves, 0), root: merkleRoot(leaves), txHash: `0x${"aa".repeat(32)}` }
    return { booted, op, envelope, leaf, proofRow }
  }

  test("a settled record verifies locally and on the ledger", async () => {
    const { booted, op, envelope, leaf, proofRow } = await settled()
    booted.indexer.proofs.set(envelope.record.reqId, proofRow)
    calls.length = 0
    const report = await op.proof(envelope.record.reqId)
    expect(report).toMatchObject({ ok: true, onchain: true, status: "verified", hour: 500_000 })
    expect(calls[0]).toMatchObject({ functionName: "verifyLeaf", address: addressOf("UsageLedger").toLowerCase(), args: [500_000n, leaf, proofRow.proof] })
  })

  test("before settlement the proof is pending", async () => {
    const { op, envelope } = await settled()
    expect(await op.proof(envelope.record.reqId)).toMatchObject({ ok: false, onchain: false, status: "pending" })
  })

  test("a proof that does not reach its root fails without asking the chain", async () => {
    const { booted, op, envelope, proofRow } = await settled()
    booted.indexer.proofs.set(envelope.record.reqId, { ...proofRow, root: keccak256(toBytes("wrong root")) })
    calls.length = 0
    expect(await op.proof(envelope.record.reqId)).toMatchObject({ ok: false, onchain: false, status: "mismatch" })
    expect(calls.length).toBe(0)
  })

  test("a proof for a leaf other than yours fails", async () => {
    const { booted, op, envelope, proofRow } = await settled()
    const leaves = [keccak256(toBytes("swap a")), keccak256(toBytes("swap b"))]
    booted.indexer.proofs.set(envelope.record.reqId, { ...proofRow, leaf: leaves[0]!, proof: merkleProof(leaves, 0), root: merkleRoot(leaves) })
    expect(await op.proof(envelope.record.reqId)).toMatchObject({ ok: false, status: "mismatch" })
  })

  test("a router that forges a leaf with a matching proof is caught by the leaf you hold", async () => {
    const { booted, proofRow } = await settled()
    const forged = [keccak256(toBytes("not your leaf")), keccak256(toBytes("forged neighbour"))]
    const send = inProcess(booted.app)
    const lying = client(booted, {
      apiKey: booted.key.token,
      publicClient: reader(true),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await send(input, init)
        if (!String(input).includes("/v1/usage/")) return res
        const body = (await res.json()) as { envelope: { leaf: string } }
        body.envelope.leaf = forged[0]!
        return Response.json(body)
      }) as typeof fetch,
    })
    const { envelope: mine } = (await lying.chat(ask("again"))) as ChatResult
    booted.indexer.proofs.set(mine.record.reqId, { ...proofRow, leaf: forged[0]!, proof: merkleProof(forged, 0), root: merkleRoot(forged) })
    expect(await lying.proof(mine.record.reqId)).toMatchObject({ ok: false, onchain: false, status: "mismatch" })
  })

  test("the ledger saying no is a failure, whatever the proof says", async () => {
    const { booted, envelope, proofRow } = await settled()
    booted.indexer.proofs.set(envelope.record.reqId, proofRow)
    const op = client(booted, { apiKey: booted.key.token, publicClient: reader(false) })
    expect(await op.proof(envelope.record.reqId)).toMatchObject({ ok: false, onchain: false, status: "mismatch" })
  })

  test("without an RPC the result says the chain was not asked", async () => {
    const { booted, envelope, proofRow } = await settled()
    booted.indexer.proofs.set(envelope.record.reqId, proofRow)
    const op = client(booted, { apiKey: booted.key.token })
    expect(await op.proof(envelope.record.reqId)).toMatchObject({ ok: true, onchain: false, status: "local_only" })
  })

  test("a failed RPC read is not reported as proven", async () => {
    const { booted, envelope, proofRow } = await settled()
    booted.indexer.proofs.set(envelope.record.reqId, proofRow)
    const op = client(booted, { apiKey: booted.key.token, publicClient: reader(new Error("rpc down")) })
    expect(await op.proof(envelope.record.reqId)).toMatchObject({ ok: true, onchain: false, status: "local_only" })
  })

  test("an unknown request is not found, and a bad id is refused", async () => {
    const { op } = await settled()
    expect(await op.proof(`0x${"12".repeat(32)}`)).toMatchObject({ ok: false, status: "not_found" })
    await expect(op.proof("nonsense")).rejects.toThrow()
  })
})

describe("usage log", () => {
  test("keeps what this client saw, newest first, filtered by time", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const first = (await op.chat(ask("one"))) as ChatResult
    const second = (await op.chat(ask("two"))) as ChatResult
    const ids = op.recentUsage().map((env) => env.record.reqId)
    expect(ids).toEqual([second.envelope.record.reqId, first.envelope.record.reqId])
    expect(op.recentUsage(booted.stack.clock() + 1)).toEqual([])
    expect(op.usageRecord(first.envelope.record.reqId.toUpperCase().replace("0X", "0x"))?.leaf).toBe(first.envelope.leaf)
  })
})
