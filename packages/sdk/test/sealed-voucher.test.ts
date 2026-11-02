import { describe, expect, test } from "bun:test"
import { bytesToHex, keccak256, type Hex } from "viem"
import { CountsKey } from "../../../apps/host-agent/src/sealed/counts.ts"
import { buyerRefOf, domain, feeMicro, hostCostMicro, leafFor, recordToMessage, serializeEnvelope, signTyped, usageTypes, type UsageRecord } from "../../shared/src/index.ts"
import { roleAccount } from "../../shared/src/test-keys.ts"
import { HPKE_STREAM_CONTENT_TYPE, Offpeak, RESPONSE_SALT_BYTES, SEALED_PATH, concatBytes, generateHostKey, microToUsd, openRequest, publicKeyBytes, responseKey, sealFrame, type SealedStream } from "../src/index.ts"
import { encodeTrailer } from "../src/sealed/stream.ts"
import { BASE, addChannel, bootRouter, buyerAccount, chainView, inProcess } from "./support.ts"

const USDG = 1_000_000n
const MAX_TOKENS = 64
const ROUNDS = { billed: 2, counted: 2 }
const params = { model: "ofm-8b", messages: [{ role: "user", content: "secret question" }], max_tokens: MAX_TOKENS }

/** The router, host VM key and HPKE key are stand-ins, so no port is bound. `reply` can replace the sealed answer. */
async function rig({ billed, counted }: typeof ROUNDS, reply?: () => Response) {
  const booted = await bootRouter()
  const id = addChannel(booted, 5n * USDG)
  const keys = await generateHostKey()
  const vm = new CountsKey()
  const vouchers: string[] = []
  const live = inProcess(booted.app)
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/voucher")) {
      vouchers.push(JSON.parse(String(init!.body)).cumulative)
      return Response.json({ ok: true })
    }
    if (!url.endsWith(SEALED_PATH)) return live(input, init)
    if (reply) return reply()
    const bytes = init!.body as Uint8Array
    const opened = await openRequest(keys.privateKey, bytes, SEALED_PATH)
    const salt = crypto.getRandomValues(new Uint8Array(RESPONSE_SALT_BYTES))
    const response = await responseKey(opened.secret, opened.enc, salt)
    const frame = await sealFrame(response, 0, new TextEncoder().encode(`data: ${JSON.stringify({ id: "x", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`), true)
    const outputHash = keccak256(concatBytes(salt, frame))
    const promptHash = keccak256(bytes)
    const reqId = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex
    const [priceIn, priceOut] = [104_000n, 416_000n]
    const host = hostCostMicro(10, billed, priceIn, priceOut)
    const record: UsageRecord = { reqId, buyerRef: buyerRefOf(buyerAccount.address, reqId), host: booted.host as Hex, modelDigest: booted.modelDigest, tokensIn: 10, tokensOut: billed, promptHash, outputHash, priceIn, priceOut, hostCostMicro: host, feeMicro: feeMicro(host, 400), payMode: 3, payRef: id, ts: booted.stack.clock(), sheetHash: booted.stack.sheets[0]!.sheetHash as Hex }
    const typed = { domain: domain("OffpeakUsage", booted.stack.usageLedger), types: usageTypes, primaryType: "UsageRecord" as const, message: recordToMessage(record) as never }
    const routerSig = await signTyped(booted.stack.router, typed)
    const hostSig = await signTyped(roleAccount("host") as never, typed)
    const usage = serializeEnvelope({ v: 1, record, routerSig, hostSig, leaf: leafFor(record, routerSig, hostSig), hostCounts: { tokensIn: 10, tokensOut: counted }, sealed: true, proofUrl: "/x" })
    const counts = await vm.sign({ reqId, tokensIn: 10, tokensOut: counted, promptHash, outputHash })
    const trailer = encodeTrailer({ usage, counts, channelOwed: (record.hostCostMicro + record.feeMicro).toString() })
    return new Response(concatBytes(salt, frame, trailer), { headers: { "content-type": HPKE_STREAM_CONTENT_TYPE } })
  }) as typeof fetch
  const op = new Offpeak({ baseURL: BASE, wallet: buyerAccount, deployment: "local", router: booted.stack.router.address, fetch: send, publicClient: chainView(booted), sealed: { trustRouterVerification: true } })
  await op.channels.attach(id)
  const hpkePublicKey = bytesToHex(await publicKeyBytes(keys.publicKey))
  const host = { host: booted.host as Hex, modelDigest: booted.modelDigest, hpkePublicKey, attestationRef: `0x${"00".repeat(32)}` as Hex, tcbStatus: "UpToDate", verifiedAt: 0, transcript: { bindings: { countsSigner: vm.address } } } as never
  return { op, host, vouchers }
}

const inFlight = (op: Offpeak) => (op.channels as unknown as { active: { inFlight: number } }).active.inFlight

const outcome = (work: Promise<unknown>) =>
  work.then(
    () => "ok",
    (err) => (err as { code: string }).code,
  )

describe("a sealed voucher waits for the sealed checks", () => {
  test("a record matching the VM's counts gets its voucher before the call returns", async () => {
    const { op, host, vouchers } = await rig(ROUNDS)
    expect(await outcome(op.sealed.chat(params, { host }))).toBe("ok")
    expect(vouchers).toHaveLength(1)
    expect(BigInt(vouchers[0]!)).toBeLessThan(10n)
    expect(op.channels.snapshot()!.refused).toBeNull()
    expect(inFlight(op)).toBe(0)
  })

  test("a record above the VM's counts is refused, and no voucher leaves", async () => {
    const { op, host, vouchers } = await rig({ billed: 11_000_000, counted: 2 })
    expect(await outcome(op.sealed.chat(params, { host }))).toBe("sealed_counts_mismatch")
    await Bun.sleep(20)
    expect(vouchers).toEqual([])
    expect(op.channels.snapshot()!.signed).toBe(0n)
    expect(op.channels.snapshot()!.refused).toContain("above the 0 covered")
    expect(inFlight(op)).toBe(0)
  })

  test("a streamed record above the VM's counts gets no voucher either", async () => {
    const { op, host, vouchers } = await rig({ billed: 11_000_000, counted: 2 })
    const stream = await op.sealed.chat({ ...params, stream: true }, { host })
    expect(await outcome(stream.final())).toBe("sealed_counts_mismatch")
    expect(vouchers).toEqual([])
  })

  test("a record over the clear max_tokens gets no voucher, even with the VM's own counts", async () => {
    const { op, host, vouchers } = await rig({ billed: 500, counted: 500 })
    expect(await outcome(op.sealed.chat(params, { host }))).toBe("ok")
    expect(vouchers).toEqual([])
    expect(op.channels.snapshot()!.refused).toContain(`on a limit of ${MAX_TOKENS}`)
  })

  test("a reader who leaves early signs nothing and frees the channel", async () => {
    const { op, host, vouchers } = await rig(ROUNDS)
    const stream: SealedStream = await op.sealed.chat({ ...params, stream: true }, { host })
    for await (const _ of stream) break
    expect(vouchers).toEqual([])
    expect(inFlight(op)).toBe(0)
  })

  test("a reply that is not sealed cannot settle a sealed request", async () => {
    const { op, host, vouchers } = await rig(ROUNDS, () => Response.json({ offpeak_usage: {} }, { headers: { "x-offpeak-channel-owed": "4000000" } }))
    expect(await outcome(op.sealed.chat(params, { host }))).toBe("sealed_truncated")
    await Bun.sleep(20)
    expect(vouchers).toEqual([])
    expect(inFlight(op)).toBe(0)
  })
})

describe("a sealed stream and its cap", () => {
  const under = { "x-offpeak-max-price": `in=${microToUsd(1n)},out=${microToUsd(1n)}` }
  const over = { "x-offpeak-max-price": `in=${microToUsd(USDG)},out=${microToUsd(USDG)}` }

  test("a stream that bills above the cap fails when it ends, and no voucher leaves", async () => {
    const { op, host, vouchers } = await rig(ROUNDS)
    const stream = await op.sealed.chat({ ...params, stream: true }, { host, headers: under })
    expect(await outcome(stream.final())).toBe("over_max_price")
    await Bun.sleep(20)
    expect(vouchers).toEqual([])
  })

  test("a reader iterating by hand hears it too", async () => {
    const { op, host } = await rig(ROUNDS)
    const stream = await op.sealed.chat({ ...params, stream: true }, { host, headers: under })
    const reading = (async () => {
      for await (const _ of stream) void _
    })()
    expect(await outcome(reading)).toBe("over_max_price")
  })

  test("a whole reply is held to the cap as well", async () => {
    const { op, host } = await rig(ROUNDS)
    expect(await outcome(op.sealed.chat(params, { host, headers: under }))).toBe("over_max_price")
  })

  test("a stream under the cap passes", async () => {
    const { op, host, vouchers } = await rig(ROUNDS)
    const stream = await op.sealed.chat({ ...params, stream: true }, { host, headers: over })
    expect(await outcome(stream.final())).toBe("ok")
    expect(vouchers).toHaveLength(1)
  })
})
