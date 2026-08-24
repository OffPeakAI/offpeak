import { hostCostMicro, hourOfWeek } from "@offpeak/shared"
import type { Stack } from "../context.ts"

export type StatInput = {
  tokensIn: number
  tokensOut: number
  billedHostMicro: bigint
  baseIn: bigint
  baseOut: bigint
}

/** 1 − billed / base-value, in bps. Positive when the buyer paid under the posted base. */
export function effectiveDiscountBps(rows: StatInput[]): number {
  let billed = 0n
  let base = 0n
  for (const row of rows) {
    billed += row.billedHostMicro
    base += hostCostMicro(row.tokensIn, row.tokensOut, row.baseIn, row.baseOut)
  }
  if (base <= 0n) return 0
  if (billed >= base) return 0
  const diff = base - billed
  return Number((diff * 10_000n) / base)
}

const DAY_S = 86_400
const WINDOW_DRAW = 4
const HOUR_S = 3_600

/** Window draws carry no price, because the Window was paid at purchase, so they say nothing about a discount. */
const STATS_SQL = `SELECT host, sheet_hash, hour, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(host_cost_micro) AS billed
  FROM shared.usage_records WHERE status = 'final' AND pay_mode <> $3 AND ts >= $1 AND ts < $2 GROUP BY host, sheet_hash, hour`

/** Rebuilds one UTC day's row per host. Base value is each hour's tokens at that hour's base on the sheet the records used. */
async function writeDay(stack: Stack, day: number) {
  const rows = await stack.db.query<{ host: string; sheet_hash: string; hour: string; tokens_in: string; tokens_out: string; billed: string }>(STATS_SQL, [day * DAY_S, (day + 1) * DAY_S, WINDOW_DRAW])
  const sheets = new Map<string, Stack["sheets"][number]>(stack.sheets.map((sheet) => [sheet.sheetHash, sheet]))
  const hosts = new Map<string, StatInput[]>()
  for (const row of rows.rows) {
    const sheet = sheets.get(row.sheet_hash)
    if (!sheet) continue
    const how = hourOfWeek(Number(row.hour) * HOUR_S)
    const stat = { tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out), billedHostMicro: BigInt(row.billed), baseIn: sheet.baseIn[how]!, baseOut: sheet.baseOut[how]! }
    hosts.set(row.host, [...(hosts.get(row.host) ?? []), stat])
  }
  for (const [host, stats] of hosts) {
    await stack.db.query(
      `INSERT INTO serving.host_stats (host, day, served_tokens, billed_host_micro, base_value_micro, effective_discount_bps)
       VALUES ($1,(to_timestamp($2) AT TIME ZONE 'UTC')::date,$3,$4,$5,$6)
       ON CONFLICT (host, day) DO UPDATE SET served_tokens = EXCLUDED.served_tokens, billed_host_micro = EXCLUDED.billed_host_micro,
         base_value_micro = EXCLUDED.base_value_micro, effective_discount_bps = EXCLUDED.effective_discount_bps`,
      [
        host,
        day * DAY_S,
        stats.reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0),
        stats.reduce((sum, row) => sum + row.billedHostMicro, 0n).toString(),
        stats.reduce((sum, row) => sum + hostCostMicro(row.tokensIn, row.tokensOut, row.baseIn, row.baseOut), 0n).toString(),
        effectiveDiscountBps(stats),
      ],
    )
  }
}

/** The day so far and the day before, which can still gain records in the hour-close grace. Safe to run again. */
export async function writeHostStats(stack: Stack) {
  const today = Math.floor(stack.clock() / DAY_S)
  await writeDay(stack, today - 1)
  await writeDay(stack, today)
}
