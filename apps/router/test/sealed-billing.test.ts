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
