import type { Hex } from "viem"
import { z } from "zod"
import {
  FEE_BPS_DEFAULT,
  FEE_BPS_MIN,
  buyerRefOf,
  feeMicro,
  hostCostMicro,
  leafFor,
  parseEnvelope,
  recordToMessage,
  recountRecord,
  recoverUsageSigner,
  verifyMerkle,
  type Micro,
  type Recount,
  type RecountReport,
  type UsageEnvelope,
  type UsageRecord,
} from "@offpeak/shared"
import { OffpeakError, addressSchema, bytes32Schema, digitsSchema, hexSchema, usdToMicro } from "./core.ts"

const envelopeShape = z.object({
  v: z.literal(1),
  record: z.object({
    reqId: bytes32Schema,
    buyerRef: bytes32Schema,
    host: addressSchema,
    modelDigest: bytes32Schema,
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    promptHash: bytes32Schema,
    outputHash: bytes32Schema,
    priceIn: digitsSchema,
    priceOut: digitsSchema,
    hostCostMicro: digitsSchema,
    feeMicro: digitsSchema,
    payMode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    payRef: bytes32Schema,
    ts: z.number().int().nonnegative(),
    sheetHash: bytes32Schema,
  }),
  routerSig: hexSchema,
  hostSig: hexSchema,
  leaf: bytes32Schema,
  hostCounts: z.object({ tokensIn: z.number().int(), tokensOut: z.number().int() }),
  sealed: z.boolean(),
  proofUrl: z.string(),
})

/** An envelope as it arrives over HTTP, bigints still decimal strings. */
export const envelopeSchema = envelopeShape.transform((raw): UsageEnvelope => parseEnvelope(raw))

export type { Recount, RecountReport }

/** Buyer price per 1M tokens, fee included. */
export type MaxPrice = { inPerM: Micro; outPerM: Micro }

export type VerifyOptions = {
  /** The fee rate you know you pay. Without it the fee must sit between the minimum and default rates. */
  feeBps?: number
  /** Your wallet. Checks the record's `buyerRef` is yours. */
  payer?: string
  /** The cap you sent with the request. */
  maxPrice?: MaxPrice
  recount?: Recount
}

export type VerifyReport = {
  /** Every check that ran passed, and nothing you asked for went unchecked. */
  ok: boolean
  routerOk: boolean
  hostOk: boolean
  costOk: boolean
  leafOk: boolean
  payerOk?: boolean
  /** The host is on the chain's `HostRegistry` with this model. Unset with no RPC, and `notChecked` says so. */
  hostRegistered?: boolean
  maxPriceOk?: boolean
  recount?: RecountReport
  reasons: string[]
  /** What this client had no way to check. `host_registry` needs an RPC, `token_count` the model's tokenizer. */
  notChecked: string[]
}

async function signedBy(env: UsageEnvelope, sig: Hex, usageLedger: string, expected: string) {
  try {
    return (await recoverUsageSigner(recordToMessage(env.record), sig, usageLedger)).toLowerCase() === expected.toLowerCase()
  } catch {
    return false
  }
}

/** Host cost and fee each round up once, and a cap's own total rounds once more. */
const CAP_ROUNDING_MICRO = 3n

/** True when a record bills more than the cap you sent. A Window was paid at purchase, so a live cap says nothing about it. */
export function overMaxPrice(record: UsageRecord, cap: MaxPrice) {
  if (record.payMode === 4) return false
  if (record.priceIn > cap.inPerM || record.priceOut > cap.outPerM) return true
  return record.hostCostMicro + record.feeMicro > hostCostMicro(record.tokensIn, record.tokensOut, cap.inPerM, cap.outPerM) + CAP_ROUNDING_MICRO
}

/** The cap on a request, wherever it was set, so the openai client's headers count too. */
export function capFrom(headers: Headers): MaxPrice | undefined {
  const match = /^in=([\d.]+),out=([\d.]+)$/.exec(headers.get("x-offpeak-max-price") ?? "")
  return match ? { inPerM: usdToMicro(match[1]!), outPerM: usdToMicro(match[2]!) } : undefined
}

/** The router promised this cap. A record above it is paid for, so the caller hears of it rather than a quiet answer. */
export function assertWithinCap(envelope: UsageEnvelope, cap: MaxPrice | undefined) {
  if (cap && overMaxPrice(envelope.record, cap)) throw new OffpeakError("over_max_price", `Request ${envelope.record.reqId} bills above your max price. You can dispute it within 7 days.`, undefined, { reqId: envelope.record.reqId })
}

/** A fee over the default rate is an overcharge. A lower one is a discount a tier or opt-in can give. */
function costMatches(record: UsageRecord, feeBps: number | undefined) {
  if (record.payMode === 4) return record.priceIn === 0n && record.priceOut === 0n && record.hostCostMicro === 0n && record.feeMicro === 0n
  const host = hostCostMicro(record.tokensIn, record.tokensOut, record.priceIn, record.priceOut)
  if (host !== record.hostCostMicro) return false
  if (feeBps !== undefined) return record.feeMicro === feeMicro(host, feeBps)
  return record.feeMicro >= feeMicro(host, FEE_BPS_MIN) && record.feeMicro <= feeMicro(host, FEE_BPS_DEFAULT)
}

export async function verifyUsage(env: UsageEnvelope, usageLedger: string, router: string, host: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const reasons: string[] = []
  const routerOk = await signedBy(env, env.routerSig, usageLedger, router)
  const hostOk = await signedBy(env, env.hostSig, usageLedger, host)
  if (!routerOk) reasons.push("router_sig")
  if (!hostOk) reasons.push("host_sig")
  const costOk = costMatches(env.record, opts.feeBps)
  if (!costOk) reasons.push("cost")
  const leafOk = leafFor(env.record, env.routerSig, env.hostSig) === env.leaf
  if (!leafOk) reasons.push("leaf")
  const report: VerifyReport = { ok: false, routerOk, hostOk, costOk, leafOk, reasons, notChecked: [] }
  if (opts.payer) {
    report.payerOk = buyerRefOf(opts.payer, env.record.reqId) === env.record.buyerRef
    if (!report.payerOk) reasons.push("buyer_ref")
  }
  if (opts.maxPrice) {
    report.maxPriceOk = !overMaxPrice(env.record, opts.maxPrice)
    if (!report.maxPriceOk) reasons.push("max_price")
  }
  if (opts.recount) {
    if (env.sealed) reasons.push("recount_sealed")
    else {
      report.recount = recountRecord(env.record, opts.recount)
      if (!report.recount.promptOk) reasons.push("prompt_hash")
      if (!report.recount.outputOk) reasons.push("output_hash")
      if (report.recount.countsOk === false) reasons.push("token_count")
      if (report.recount.countsOk === null) {
        reasons.push("token_count_not_checked")
        report.notChecked.push("token_count")
      }
    }
  }
  report.ok = reasons.length === 0
  return report
}

export function checkProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  return verifyMerkle(leaf, proof, root)
}
