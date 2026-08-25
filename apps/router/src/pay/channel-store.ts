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
        channelPaymentId(channelId, voucher.seq),
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
