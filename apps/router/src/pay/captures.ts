import { X402_EXPIRY_GRACE_S } from "@offpeak/shared"
import type { Db } from "@offpeak/common"
import type { Stack } from "../context.ts"

const SWEEP_AGE_S = 5
/** A request cannot run longer than this, so a row still `submitted` then was lost to a crash. */
const EXACT_LOST_AFTER_S = 900

type Capture = { reqId: string; kind: "prepaid" | "upto"; wallet: string; holdId: string; hour: number; amount: bigint }

/** Written in the record's transaction, so a final record always leaves a capture to finish. */
export async function queueCapture(tx: Db, row: Capture) {
  await tx.query("INSERT INTO serving.pending_captures (req_id, kind, wallet, hold_id, hour, amount) VALUES ($1,$2,$3,$4,$5,$6)", [
    row.reqId,
    row.kind,
    row.wallet,
    row.holdId,
    row.hour,
    row.amount.toString(),
  ])
}

async function finish(stack: Stack, row: { req_id: string; kind: string; wallet: string; hold_id: string; hour: string; amount: string }) {
  if (row.kind === "prepaid") await stack.ledger.capture(row.wallet, row.hold_id, BigInt(row.amount), Number(row.hour))
  else await stack.facilitator.capture(row.hold_id, BigInt(row.amount))
  await stack.db.query("DELETE FROM serving.pending_captures WHERE req_id = $1", [row.req_id])
}

/** One attempt now. Whatever fails stays queued for the sweep; both captures are safe to repeat. */
export async function flushCapture(stack: Stack, reqId: string) {
  const rows = await stack.db.query<Parameters<typeof finish>[1]>("SELECT * FROM serving.pending_captures WHERE req_id = $1", [reqId])
  if (!rows.rows[0]) return
  await finish(stack, rows.rows[0]).catch((err) => console.error(JSON.stringify({ service: "router", event: "capture_deferred", reqId, error: String(err) })))
}

export async function sweepCaptures(stack: Stack) {
  const rows = await stack.db.query<Parameters<typeof finish>[1]>("SELECT * FROM serving.pending_captures WHERE created_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 500", [SWEEP_AGE_S])
  for (const row of rows.rows) {
    await finish(stack, row).catch((err) => console.error(JSON.stringify({ service: "router", event: "capture_deferred", reqId: row.req_id, error: String(err) })))
  }
}

/**
 * `exact` takes the money before serving, so a request that was never served owes it back. The chain
 * decides: what it took becomes a refund, whatever amount was noted here, and a payment past its expiry with nothing taken is dropped.
 */
export async function sweepExact(stack: Stack) {
  const now = stack.clock()
  const rows = await stack.db.query<{ req_id: string; payer: string; valid_before: string }>(
    "SELECT req_id, payer, valid_before FROM serving.x402_requests WHERE status = 'refund_due' OR (status = 'submitted' AND created_at <= $1) LIMIT 200",
    [now - EXACT_LOST_AFTER_S],
  )
  for (const row of rows.rows) {
    const escrow = await stack.indexer.escrow(row.req_id).catch(() => null)
    if (escrow?.status === "captured") {
      await stack.db.transaction(async (tx) => {
        await tx.query("INSERT INTO shared.refunds (id, payer, amount, reason, req_ids) VALUES ($1,$2,$3,'exact_unserved',$4) ON CONFLICT (id) DO NOTHING", [`exact-unserved:${row.req_id}`, row.payer, escrow.captured.toString(), [row.req_id]])
        await tx.query("UPDATE serving.x402_requests SET status = 'refunded' WHERE req_id = $1", [row.req_id])
      })
    } else if (now > Number(row.valid_before) + X402_EXPIRY_GRACE_S) {
      await stack.db.query("UPDATE serving.x402_requests SET status = 'unpaid' WHERE req_id = $1", [row.req_id])
    }
  }
}
