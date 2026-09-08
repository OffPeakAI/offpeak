import { ZERO_BYTES32, buyerRefOf, domain, feeMicro, hostCostMicro, leafFor, recordToMessage, usageTypes, type PayMode, type UsageRecord } from "@offpeak/shared"
import type { Db } from "@offpeak/common"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { keccak256, toBytes, type Address, type Hex } from "viem"
import type { UsageRow } from "./verify.ts"

export type RowOptions = { i: number; hour: number; payer: string; payMode?: PayMode; ts?: number; feeBps?: number; tokensIn?: number }

const router = roleAccount("router")
const host = roleAccount("host")

/** A usage record signed by the fixture router and host keys, shaped like its database row. */
export async function signRow(o: RowOptions, ledger: Address): Promise<UsageRow> {
  const payMode = o.payMode ?? 0
  const reqId = keccak256(toBytes(`req-${o.hour}-${o.i}`))
  const feeBps = o.feeBps ?? 400
  const tokensIn = o.tokensIn ?? 1000
  const priceIn = payMode === 4 ? 0n : 200_000n
  const priceOut = payMode === 4 ? 0n : 800_000n
  const cost = payMode === 4 ? 0n : hostCostMicro(tokensIn, 100, priceIn, priceOut)
  const record: UsageRecord = {
    reqId,
    buyerRef: buyerRefOf(o.payer, reqId),
    host: host.address.toLowerCase() as Hex,
    modelDigest: keccak256(toBytes("model")),
    tokensIn,
    tokensOut: 100,
    promptHash: keccak256(toBytes("p")),
    outputHash: keccak256(toBytes("o")),
    priceIn,
    priceOut,
    hostCostMicro: cost,
    feeMicro: payMode === 4 ? 0n : feeMicro(cost, feeBps),
    payMode,
    payRef: payMode === 4 ? (`0x${(9).toString(16).padStart(64, "0")}` as Hex) : ZERO_BYTES32,
    ts: o.ts ?? o.hour * 3600 + o.i,
    sheetHash: keccak256(toBytes("sheet")),
  }
  const message = recordToMessage(record) as never
  const typed = { domain: domain("OffpeakUsage", ledger), types: usageTypes, primaryType: "UsageRecord", message } as const
  const routerSig = await router.signTypedData(typed)
  const hostSig = await host.signTypedData(typed)
  return {
    req_id: reqId,
    hour: o.hour,
    ts: record.ts,
    payer: o.payer,
    buyer_ref: record.buyerRef,
    host: record.host,
    model_digest: record.modelDigest,
    tokens_in: record.tokensIn,
    tokens_out: record.tokensOut,
    prompt_hash: record.promptHash,
    output_hash: record.outputHash,
    price_in: record.priceIn.toString(),
    price_out: record.priceOut.toString(),
    host_cost_micro: record.hostCostMicro.toString(),
    fee_micro: record.feeMicro.toString(),
    fee_bps: payMode === 4 ? 0 : feeBps,
    pay_mode: payMode,
    pay_ref: record.payRef,
    sheet_hash: record.sheetHash,
    window_id: payMode === 4 ? "9" : null,
    router_sig: routerSig,
    host_sig: hostSig,
    leaf: leafFor(record, routerSig, hostSig),
  }
}

export async function insertRow(db: Db, row: UsageRow) {
  await db.query(
    `INSERT INTO shared.usage_records (req_id, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out,
       prompt_hash, output_hash, price_in, price_out, host_cost_micro, fee_micro, fee_bps, pay_mode, pay_ref, sheet_hash,
       router_sig, host_sig, leaf)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      row.req_id, row.hour, row.ts, row.payer, row.buyer_ref, row.host, row.model_digest, row.tokens_in, row.tokens_out,
      row.prompt_hash, row.output_hash, row.price_in, row.price_out, row.host_cost_micro, row.fee_micro, row.fee_bps,
      row.pay_mode, row.pay_ref, row.sheet_hash, row.router_sig, row.host_sig, row.leaf,
    ],
  )
}
