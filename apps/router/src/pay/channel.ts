import { CHANNEL_CHALLENGE_S, CHANNEL_CREDIT_CAP_MICRO, CHANNEL_CREDIT_DEPOSIT_BPS } from "@offpeak/shared"

export function creditLimit(deposit: bigint): bigint {
  const pct = (deposit * BigInt(CHANNEL_CREDIT_DEPOSIT_BPS)) / 10_000n
  return pct < CHANNEL_CREDIT_CAP_MICRO ? pct : CHANNEL_CREDIT_CAP_MICRO
}

export type ChannelAdmitInput = {
  status: number
  expiry: number
  closeRequested: boolean
  now: number
  deposit: bigint
  voucherCumulative: bigint
  unvouchered: bigint
  newMax: bigint
  /** Vouchers from a contract wallet that are not on chain yet. Its answer can change before they land. */
  unlanded?: bigint
}

export function admitChannel(input: ChannelAdmitInput): { ok: true; limit: bigint } | { ok: false; error: string } {
  if (input.status !== 1) return { ok: false, error: "channel_not_open" }
  if (input.closeRequested) return { ok: false, error: "channel_closing" }
  if (input.expiry <= input.now + CHANNEL_CHALLENGE_S) return { ok: false, error: "channel_near_expiry" }
  const limit = creditLimit(input.deposit)
  if (input.unvouchered + (input.unlanded ?? 0n) + input.newMax > limit) return { ok: false, error: "credit_limit" }
  if (input.voucherCumulative + input.unvouchered + input.newMax > input.deposit) return { ok: false, error: "deposit_exhausted" }
  return { ok: true, limit }
}
