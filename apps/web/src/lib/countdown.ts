import { formatDuration } from "./format.ts"
import { DISPUTE_WINDOW_S, WITHDRAW_ALL_MAX_DELAY_S, hourIndex } from "./shared.ts"

export type WithdrawAll =
  | { phase: "none" }
  | { phase: "waiting"; remaining: number; label: string; elapsedBps: number; dueAt: number }
  | { phase: "ready"; reason: "due" | "settled"; dueAt: number }

/**
 * Mirrors `executeWithdrawAll`: it opens at the 2-hour mark, or sooner once the hour of the
 * request has settled.
 */
export function withdrawAllState(input: { requestedAt: bigint | string; dueAt: bigint | string; lastSettledHour: bigint | string; now: number }): WithdrawAll {
  const requestedAt = Number(BigInt(input.requestedAt))
  if (requestedAt === 0) return { phase: "none" }
  const dueAt = Number(BigInt(input.dueAt)) || requestedAt + WITHDRAW_ALL_MAX_DELAY_S
  if (BigInt(input.lastSettledHour) >= BigInt(hourIndex(requestedAt))) return { phase: "ready", reason: "settled", dueAt }
  if (input.now >= dueAt) return { phase: "ready", reason: "due", dueAt }
  const remaining = dueAt - input.now
  const span = dueAt - requestedAt
  return { phase: "waiting", remaining, label: formatDuration(remaining), elapsedBps: span > 0 ? Math.floor(((span - remaining) * 10_000) / span) : 10_000, dueAt }
}

export type Caps = { hourly: bigint; daily: bigint; pendingHourly: bigint | null; pendingDaily: bigint | null; effectiveAfterHour: bigint | null }

/** A pending row only means a decrease waiting for the next settled hour. */
export function capsState(input: { hourlyCap: string; dailyCap: string; pendingHourlyCap: string; pendingDailyCap: string; capsEffectiveAfterHour: string }): Caps {
  const pending = BigInt(input.capsEffectiveAfterHour) !== 0n
  return {
    hourly: BigInt(input.hourlyCap),
    daily: BigInt(input.dailyCap),
    pendingHourly: pending ? BigInt(input.pendingHourlyCap) : null,
    pendingDaily: pending ? BigInt(input.pendingDailyCap) : null,
    effectiveAfterHour: pending ? BigInt(input.capsEffectiveAfterHour) : null,
  }
}

/** The vault reads a daily cap of 0 as four times the hourly cap. */
export function effectiveDaily(hourly: bigint, daily: bigint) {
  return daily === 0n ? 4n * hourly : daily
}

export function disputeOpen(requestTs: number, now: number) {
  return now - requestTs <= DISPUTE_WINDOW_S
}

/** Seconds between the browser's clock and the server's, added to `Date.now()` for countdowns. */
export function clockOffset(serverTime: number, browserMs: number) {
  return serverTime - Math.floor(browserMs / 1000)
}
