import { randomBytes } from "node:crypto"
import { channelPaymentId, type ChannelChain, type Hex } from "@offpeak/shared"
import type { Db } from "@offpeak/common"
import { admitChannel } from "./channel.ts"

/** `unvouchered` is served cost only. In-flight requests hold reservations, which expire on their own. */
export type ChannelLocal = {
  unvouchered: bigint
  pending: string[]
  latestSeq: bigint
  cumulative: bigint
  frozenUntil: number
  closeFinal: bigint | null
  /** A voucher on this channel was good only by the wallet's say-so, whatever key proves its requests. */
  contractVoucher: boolean
}

const RESERVATION_TTL_S = 900
/** `ChannelManager` pays a cooperative close under this sequence number. */
const COOPERATIVE_SEQ = 2n ** 64n - 1n
/** How long a refused close keeps the channel still, so the client can sign the figure it was given. */
export const CLOSE_FREEZE_S = 900

const big = (value: unknown) => BigInt(String(value ?? 0))

async function read(db: Db, channelId: string, forUpdate: boolean): Promise<ChannelLocal> {
  const local = await db.query<{ unvouchered_micro: string; frozen_until: string; close_final: string | null; contract_voucher: boolean | null }>(
    `SELECT unvouchered_micro, frozen_until, close_final, contract_voucher FROM serving.channels_local WHERE channel_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [channelId],
  )
  const state = await db.query<{ latest_seq: string; cumulative: string }>("SELECT latest_seq, cumulative FROM shared.channel_state WHERE channel_id = $1", [channelId])
  const open = await db.query<{ req_ids: string[] }>("SELECT req_ids FROM serving.owed_boundaries WHERE channel_id = $1 ORDER BY cumulative", [channelId])
  const row = local.rows[0]
  return {
    unvouchered: big(row?.unvouchered_micro),
    pending: open.rows.flatMap((r) => r.req_ids),
    latestSeq: big(state.rows[0]?.latest_seq),
    cumulative: big(state.rows[0]?.cumulative),
    frozenUntil: Number(row?.frozen_until ?? 0),
    closeFinal: row?.close_final == null ? null : big(row.close_final),
    contractVoucher: row?.contract_voucher === true,
  }
}

/** Serialises every change to one channel across router instances. Only call inside a transaction. */
async function lock(tx: Db, channelId: string, payer: string) {
  await tx.query(
    `INSERT INTO serving.channels_local (channel_id, payer, unvouchered_micro, last_owed, last_owed_req_ids)
     VALUES ($1,$2,0,0,'{}') ON CONFLICT (channel_id) DO NOTHING`,
    [channelId, payer],
  )
  return read(tx, channelId, true)
}

export function readChannel(db: Db, channelId: string) {
  return read(db, channelId, false)
}

/** A voucher and an x402 payment share one key in `shared.agent_payments`, so each takes it under this lock. */
const lockPaymentId = (tx: Db, paymentId: string) => tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [paymentId])

/**
 * Takes a payment id before anything is served. A buyer picks an x402 `reqId` and can compute a voucher's id,
 * and a collision found at billing would come after the tokens had gone out. `false` means the id is taken.
 */
export async function claimPaymentId(db: Db, claim: { reqId: string; payer: string; amount: bigint; status: "submitted" | "upto"; validBefore: string; now: number }) {
  return db.transaction(async (tx) => {
    await lockPaymentId(tx, claim.reqId)
    const taken = await tx.query("SELECT 1 FROM shared.agent_payments WHERE payment_id = $1", [claim.reqId])
    if (taken.rows.length > 0) return false
    const claimed = await tx.query("INSERT INTO serving.x402_requests (req_id, payer, max_amount, status, valid_before, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (req_id) DO NOTHING RETURNING req_id", [
      claim.reqId,
      claim.payer,
      claim.amount.toString(),
      claim.status,
      claim.validBefore,
      claim.now,
    ])
    return claimed.rows.length > 0
  })
}

/**
 * Takes a voucher whose signature the caller has checked. A voucher the channel has moved past is
 * "stale", which a retrying client can send honestly. Anything but "ok" leaves the channel as it was.
 */
export async function acceptVoucher(db: Db, channel: ChannelChain, channelId: Hex, voucher: { seq: bigint; cumulative: bigint; sig: Hex }, opts?: { contract?: boolean }) {
  return db.transaction(async (tx) => {
    const local = await lock(tx, channelId, channel.payer)
    if (voucher.seq <= local.latestSeq || voucher.cumulative <= local.cumulative) return "stale" as const
    // A signed close already covers this money. Taking the voucher too would count it twice.
    if (local.closeFinal !== null) return "closing" as const
    const boundary = await tx.query("SELECT 1 FROM serving.owed_boundaries WHERE channel_id = $1 AND cumulative = $2", [channelId, voucher.cumulative.toString()])
    if (boundary.rows.length === 0) return "bad_boundary" as const
    const paymentId = channelPaymentId(channelId, voucher.seq)
    await lockPaymentId(tx, paymentId)
    if ((await tx.query("SELECT 1 FROM serving.x402_requests WHERE req_id = $1", [paymentId])).rows.length > 0) return "payment_id_taken" as const
    const paid = await tx.query<{ req_ids: string[] }>("DELETE FROM serving.owed_boundaries WHERE channel_id = $1 AND cumulative <= $2 RETURNING req_ids", [channelId, voucher.cumulative.toString()])
    await tx.query(
      `INSERT INTO shared.channel_state (channel_id, payer, latest_seq, cumulative, voucher_sig)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (channel_id) DO UPDATE SET latest_seq = $3, cumulative = $4, voucher_sig = $5, updated_at = now()`,
      [channelId, channel.payer, voucher.seq.toString(), voucher.cumulative.toString(), voucher.sig],
    )
    await tx.query(
      `INSERT INTO shared.agent_payments (payment_id, kind, payer, amount_micro, req_ids, channel_id, voucher_seq, voucher_sig)
       VALUES ($1,'channel',$2,$3,$4,$5,$6,$7) ON CONFLICT (payment_id) DO NOTHING`,
      [
        paymentId,
        channel.payer,
        (voucher.cumulative - local.cumulative).toString(),
        paid.rows.flatMap((row) => row.req_ids),
        channelId,
        voucher.seq.toString(),
        voucher.sig,
      ],
    )
    const left = local.cumulative + local.unvouchered - voucher.cumulative
    await tx.query("UPDATE serving.channels_local SET unvouchered_micro = $2, contract_voucher = contract_voucher OR $3 WHERE channel_id = $1", [channelId, (left > 0n ? left : 0n).toString(), opts?.contract === true])
    return "ok" as const
  })
}

export async function reserveChannel(db: Db, channel: ChannelChain, channelId: Hex, max: bigint, now: number, opts?: { contractPayer?: boolean }) {
  return db.transaction(async (tx) => {
    const local = await lock(tx, channelId, channel.payer)
    if (local.closeFinal !== null || local.frozenUntil > now) return { ok: false as const, error: "channel_closing" }
    await tx.query("DELETE FROM serving.channel_reservations WHERE channel_id = $1 AND expires_at <= $2", [channelId, now])
    const held = await tx.query<{ total: string | null }>("SELECT SUM(amount) AS total FROM serving.channel_reservations WHERE channel_id = $1", [channelId])
    const decision = admitChannel({
      status: channel.status,
      expiry: Number(channel.expiry),
      closeRequested: channel.closeRequested,
      now,
      deposit: channel.deposit,
      voucherCumulative: local.cumulative,
      unvouchered: local.unvouchered + big(held.rows[0]?.total),
      newMax: max,
      unlanded: (opts?.contractPayer || local.contractVoucher) && local.cumulative > channel.claimed ? local.cumulative - channel.claimed : 0n,
    })
    if (!decision.ok) return decision
    const reservationId = `rsv_${randomBytes(8).toString("hex")}`
    await tx.query("INSERT INTO serving.channel_reservations (id, channel_id, amount, expires_at) VALUES ($1,$2,$3,$4)", [reservationId, channelId, max.toString(), now + RESERVATION_TTL_S])
    return { ...decision, reservationId }
  })
}

export async function releaseChannel(db: Db, reservationId: string) {
  const gone = await db.query<{ channel_id: string }>("DELETE FROM serving.channel_reservations WHERE id = $1 RETURNING channel_id", [reservationId])
  const channelId = gone.rows[0]?.channel_id
  if (channelId) await settleIfClosing(db, channelId)
}

/** Inside the record's transaction: swaps a reservation for the real cost and records what the client may sign. */
export async function noteChannel(tx: Db, payer: string, channelId: Hex, reservationId: string, actual: bigint, reqId: string) {
  const local = await lock(tx, channelId, payer)
  await tx.query("DELETE FROM serving.channel_reservations WHERE id = $1", [reservationId])
  const unvouchered = local.unvouchered + actual
  const owed = local.cumulative + unvouchered
  await tx.query("UPDATE serving.channels_local SET unvouchered_micro = $2, last_owed = $3 WHERE channel_id = $1", [channelId, unvouchered.toString(), owed.toString()])
  await tx.query(
    `INSERT INTO serving.owed_boundaries (channel_id, cumulative, req_ids) VALUES ($1,$2,ARRAY[$3]::text[])
     ON CONFLICT (channel_id, cumulative) DO UPDATE SET req_ids = serving.owed_boundaries.req_ids || EXCLUDED.req_ids`,
    [channelId, owed.toString(), reqId],
  )
  if (local.closeFinal !== null) await settleClose(tx, channelId)
  return owed
}

/** Writes a signed close's payment row once nothing is in flight, so the row names every record it paid for. */
async function settleClose(tx: Db, channelId: string) {
  const local = await tx.query<{ payer: string; close_final: string | null; close_settled: boolean }>("SELECT payer, close_final, close_settled FROM serving.channels_local WHERE channel_id = $1 FOR UPDATE", [channelId])
  const row = local.rows[0]
  if (!row || row.close_final === null || row.close_settled) return
  if ((await tx.query("SELECT 1 FROM serving.channel_reservations WHERE channel_id = $1 LIMIT 1", [channelId])).rows.length > 0) return
  const paid = await tx.query<{ req_ids: string[] }>("DELETE FROM serving.owed_boundaries WHERE channel_id = $1 RETURNING req_ids", [channelId])
  const state = await tx.query<{ latest_seq: string; cumulative: string }>("SELECT latest_seq, cumulative FROM shared.channel_state WHERE channel_id = $1", [channelId])
  const amount = big(row.close_final) - big(state.rows[0]?.cumulative)
  if (amount > 0n) {
    // `voucher_seq` only orders the channel's rows here. The chain's own sequence for a close does not fit a bigint.
    await tx.query(
      `INSERT INTO shared.agent_payments (payment_id, kind, payer, amount_micro, req_ids, channel_id, voucher_seq)
       VALUES ($1,'channel',$2,$3,$4,$5,$6) ON CONFLICT (payment_id) DO NOTHING`,
      [channelPaymentId(channelId, COOPERATIVE_SEQ), row.payer, amount.toString(), paid.rows.flatMap((r) => r.req_ids), channelId, (big(state.rows[0]?.latest_seq) + 1n).toString()],
    )
  }
  await tx.query("UPDATE serving.channels_local SET close_settled = true WHERE channel_id = $1", [channelId])
}

async function settleIfClosing(db: Db, channelId: string) {
  const waiting = await db.query("SELECT 1 FROM serving.channels_local WHERE channel_id = $1 AND close_final IS NOT NULL AND NOT close_settled", [channelId])
  if (waiting.rows.length > 0) await db.transaction((tx) => settleClose(tx, channelId))
}

/** A router that died mid-request leaves a reservation. It expires here, so the close can finish. */
export async function sweepCloses(db: Db, now: number) {
  const rows = await db.query<{ channel_id: string }>("SELECT channel_id FROM serving.channels_local WHERE close_final IS NOT NULL AND NOT close_settled LIMIT 200")
  for (const { channel_id } of rows.rows) {
    await db.query("DELETE FROM serving.channel_reservations WHERE channel_id = $1 AND expires_at <= $2", [channel_id, now])
    await settleIfClosing(db, channel_id)
  }
}

export type CloseRequest = { finalCumulative: bigint; deadline: bigint; payerSig: Hex }
export type CloseDecision = { ok: true } | { ok: false; error: "close_below_owed" | "close_already_signed"; owed: bigint; inFlight: bigint; required: bigint }

/**
 * Stops new requests first, in the transaction that decides, so what is owed cannot grow past the
 * figure checked here. A request already in flight still bills afterwards, and `inFlight` holds its limit.
 * A close that is signed stays final: the channel never serves again, and its amount cannot change.
 */
export async function freezeForClose(db: Db, channel: ChannelChain, channelId: Hex, close: CloseRequest, now: number): Promise<CloseDecision> {
  return db.transaction(async (tx) => {
    const local = await lock(tx, channelId, channel.payer)
    await tx.query("DELETE FROM serving.channel_reservations WHERE channel_id = $1 AND expires_at <= $2", [channelId, now])
    const held = await tx.query<{ total: string | null }>("SELECT SUM(amount) AS total FROM serving.channel_reservations WHERE channel_id = $1", [channelId])
    const inFlight = big(held.rows[0]?.total)
    const owed = local.cumulative + local.unvouchered
    if (local.closeFinal !== null) {
      if (close.finalCumulative !== local.closeFinal) return { ok: false, error: "close_already_signed", owed, inFlight, required: local.closeFinal }
      await tx.query("UPDATE serving.channels_local SET close_deadline = $2, close_payer_sig = $3 WHERE channel_id = $1", [channelId, close.deadline.toString(), close.payerSig])
      return { ok: true }
    }
    await tx.query("UPDATE serving.channels_local SET frozen_until = GREATEST(frozen_until, $2) WHERE channel_id = $1", [channelId, now + CLOSE_FREEZE_S])
    const covered = owed + inFlight
    const required = covered > channel.claimed ? covered : channel.claimed
    if (close.finalCumulative < required) return { ok: false, error: "close_below_owed", owed, inFlight, required }
    await tx.query("UPDATE serving.channels_local SET close_final = $2, close_deadline = $3, close_payer_sig = $4 WHERE channel_id = $1", [
      channelId,
      close.finalCumulative.toString(),
      close.deadline.toString(),
      close.payerSig,
    ])
    await settleClose(tx, channelId)
    return { ok: true }
  })
}

export async function keepRouterSig(db: Db, channelId: Hex, routerSig: Hex) {
  await db.query("UPDATE serving.channels_local SET close_router_sig = $2 WHERE channel_id = $1", [channelId, routerSig])
}
