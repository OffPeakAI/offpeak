import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { domain, parseRecord, recordToMessage, signTyped, usageTypes, type Hex, type UsageRecordJson } from "@offpeak/shared"
import { hexToBytes, keccak256, toBytes } from "viem"
import { countsMessage, sealedCountsSchema, type SealedCounts } from "../../../packages/sdk/src/sealed/attest.ts"
import { SEALED_PATH, concatBytes, frameHeader, inputTokenCeiling, publicKeyFrom, sealRequest } from "../../../packages/sdk/src/sealed/hpke.ts"
import { FrameSplitter, decodeTrailer, FLAG_TRAILER } from "../../../packages/sdk/src/sealed/stream.ts"
import { Offpeak } from "../../../packages/sdk/src/index.ts"
import { anvilAccount, roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { HoldLedger } from "../src/pay/prepaid.ts"
import { verifiedHost } from "../src/routing/attest.ts"
import { MODEL, TRUST_ROUTER, sealedRig, type RigOptions } from "./support/sealed-rig.ts"
import { uptoHeader } from "./support/upto.ts"

const BASE = "http://router.test"
const USDG = 1_000_000n

let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

type Rig = Awaited<ReturnType<typeof sealedRig>>

async function rig(opts?: RigOptions) {
  const booted = await sealedRig(opts)
  stops.push(booted.stop)
  const send = ((input: RequestInfo | URL, init?: RequestInit) => booted.app.fetch(new Request(input, init))) as typeof fetch
  const op = new Offpeak({ baseURL: BASE, apiKey: booted.key.token, deployment: "local", router: booted.stack.router.address, fetch: send, sealed: TRUST_ROUTER })
  return { ...booted, op, send }
}

const body = (content: string, over: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: "user", content }], stream: true, max_tokens: 32, ...over })

async function sealedBytes(booted: Rig, plain: unknown = body("billed")) {
  const key = await publicKeyFrom(hexToBytes(booted.sealed.identity.publicKey))
  return sealRequest(key, new TextEncoder().encode(JSON.stringify(plain)), SEALED_PATH, Date.now())
}

type Over = { maxTokens?: string | null; model?: string | null; host?: string | null; headers?: Record<string, string> }

function post(booted: Rig, bytes: Uint8Array, over: Over = {}) {
  const clear: Record<string, string | null> = {
    "x-offpeak-model": over.model === undefined ? MODEL : over.model,
    "x-offpeak-max-tokens": over.maxTokens === undefined ? "32" : over.maxTokens,
    "x-offpeak-sealed-host": over.host === undefined ? booted.host : over.host,
  }
  const headers = Object.fromEntries(Object.entries(clear).filter((row): row is [string, string] => row[1] !== null))
  return booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/offpeak-hpke", ...headers, ...over.headers },
    body: new Uint8Array(bytes),
  })
}

const closingOf = (raw: Uint8Array) => {
  const frame = new FrameSplitter().push(raw).find((row) => row.flag === FLAG_TRAILER)
  return frame ? decodeTrailer(frame.body) : null
}

const errorOf = async (res: Response) => ((await res.json()) as { error: Record<string, any> }).error

const records = async (booted: Rig) => (await booted.stack.db.query<{ host_cost_micro: string; fee_micro: string; pay_mode: number; tokens_in: number; tokens_out: number; req_id: string }>("SELECT * FROM shared.usage_records")).rows

/** One row per reason, for a request can hold several in its one flag row. */
const flags = async (booted: Rig) => (await booted.stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")).rows.flatMap((row) => row.reason.split(",").map((reason) => ({ reason })))

const committed = (booted: Rig) => booted.stack.ledger.committed(booted.buyer, 0n)

/**
 * Stands in for the VM on every route, as a proxy in front of it can. The engine is never called, and
 * the operator's key, which lives outside the VM, signs the record. `signer` signs the counts.
 */
function proxyInPlace(booted: Rig, signer: { signMessage: (args: { message: string }) => Promise<Hex> }, tokensIn: number, promptHash: Hex) {
  const operator = roleAccount("host")
  const reply = concatBytes(new Uint8Array(16), frameHeader(0x01, 16), new Uint8Array(16))
  const outputHash = keccak256(reply)
  let reqId: Hex = "0x"
  booted.stack.hosts = {
    request: async (_host, _endpoint, path, init) => {
      if (path.includes("/sealed/chat/")) {
        reqId = (JSON.parse(Buffer.from(new Headers(init.headers).get("x-offpeak-req")!, "base64url").toString()) as { reqId: Hex }).reqId
        return new Response(reply, { headers: { "content-type": "application/offpeak-hpke-stream" } })
      }
      if (path.includes("/sealed/counts/")) {
        const counts = { reqId, tokensIn, tokensOut: 8, promptHash, outputHash }
        return Response.json({ ...counts, sig: await signer.signMessage({ message: countsMessage(counts) }) })
      }
      const record = parseRecord((JSON.parse(String(init.body)) as { record: UsageRecordJson }).record)
      const hostSig = await signTyped(operator, { domain: domain("OffpeakUsage", booted.stack.usageLedger), types: usageTypes, primaryType: "UsageRecord", message: recordToMessage(record) as never })
      return Response.json({ hostSig, hostCounts: { tokensIn: record.tokensIn, tokensOut: record.tokensOut } })
    },
  }
}

/** Has the router believe a key of this test's is the VM's, for a VM that signs what it likes. No honest build does. */
function attestKey(booted: Rig) {
  const vm = anvilAccount(13)
  verifiedHost(booted.stack, booted.host)!.transcript.bindings.countsSigner = vm.address.toLowerCase() as Hex
  return vm
}

/** Sealed bills through the same ledger, so the hold it took can be read off it before anything settles. */
const holdsOf = (booted: Rig) => (booted.stack.ledger as HoldLedger)

describe("prepaid", () => {
  test("the hold covers the clear limits, and capture takes exactly what the record bills", async () => {
    const booted = await rig()
    const admit = spyOn(holdsOf(booted), "admit")
    const result = await booted.op.sealed.chat(body("billed", { stream: false }))
    const held = admit.mock.calls[0]![1] as bigint
    const cost = result.envelope.record.hostCostMicro + result.envelope.record.feeMicro
    expect(held).toBeGreaterThan(cost)
    expect(await committed(booted)).toBe(cost)
    expect((await records(booted))[0]).toMatchObject({ pay_mode: 0, host_cost_micro: Number(result.envelope.record.hostCostMicro) })
  })

  test("the record uses the host's counts, which the VM made on the plaintext", async () => {
    const booted = await rig()
    const result = await booted.op.sealed.chat(body("count on me", { stream: false }))
    expect(result.envelope.hostCounts).toEqual({ tokensIn: result.envelope.record.tokensIn, tokensOut: result.envelope.record.tokensOut })
    expect(result.envelope.record.tokensOut).toBeGreaterThan(0)
  })

  test("a hold over the hourly cap is refused before any byte reaches a host", async () => {
    const booted = await rig()
    const buyer = booted.indexer.buyers.get(booted.buyer)!
    buyer.hourlyCap = 1n
    const sealed = await sealedBytes(booted)
    const res = await post(booted, sealed.bytes)
    expect(res.status).toBe(402)
    expect((await errorOf(res)).code).toBe("insufficient_reserve")
    expect(booted.engine.requests.length).toBe(0)
  })

  test("the buyer cannot slip under the cap with a small clear limit and a big sealed one", async () => {
    const booted = await rig({ reply: () => ({ text: "x".repeat(4000), finish: "length" }) })
    const sealed = await sealedBytes(booted, body("greedy", { max_tokens: 4096 }))
    const res = await post(booted, sealed.bytes, { maxTokens: "4" })
    closingOf(new Uint8Array(await res.arrayBuffer()))
    expect(booted.engine.requests[0]!.body.max_tokens).toBe(4)
  })

  test("a withdraw-all stops sealed admission", async () => {
    const booted = await rig()
    booted.indexer.buyers.get(booted.buyer)!.withdrawRequestedAt = 1n
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe("withdraw_pending")
  })

  test("no key is no service", async () => {
    const booted = await rig()
    const res = await booted.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/offpeak-hpke", "x-offpeak-model": MODEL, "x-offpeak-max-tokens": "8", "x-offpeak-sealed-host": booted.host },
      body: (await sealedBytes(booted)).bytes,
    })
    expect(res.status).toBe(402)
    expect(booted.engine.requests.length).toBe(0)
  })

  test("a price above the buyer's cap gets the ordinary 429", async () => {
    const booted = await rig()
    const res = await post(booted, (await sealedBytes(booted)).bytes, { headers: { "x-offpeak-max-price": "in=0.000001,out=0.000001" } })
    expect(res.status).toBe(429)
    expect((await errorOf(res)).code).toBe("price_above_cap")
    expect(await committed(booted)).toBe(0n)
  })

  test("a replayed request is refused by the VM and its hold comes back", async () => {
    const booted = await rig()
    const sealed = await sealedBytes(booted)
    await (await post(booted, sealed.bytes)).arrayBuffer()
    const spent = await committed(booted)
    const res = await post(booted, sealed.bytes)
    expect(res.status).toBe(409)
    expect((await errorOf(res)).code).toBe("sealed_replayed_enc")
    expect(await committed(booted)).toBe(spent)
    expect((await records(booted)).length).toBe(1)
  })

  test("a host that refuses a request is not marked unhealthy for it", async () => {
    const booted = await rig()
    const sealed = await sealedBytes(booted)
    const garbled = sealed.bytes.slice()
    garbled[60]! ^= 1
    await post(booted, garbled)
    expect(booted.stack.load.errorRate(booted.host)).toBe(0)
  })

  test("a host that fails frees the hold and counts against it", async () => {
    const booted = await rig({ failWith: 500 })
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(res.status).toBe(503)
    expect(await committed(booted)).toBe(0n)
    expect(booted.stack.load.errorRate(booted.host)).toBeGreaterThan(0)
  })

  test("a stream longer than the agent's clock skew still bills", async () => {
    const booted = await rig()
    const hosts = booted.stack.hosts
    booted.stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        if (path.includes("/sealed/chat/")) booted.stack.setClock(booted.stack.clock() + 300)
        return res
      },
    }
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.usage).toBeDefined()
    expect((await records(booted)).length).toBe(1)
  })

  test("a client that hangs up pays for what the VM counted", async () => {
    let finish = () => {}
    const hold = new Promise<void>((resolve) => (finish = resolve))
    const booted = await rig({ hold, reply: () => ({ text: "a longer reply that the client walks away from" }) })
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    finish()
    const end = performance.now() + 3_000
    while ((await records(booted)).length === 0 && performance.now() < end) await Bun.sleep(10)
    expect((await records(booted)).length).toBe(1)
  })
})

describe("clear headers", () => {
  test.each([
    ["no model", { model: null }],
    ["no max tokens", { maxTokens: null }],
    ["no host", { host: null }],
    ["zero max tokens", { maxTokens: "0" }],
    ["too many max tokens", { maxTokens: "4097" }],
    ["text max tokens", { maxTokens: "lots" }],
    ["a bad host", { host: "0x12" }],
  ])("%s is a 400", async (_name, over) => {
    const booted = await rig()
    const res = await post(booted, (await sealedBytes(booted)).bytes, over as Over)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe("bad_sealed_headers")
  })

  test("a model nobody serves is a 404", async () => {
    const booted = await rig()
    expect((await post(booted, (await sealedBytes(booted)).bytes, { model: "no-such-model" })).status).toBe(404)
  })

  test("a body too short to be sealed is a 400", async () => {
    const booted = await rig()
    expect((await errorOf(await post(booted, new Uint8Array(10)))).code).toBe("bad_sealed_body")
  })

  test("a night job cannot be sealed", async () => {
    const booted = await rig()
    const res = await post(booted, (await sealedBytes(booted)).bytes, { headers: { "x-offpeak-flex": "2030-01-01T00:00:00Z" } })
    expect((await errorOf(res)).code).toBe("sealed_no_flex")
    await expect(booted.op.chat(body("night", { stream: false }), { sealed: true, flex: "2030-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "sealed_no_flex" })
  })
})

describe("routing on the clear headers", () => {
  test("a host that is not verified takes no sealed traffic, and no hold is left", async () => {
    const booted = await rig()
    booted.stack.attest!.hosts.clear()
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(res.status).toBe(503)
    expect((await errorOf(res)).code).toBe("sealed_host_unavailable")
    expect(booted.engine.requests.length).toBe(0)
    expect(await committed(booted)).toBe(0n)
  })

  test("a registry ref alone does not make a host verified", async () => {
    const booted = await rig()
    expect(booted.hostRow.attestationRef).not.toBe(`0x${"00".repeat(32)}`)
    booted.stack.attest!.hosts.clear()
    expect(verifiedHost(booted.stack, booted.host)).toBeNull()
    await expect(booted.op.sealed.chat(body("x", { stream: false }))).rejects.toMatchObject({ code: "sealed_no_host" })
  })

  test("a host verified for another model is refused", async () => {
    const booted = await rig()
    verifiedHost(booted.stack, booted.host)!.transcript.bindings.modelDigest = `0x${"77".repeat(32)}`
    expect((await post(booted, (await sealedBytes(booted)).bytes)).status).toBe(503)
  })

  test("a named host that is frozen or unhealthy is refused, with no failover to another host's key", async () => {
    const booted = await rig()
    booted.stack.probesOk.delete(booted.host)
    expect((await post(booted, (await sealedBytes(booted)).bytes)).status).toBe(503)
  })

  test("the switch being off answers before anything is read or charged", async () => {
    const booted = await rig()
    booted.stack.flags.sealed = false
    expect((await post(booted, (await sealedBytes(booted)).bytes)).status).toBe(501)
    expect(await committed(booted)).toBe(0n)
  })
})

describe("the ciphertext-length check", () => {
  test("a record outside the model's range is flagged and still billed", async () => {
    const booted = await rig()
    booted.stack.models[0]!.sealedBytesPerToken = { low: 100_000, high: 200_000 }
    const result = await booted.op.sealed.chat(body("outlier", { stream: false }))
    expect((await flags(booted)).map((row) => row.reason)).toEqual(["sealed_length_outlier"])
    expect(result.envelope.sealed).toBe(true)
    expect((await records(booted)).length).toBe(1)
  })

  test("the default range leaves an ordinary reply alone", async () => {
    const booted = await rig()
    await booted.op.sealed.chat(body("normal", { stream: false }))
    expect(await flags(booted)).toEqual([])
  })

  test.each([
    ["one word", "ok"],
    ["a long reply", "word ".repeat(400)],
  ])("padded frames stay inside the default range: %s", async (_name, text) => {
    const booted = await rig({ reply: () => ({ text }) })
    await booted.op.sealed.chat(body("padded", { stream: false, max_tokens: 4096 }))
    expect(await flags(booted)).toEqual([])
    expect((await records(booted)).length).toBe(1)
  })

  test("production with no range for the model refuses rather than serves", async () => {
    const booted = await rig()
    booted.stack.production = true
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(res.status).toBe(503)
    expect((await errorOf(res)).code).toBe("sealed_no_length_range")
    expect(booted.engine.requests.length).toBe(0)
    expect(await committed(booted)).toBe(0n)
    booted.stack.models[0]!.sealedBytesPerToken = { low: 1, high: 512 }
    expect((await post(booted, (await sealedBytes(booted)).bytes)).status).toBe(200)
  })
})

describe("a host that reports too much", () => {
  /** Changes the counts on their way to the router, as a proxy in front of the VM can. */
  function inflate(booted: Rig, reported: { tokensIn?: number; tokensOut?: number }) {
    const hosts = booted.stack.hosts
    booted.stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        if (!path.includes("/sealed/counts/")) return res
        return Response.json({ ...((await res.json()) as object), ...reported })
      },
    }
  }

  test("output past max_tokens bills max_tokens and is flagged", async () => {
    const booted = await rig({ reply: () => ({ text: "w".repeat(600) }) })
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    await res.arrayBuffer()
    expect((await flags(booted)).map((row) => row.reason)).toContain("over_max_tokens")
    expect((await records(booted)).map((row) => row.tokens_out)).toEqual([32])
  })

  test("counts changed on the way are not the VM's, so nothing is billed", async () => {
    const booted = await rig()
    inflate(booted, { tokensOut: 1_000_000 })
    await (await post(booted, (await sealedBytes(booted)).bytes)).arrayBuffer()
    expect((await flags(booted)).map((row) => row.reason)).toEqual(["sealed_bad_counts"])
    expect(await records(booted)).toEqual([])
    expect(await committed(booted)).toBe(0n)
  })

  test("input changed on the way never bills, and the hold comes back", async () => {
    const booted = await rig()
    inflate(booted, { tokensIn: 50_000_000 })
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.error?.code).toBe("unbilled")
    expect(await committed(booted)).toBe(0n)
    expect((await flags(booted)).map((row) => row.reason)).toEqual(["sealed_bad_counts"])
    expect(await records(booted)).toEqual([])
  })

  test("a proxy cannot bill for work the VM never did, however it signs", async () => {
    const booted = await rig()
    const sealed = await sealedBytes(booted)
    proxyInPlace(booted, roleAccount("host"), 32, keccak256(sealed.bytes))
    const res = await post(booted, sealed.bytes)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.error?.code).toBe("unbilled")
    expect(booted.engine.requests.length).toBe(0)
    expect((await flags(booted)).map((row) => row.reason)).toEqual(["sealed_bad_counts"])
    expect(await records(booted)).toEqual([])
    expect(await committed(booted)).toBe(0n)
  })

  test("the VM's signature on another request's counts does not carry over", async () => {
    const booted = await rig()
    const hosts = booted.stack.hosts
    const first: SealedCounts[] = []
    booted.stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        if (!path.includes("/sealed/counts/")) return res
        const signed = sealedCountsSchema.parse(await res.json())
        first.push(signed)
        return Response.json(first[0])
      },
    }
    await (await post(booted, (await sealedBytes(booted)).bytes)).arrayBuffer()
    await (await post(booted, (await sealedBytes(booted)).bytes)).arrayBuffer()
    expect((await records(booted)).length).toBe(1)
    expect((await flags(booted)).map((row) => row.reason)).toEqual(["sealed_bad_counts"])
  })

  test("signed counts over bytes other than those relayed are not billed", async () => {
    const booted = await rig({ reply: () => ({ text: "a reply long enough to span a few frames" }) })
    const hosts = booted.stack.hosts
    booted.stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        if (!path.includes("/sealed/chat/")) return res
        const bytes = new Uint8Array(await res.arrayBuffer())
        bytes[40]! ^= 1
        return new Response(bytes, { headers: res.headers })
      },
    }
    await (await post(booted, (await sealedBytes(booted)).bytes)).arrayBuffer()
    expect((await flags(booted)).map((row) => row.reason)).toEqual(["sealed_output_hash"])
    expect(await records(booted)).toEqual([])
  })

  test("the closing frame carries the VM's signed counts", async () => {
    const booted = await rig()
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    const trailer = closingOf(new Uint8Array(await res.arrayBuffer()))
    expect(sealedCountsSchema.parse(trailer?.counts).tokensOut).toBeGreaterThan(0)
  })

  test("input past what the ciphertext could hold bills the ceiling and is flagged", async () => {
    const booted = await rig()
    const sealed = await sealedBytes(booted)
    const vm = attestKey(booted)
    proxyInPlace(booted, vm, 10_000_000, keccak256(sealed.bytes))
    await (await post(booted, sealed.bytes)).arrayBuffer()
    expect((await records(booted)).map((row) => row.tokens_in)).toEqual([inputTokenCeiling(sealed.bytes.length)])
    expect((await flags(booted)).map((row) => row.reason)).toContain("over_input_ceiling")
  })

  test("a host that will not say what it counted is not paid, and the buyer's hold comes back", async () => {
    const booted = await rig()
    const hosts = booted.stack.hosts
    booted.stack.hosts = { request: async (host, endpoint, path, init) => (path.includes("/sealed/counts/") ? new Response("no", { status: 500 }) : hosts.request(host, endpoint, path, init)) }
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.error?.code).toBe("unbilled")
    expect(await committed(booted)).toBe(0n)
    expect((await flags(booted))[0]!.reason).toBe("sealed_no_counts")
  })

  test("a host that forges the router's closing frame ends the relay", async () => {
    const booted = await rig()
    const hosts = booted.stack.hosts
    booted.stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        if (!path.includes("/sealed/chat/")) return res
        const bytes = new Uint8Array(await res.arrayBuffer())
        const forged = new Uint8Array(bytes.length + 7)
        forged.set(bytes)
        forged.set([FLAG_TRAILER, 0, 0, 0, 2, 0x7b, 0x7d], bytes.length)
        return new Response(forged, { headers: res.headers })
      },
    }
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.error?.code).toBe("sealed_bad_stream")
    expect(await committed(booted)).toBe(0n)
    expect((await flags(booted))[0]!.reason).toBe("sealed_bad_stream")
  })

  test("a host that sends a frame the reader refuses is not paid", async () => {
    const booted = await rig()
    const hosts = booted.stack.hosts
    booted.stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        if (!path.includes("/sealed/chat/")) return res
        const bytes = new Uint8Array(await res.arrayBuffer())
        bytes[16] = 0x07
        return new Response(bytes, { headers: res.headers })
      },
    }
    const res = await post(booted, (await sealedBytes(booted)).bytes)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.error?.code).toBe("sealed_bad_stream")
    expect(await records(booted)).toEqual([])
  })
})

/** What the SDK reads from the chain, answered from the mock indexer. */
const chainView = (booted: Rig) =>
  ({
    readContract: async ({ functionName, args }: { functionName: string; args: [string] }) => {
      if (functionName === "channelView") return booted.indexer.channels.get(args[0] as Hex)
      const host = booted.indexer.hosts.get(args[0].toLowerCase() as Hex)
      return functionName === "hostView" ? (host ?? { status: 0 }) : (host?.models ?? []).map((model) => model.digest)
    },
  }) as never

describe("other payers", () => {
  const addChannel = (booted: Rig, deposit: bigint) => {
    const id = keccak256(toBytes(`sealed-channel-${Math.random()}`))
    booted.indexer.channels.set(id, { payer: booted.buyer as Hex, deposit, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false })
    return id
  }

  test("a channel pays, the owed amount arrives, and the voucher lands", async () => {
    const booted = await rig()
    const id = addChannel(booted, 5n * USDG)
    const op = new Offpeak({ baseURL: BASE, wallet: roleAccount("buyer"), deployment: "local", router: booted.stack.router.address, fetch: booted.send, sealed: TRUST_ROUTER, publicClient: chainView(booted) })
    await op.channels.attach(id)
    const result = await op.sealed.chat(body("by channel", { stream: false }))
    expect(result.envelope.record.payMode).toBe(3)
    expect(result.envelope.record.payRef).toBe(id)
    const cost = result.envelope.record.hostCostMicro + result.envelope.record.feeMicro
    expect(op.channels.snapshot()!.signed).toBe(cost)
    const row = await booted.stack.db.query<{ cumulative: string }>("SELECT cumulative FROM shared.channel_state WHERE channel_id = $1", [id])
    expect(BigInt(row.rows[0]!.cumulative)).toBe(cost)
  })

  test("a channel request needs the payer's signature over the ciphertext", async () => {
    const booted = await rig()
    const id = addChannel(booted, 5n * USDG)
    const res = await post(booted, (await sealedBytes(booted)).bytes, { headers: { authorization: "", "x-offpeak-channel": id } })
    expect(res.status).toBe(401)
    expect((await errorOf(res)).code).toBe("bad_channel_auth")
  })

  const uptoBody = (booted: Rig, bytes: Uint8Array, header: string) =>
    booted.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/offpeak-hpke", "x-offpeak-model": MODEL, "x-offpeak-max-tokens": "32", "x-offpeak-sealed-host": booted.host, "payment-signature": header },
      body: new Uint8Array(bytes),
    })

  test("upto: authorized, it bills like any other", async () => {
    const booted = await rig()
    const res = await uptoBody(booted, (await sealedBytes(booted)).bytes, await uptoHeader(booted.stack, roleAccount("buyer"), keccak256(toBytes(`upto-${Math.random()}`))))
    expect(res.status).toBe(200)
    expect(closingOf(new Uint8Array(await res.arrayBuffer()))?.usage).toBeDefined()
    const rows = await records(booted)
    expect(rows[0]!.pay_mode).toBe(1)
    expect((await booted.stack.db.query("SELECT * FROM shared.agent_payments WHERE kind = 'upto'")).rows.length).toBe(1)
  })

  test("upto: the budget holds on ciphertext bytes until Authorized, and a failed authorization ends unbilled", async () => {
    const booted = await rig({ reply: () => ({ text: "y".repeat(2_000) }) })
    booted.stack.preconfirmTimeoutMs = 50
    booted.facilitator.settle = (() => Promise.resolve({ success: true })) as never
    const res = await uptoBody(booted, (await sealedBytes(booted)).bytes, await uptoHeader(booted.stack, roleAccount("buyer"), keccak256(toBytes(`upto-${Math.random()}`))))
    const raw = new Uint8Array(await res.arrayBuffer())
    const splitter = new FrameSplitter()
    const relayed = splitter.push(raw).filter((frame) => frame.flag !== FLAG_TRAILER)
    expect(relayed.reduce((sum, frame) => sum + frame.raw.length, 16)).toBeLessThanOrEqual(256)
    expect(relayed.length).toBeGreaterThan(0)
    expect(closingOf(raw)?.error?.code).toBe("authorize_failed")
    expect(await records(booted)).toEqual([])
  })

  test("exact is for fixed-cost calls", async () => {
    const booted = await rig()
    const res = await booted.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/offpeak-hpke", "x-offpeak-model": MODEL, "x-offpeak-max-tokens": "8", "x-offpeak-sealed-host": booted.host, "payment-signature": JSON.stringify({ scheme: "exact", payload: {} }) },
      body: (await sealedBytes(booted)).bytes,
    })
    expect((await errorOf(res)).code).toBe("exact_not_allowed")
  })

  test("a Window, which skips the hold check, still stops input at the ceiling", async () => {
    const booted = await rig()
    holdWindow(booted)
    const sealed = await sealedBytes(booted)
    proxyInPlace(booted, attestKey(booted), 10_000_000, keccak256(sealed.bytes))
    const res = await post(booted, sealed.bytes, { headers: { "x-offpeak-window": "7" } })
    const envelope = closingOf(new Uint8Array(await res.arrayBuffer()))?.usage as { record: { payMode: number; tokensIn: number } }
    expect(envelope.record.payMode).toBe(4)
    expect(envelope.record.tokensIn).toBe(inputTokenCeiling(sealed.bytes.length))
    expect((await flags(booted)).map((row) => row.reason)).toContain("over_input_ceiling")
  })

  const holdWindow = (booted: Rig) => {
    booted.indexer.windows.set("7", { id: 7n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: BigInt(booted.stack.clock() - 10), t1: BigInt(booted.stack.clock() + 7200), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
    booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
  }

  test("a Window is drawn at zero price and its pending draw is set to what the VM counted", async () => {
    const booted = await rig()
    holdWindow(booted)
    const res = await post(booted, (await sealedBytes(booted)).bytes, { headers: { "x-offpeak-window": "7" } })
    const envelope = closingOf(new Uint8Array(await res.arrayBuffer()))?.usage as { record: { payMode: number; hostCostMicro: string; tokensIn: number; tokensOut: number } }
    expect(envelope.record.payMode).toBe(4)
    expect(envelope.record.hostCostMicro).toBe("0")
    expect(await committed(booted)).toBe(0n)
    const sample = booted.stack.windowPerf.sofar(7n)
    expect(sample?.tokens).toBe(envelope.record.tokensOut)
  })

  test("a request the VM refuses is no demand on a Window", async () => {
    const booted = await rig()
    holdWindow(booted)
    const garbled = (await sealedBytes(booted)).bytes.slice()
    garbled[60]! ^= 1
    const res = await post(booted, garbled, { headers: { "x-offpeak-window": "7" } })
    expect(res.status).toBeLessThan(500)
    expect(booted.stack.windowPerf.sofar(7n)).toBeNull()
  })

  test("a Window's host that is down is demand, and a host the holder named instead is not", async () => {
    const booted = await rig()
    holdWindow(booted)
    booted.stack.probesOk.clear()
    booted.stack.candidateCache.clear()
    const res = await post(booted, (await sealedBytes(booted)).bytes, { headers: { "x-offpeak-window": "7" } })
    expect(res.status).toBe(503)
    expect(booted.stack.windowPerf.sofar(7n)?.demanded).toBe(true)
    const other = await rig()
    holdWindow(other)
    const row = other.indexer.windows.get("7")! as { host: Hex }
    row.host = `0x${"ab".repeat(20)}`
    await post(other, (await sealedBytes(other)).bytes, { headers: { "x-offpeak-window": "7" } })
    expect(other.stack.windowPerf.sofar(7n)).toBeNull()
  })

  test("a Window with too little left falls back or refuses as an open request does", async () => {
    const booted = await rig()
    holdWindow(booted)
    booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 0n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
    expect((await post(booted, (await sealedBytes(booted)).bytes, { headers: { "x-offpeak-window": "7" } })).status).toBe(402)
    const res = await post(booted, (await sealedBytes(booted)).bytes, { headers: { "x-offpeak-window": "7", "x-offpeak-window-fallback": "prepaid" } })
    await res.arrayBuffer()
    expect((await records(booted))[0]!.pay_mode).toBe(0)
  })
})
