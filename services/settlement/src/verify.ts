import {
  buyerRefOf,
  feeBpsFor,
  feeMicro,
  hostCostMicro,
  hourIndex,
  leafFor,
  recordToMessage,
  recoverUsageSigner,
  type PayMode,
  type UsageRecord,
} from "@offpeak/shared"
import type { Address, Hex } from "viem"

export type UsageRow = {
  req_id: string
  hour: string | number
  ts: string | number
  payer: string
  buyer_ref: string
  host: string
  model_digest: string
  tokens_in: number
  tokens_out: number
  prompt_hash: string
  output_hash: string
  price_in: string | number
  price_out: string | number
  host_cost_micro: string | number
  fee_micro: string | number
  fee_bps: number
  pay_mode: number
  pay_ref: string
  sheet_hash: string
  window_id: string | null
  router_sig: string
  host_sig: string
  leaf: string
}

export type RejectReason =
  | "router_sig"
  | "host_sig"
  | "host_status"
  | "wrong_hour"
  | "host_cost"
  | "fee"
  | "buyer_ref"
  | "leaf"
  | "after_withdraw_request"
  | "over_hourly_cap"
  | "over_daily_cap"
  | "over_batch_capacity"
  | "over_window_balance"
  | "window_ref"

export type VerifyContext = {
  routerAddress: Address
  usageLedger: Address
  /** Whether the host was in Probation or Active at `ts`, from the indexer's status history. */
  hostServingAt: (host: string, ts: number) => boolean
  /** The payer's $OFPK discount in bps. Zero while token hooks are off. */
  discountBps: (payer: string) => number
}

export function rowToRecord(row: UsageRow): UsageRecord {
  return {
    reqId: row.req_id as Hex,
    buyerRef: row.buyer_ref as Hex,
    host: row.host as Hex,
    modelDigest: row.model_digest as Hex,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    promptHash: row.prompt_hash as Hex,
    outputHash: row.output_hash as Hex,
    priceIn: BigInt(row.price_in),
    priceOut: BigInt(row.price_out),
    hostCostMicro: BigInt(row.host_cost_micro),
    feeMicro: BigInt(row.fee_micro),
    payMode: row.pay_mode as PayMode,
    payRef: row.pay_ref as Hex,
    ts: Number(row.ts),
    sheetHash: row.sheet_hash as Hex,
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function feeIsAllowed(row: UsageRow, ctx: VerifyContext): boolean {
  const ofpkDiscountBps = ctx.discountBps(row.payer)
  return row.fee_bps === feeBpsFor({ ofpkDiscountBps }) || row.fee_bps === feeBpsFor({ auditOptIn: true, ofpkDiscountBps })
}

function checkCost(record: UsageRecord, row: UsageRow, ctx: VerifyContext): RejectReason | null {
  if (record.payMode === 4) {
    if (row.window_id === null || BigInt(record.payRef) !== BigInt(row.window_id)) return "window_ref"
    if (record.hostCostMicro !== 0n || record.priceIn !== 0n || record.priceOut !== 0n) return "host_cost"
    return record.feeMicro === 0n ? null : "fee"
  }
  if (record.hostCostMicro !== hostCostMicro(record.tokensIn, record.tokensOut, record.priceIn, record.priceOut)) {
    return "host_cost"
  }
  if (!feeIsAllowed(row, ctx) || record.feeMicro !== feeMicro(record.hostCostMicro, row.fee_bps)) return "fee"
  return null
}

/** The record checks of 4.12 step 3. It returns the first failure, or null. */
export async function verifyRecord(row: UsageRow, ctx: VerifyContext): Promise<RejectReason | null> {
  const record = rowToRecord(row)
  const message = recordToMessage(record)
  const routerSigner = await recoverUsageSigner(message, row.router_sig as Hex, ctx.usageLedger).catch(() => "")
  if (!sameAddress(routerSigner, ctx.routerAddress)) return "router_sig"
  const hostSigner = await recoverUsageSigner(message, row.host_sig as Hex, ctx.usageLedger).catch(() => "")
  if (!sameAddress(hostSigner, record.host)) return "host_sig"
  if (!ctx.hostServingAt(record.host, record.ts)) return "host_status"
  if (BigInt(row.hour) !== BigInt(hourIndex(record.ts))) return "wrong_hour"
  const costFailure = checkCost(record, row, ctx)
  if (costFailure) return costFailure
  if (record.buyerRef !== buyerRefOf(row.payer, record.reqId)) return "buyer_ref"
  if (row.leaf !== leafFor(record, row.router_sig as Hex, row.host_sig as Hex)) return "leaf"
  return null
}
