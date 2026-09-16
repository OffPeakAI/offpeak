import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { LAUNCH_TOKENIZER, feeMicro, leafFor, loadModelTokenizer, parseRecord, readManifest, recordToMessage, domain, usageTypes, type UsageEnvelope, type UsageRecord } from "@offpeak/shared"
import { addressOf } from "@offpeak/abis"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../shared/src/test-keys.ts"
import { ask, bootRouter, buyerAccount, client, inProcess } from "./support.ts"
import { OffpeakError, envelopeSchema, verifyUsage, type ChatResult, type ChatStream } from "../src/index.ts"
import { issueKey } from "../../../apps/router/src/pipeline.ts"

const vectors = JSON.parse(readFileSync(new URL("../../shared/fixtures/vectors.json", import.meta.url), "utf8"))
const ledger = addressOf("UsageLedger")
const router = roleAccount("router")
const host = roleAccount("host")

/** A record both real test keys signed, so a check can only fail on what it is checking. */
async function signed(record: UsageRecord): Promise<UsageEnvelope> {
  const typed = { domain: domain("OffpeakUsage", ledger), types: usageTypes, primaryType: "UsageRecord" as const, message: recordToMessage(record) as never }
  const routerSig = await router.signTypedData(typed)
  const hostSig = await host.signTypedData(typed)
  return { v: 1, record, routerSig, hostSig, leaf: leafFor(record, routerSig, hostSig), hostCounts: { tokensIn: record.tokensIn, tokensOut: record.tokensOut }, sealed: false, proofUrl: `/v1/usage/${record.reqId}` }
}

const verify = (env: UsageEnvelope, opts?: Parameters<typeof verifyUsage>[4]) => verifyUsage(env, ledger, router.address, host.address, opts)

const base = (): UsageRecord => parseRecord(vectors.usage[0].record)

describe("golden vectors", () => {
  test("every vector record passes", async () => {
    for (const row of vectors.usage) {
      const env: UsageEnvelope = { v: 1, record: parseRecord(row.record), routerSig: row.routerSig, hostSig: row.hostSig, leaf: row.leaf, hostCounts: { tokensIn: 0, tokensOut: 0 }, sealed: false, proofUrl: "" }
      const report = await verifyUsage(env, vectors.addresses.contracts.UsageLedger, vectors.addresses.router, vectors.addresses.host)
      expect(report).toMatchObject({ ok: true, routerOk: true, hostOk: true, costOk: true, leafOk: true, reasons: [] })
    }
  })

  test("the voucher signature matches the vector byte for byte", async () => {
    const { channelId, seq, cumulative, signature } = vectors.voucher
    let posted: { sig: string; seq: string; cumulative: string } | null = null
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/voucher")) {
        posted = JSON.parse(String(init?.body))
        return Response.json({ accepted: true })
      }
      return Response.json({ deposit: "1000000", claimed: "0", cumulative: "0", owed: "0", latestSeq: String(BigInt(seq) - 1n), status: 1, expiry: "9999999999" })
    }) as typeof fetch
    const booted = await bootRouter()
    const onChain = { readContract: async () => ({ payer: buyerAccount.address, deposit: 1_000_000n, claimed: 0n, lastSeq: BigInt(seq) - 1n, expiry: 9_999_999_999n, challengeEndsAt: 0n, status: 1 }) }
    const op = client(booted, { fetch: fake, publicClient: onChain as never })
    await op.channels.attach(channelId)
    const receipt = await op.channels.voucher(BigInt(cumulative))
    expect(receipt?.sig).toBe(signature)
    expect(posted!).toEqual({ seq, cumulative, sig: signature })
  })
})

describe("signatures and leaf", () => {
  test("a real router envelope passes through op.verifyUsage", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token })
    const { envelope } = (await op.chat(ask("verify me"))) as ChatResult
    expect(await op.verifyUsage(envelope, { payer: booted.buyer })).toMatchObject({ ok: true, payerOk: true })
  })

  test("a record signed by anyone else fails that signature only", async () => {
    const env = await signed(base())
    const report = await verifyUsage(env, ledger, roleAccount("buyer").address, host.address)
    expect(report).toMatchObject({ ok: false, routerOk: false, hostOk: true, reasons: ["router_sig"] })
    const other = await verifyUsage(env, ledger, router.address, roleAccount("buyer").address)
    expect(other).toMatchObject({ ok: false, routerOk: true, hostOk: false, reasons: ["host_sig"] })
  })

  test("a changed record no longer matches either signature", async () => {
    const env = await signed(base())
    const report = await verify({ ...env, record: { ...env.record, tokensOut: env.record.tokensOut + 1 } })
    expect(report.routerOk).toBe(false)
    expect(report.hostOk).toBe(false)
    expect(report.ok).toBe(false)
  })

  test("a signature from the wrong ledger's domain fails", async () => {
    const report = await verifyUsage(await signed(base()), addressOf("OffpeakVault"), router.address, host.address)
    expect(report.routerOk).toBe(false)
  })

  test("garbage signatures fail without throwing", async () => {
    const env = await signed(base())
    const report = await verify({ ...env, routerSig: "0x1234" as Hex, hostSig: "0x" as Hex })
    expect(report).toMatchObject({ routerOk: false, hostOk: false, ok: false })
  })

  test("a wrong leaf fails", async () => {
    const env = await signed(base())
    expect((await verify({ ...env, leaf: keccak256(toBytes("other")) })).reasons).toEqual(["leaf"])
  })

  test("buyerRef must be the payer's", async () => {
    const env = await signed(base())
    expect((await verify(env, { payer: roleAccount("host").address })).reasons).toContain("buyer_ref")
  })
})

describe("cost math", () => {
  test("a host cost that does not follow from the tokens fails", async () => {
    const env = await signed({ ...base(), hostCostMicro: base().hostCostMicro + 1n })
    expect((await verify(env)).reasons).toContain("cost")
  })

  test("a fee over the default rate fails, a lower one passes, and a pinned rate is exact", async () => {
    const record = { ...base(), tokensIn: 100_000, tokensOut: 100_000 }
    const hostCost = record.tokensIn * Number(record.priceIn) / 1_000_000 + record.tokensOut * Number(record.priceOut) / 1_000_000
    const cost = BigInt(Math.ceil(hostCost))
    const at = (bps: number) => signed({ ...record, hostCostMicro: cost, feeMicro: feeMicro(cost, bps) })
    expect((await verify(await at(400))).ok).toBe(true)
    expect((await verify(await at(296))).ok).toBe(true)
    expect((await verify(await at(100))).ok).toBe(true)
    expect((await verify(await at(401))).reasons).toContain("cost")
    expect((await verify(await at(99))).reasons).toContain("cost")
    expect((await verify(await at(296), { feeBps: 296 })).ok).toBe(true)
    expect((await verify(await at(400), { feeBps: 296 })).reasons).toContain("cost")
  })
