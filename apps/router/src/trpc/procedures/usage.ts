import { HOUR_CLOSE_GRACE_S, hourEnd, type Hex } from "@offpeak/shared"
import { z } from "zod"
import { authed, missing, router } from "../init.ts"
import { bytes32 } from "../inputs.ts"
import type { Stack } from "../../pipeline.ts"

type UsageRow = {
  req_id: Hex
  hour: string
  ts: string
  buyer_ref: Hex
  host: Hex
  model_digest: Hex
  tokens_in: number
  tokens_out: number
  prompt_hash: Hex
  output_hash: Hex
  price_in: string
  price_out: string
  host_cost_micro: string
  fee_micro: string
  fee_bps: number
  pay_mode: number
  pay_ref: Hex
  sheet_hash: Hex
  router_sig: Hex
  host_sig: Hex
  leaf: Hex
  sealed: boolean
  status: string
  settled_hour_tx: string | null
}

const COLUMNS = `req_id, hour, ts, buyer_ref, host, model_digest, tokens_in, tokens_out, prompt_hash, output_hash, price_in, price_out,
  host_cost_micro, fee_micro, fee_bps, pay_mode, pay_ref, sheet_hash, router_sig, host_sig, leaf, sealed, status, settled_hour_tx`

/** Bigints stay decimal strings. The page rebuilds the record and checks it locally. */
function present(stack: Stack, row: UsageRow) {
  return {
    record: {
      reqId: row.req_id,
      buyerRef: row.buyer_ref,
      host: row.host,
      modelDigest: row.model_digest,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      promptHash: row.prompt_hash,
      outputHash: row.output_hash,
      priceIn: String(row.price_in),
      priceOut: String(row.price_out),
      hostCostMicro: String(row.host_cost_micro),
      feeMicro: String(row.fee_micro),
      payMode: row.pay_mode,
      payRef: row.pay_ref,
      ts: Number(row.ts),
      sheetHash: row.sheet_hash,
    },
    routerSig: row.router_sig,
    hostSig: row.host_sig,
    leaf: row.leaf,
    sealed: row.sealed,
    feeBps: row.fee_bps,
    hour: Number(row.hour),
    status: row.status,
    settledTx: row.settled_hour_tx,
    model: stack.models.find((model) => model.digest === row.model_digest)?.name ?? null,
    hourClosesAt: hourEnd(Number(row.hour)) + HOUR_CLOSE_GRACE_S,
  }
}

const page = z.strictObject({
  limit: z.number().int().min(1).max(100).default(25),
  before: z.strictObject({ ts: z.number().int().nonnegative(), reqId: bytes32 }).optional(),
})

export const usage = router({
  recent: authed.query(async ({ ctx }) => {
    const rows = await ctx.stack.db.query("SELECT req_id, tokens_in, tokens_out, pay_mode FROM shared.usage_records WHERE payer = $1 ORDER BY ts DESC LIMIT 20", [ctx.wallet])
    return rows.rows
  }),
  list: authed.input(page).query(async ({ ctx: { stack, wallet }, input }) => {
    const rows = await stack.db.query<UsageRow>(
      `SELECT ${COLUMNS} FROM shared.usage_records
       WHERE payer = $1 AND ($2::bigint IS NULL OR (ts, req_id) < ($2::bigint, $3::text))
       ORDER BY ts DESC, req_id DESC LIMIT $4`,
      [wallet, input.before?.ts ?? null, input.before?.reqId ?? null, input.limit],
    )
    return { rows: rows.rows.map((row) => present(stack, row)), more: rows.rows.length === input.limit, serverTime: stack.clock() }
  }),
  /** The Merkle proof exists once the hour is settled. Until then `proof` is null, which is not a failure. */
  get: authed.input(z.strictObject({ reqId: bytes32 })).query(async ({ ctx: { stack, wallet }, input }) => {
    const rows = await stack.db.query<UsageRow>(`SELECT ${COLUMNS} FROM shared.usage_records WHERE req_id = $1 AND payer = $2`, [input.reqId, wallet])
    const row = rows.rows[0]
    if (!row) throw missing()
    return { ...present(stack, row), proof: await stack.indexer.proof(input.reqId) }
  }),
})
