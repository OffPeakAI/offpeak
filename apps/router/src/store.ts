import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { connectDatabase, wrapPglite, type Db } from "@offpeak/common"
import { sharedSql } from "../../../packages/shared/src/migrate.ts"

const servingSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../db/serving/schema.sql"), "utf8")

/** Accepts `pglite://memory` and `postgres://…`. The router owns the shared and serving schemas. */
export async function openDb(url = "pglite://memory"): Promise<Db> {
  const db = url.startsWith("pglite://") ? wrapPglite(new PGlite()) : connectDatabase(url)
  await db.exec(sharedSql())
  await db.exec(servingSql)
  return db
}
export type UsageRow = {
  reqId: string
  hour: number
  ts: number
  payer: string
  buyerRef: string
  host: string
  modelDigest: string
  tokensIn: number
  tokensOut: number
  promptHash: string
  outputHash: string
  priceIn: bigint
  priceOut: bigint
  hostCostMicro: bigint
  feeMicro: bigint
  feeBps: number
  payMode: number
  payRef: string
  sheetHash: string
  windowId?: string
  routerSig: string
  hostSig: string
  leaf: string
  sealed: boolean
}

export async function insertUsage(db: Db, row: UsageRow) {
  await db.query(
    `INSERT INTO shared.usage_records (
      req_id, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out,
      prompt_hash, output_hash, price_in, price_out, host_cost_micro, fee_micro, fee_bps, pay_mode,
      pay_ref, sheet_hash, window_id, router_sig, host_sig, leaf, sealed, status
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'final'
    )`,
    [
      row.reqId,
      row.hour,
      row.ts,
      row.payer,
      row.buyerRef,
      row.host,
      row.modelDigest,
      row.tokensIn,
      row.tokensOut,
      row.promptHash,
      row.outputHash,
      row.priceIn.toString(),
      row.priceOut.toString(),
      row.hostCostMicro.toString(),
      row.feeMicro.toString(),
      row.feeBps,
      row.payMode,
      row.payRef,
      row.sheetHash,
      row.windowId ?? null,
      row.routerSig,
      row.hostSig,
      row.leaf,
      row.sealed,
    ],
  )
}

export async function insertRequestMeta(
  db: Db,
  row: {
    reqId: string
    accountId: string | null
    wallet: string
    modelDigest: string
    host: string
    payMode: number
    tokensIn: number
    tokensOut: number
    ttftMs: number
    durationMs: number
    status: string
    errorCode: string | null
    sealed: boolean
    ts: number
    hostCounts: { tokensIn: number; tokensOut: number }
  },
) {
  await db.query(
    `INSERT INTO serving.requests (
      req_id, account_id, wallet, model_digest, host, pay_mode, tokens_in, tokens_out,
      ttft_ms, duration_ms, status, error_code, sealed, ts, host_counts
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [
      row.reqId,
      row.accountId,
      row.wallet,
      row.modelDigest,
      row.host,
      row.payMode,
      row.tokensIn,
      row.tokensOut,
      row.ttftMs,
      row.durationMs,
      row.status,
      row.errorCode,
      row.sealed,
      row.ts,
      JSON.stringify(row.hostCounts),
    ],
  )
}

export async function captureTx(db: Db, usage: UsageRow, meta: Parameters<typeof insertRequestMeta>[1], extra?: (tx: Db) => Promise<void>) {
  await db.transaction(async (tx) => {
    await insertUsage(tx, usage)
    await insertRequestMeta(tx, meta)
    await extra?.(tx)
  })
}
