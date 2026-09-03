import type { Db } from "@offpeak/common"

export type BuyerRow = {
  balance: string
  hourly_cap: string
  daily_cap: string
  pending_hourly_cap: string
  pending_daily_cap: string
  caps_effective_after_hour: string
  withdraw_requested_at: string
}

export type VaultState = { lastSettledHour: bigint; usagePaused: boolean }

const WITHDRAW_ALL_MAX_DELAY_S = 7200n
const HOST_MIN_BOND = 2_000_000_000n
const REQUIRED_BOND_BPS = 2_000n
const RING_DAYS = 30n

const min = (a: bigint, b: bigint) => (a < b ? a : b)

export async function readVaultState(db: Db): Promise<VaultState> {
  const rows = await db.query<{ last_settled_hour: string; usage_paused: boolean }>("SELECT * FROM chain.vault_state")
  const row = rows.rows[0]
  return { lastSettledHour: BigInt(row?.last_settled_hour ?? 0), usagePaused: row?.usage_paused ?? false }
}

function foldedCaps(row: BuyerRow, lastSettledHour: bigint) {
  const after = BigInt(row.caps_effective_after_hour)
  const due = after !== 0n && lastSettledHour >= after
  return {
    hourlyCap: BigInt(due ? row.pending_hourly_cap : row.hourly_cap),
    dailyCap: BigInt(due ? row.pending_daily_cap : row.daily_cap),
    decreasePending: after !== 0n && !due,
  }
}

/** The vault's reserve formula, cross-checked against `reserveOf` by `crossCheckBuyers`. */
export function reserveOf(row: BuyerRow, vault: VaultState, now: number): bigint {
  const balance = BigInt(row.balance)
  if (balance === 0n) return 0n
  const requestedAt = BigInt(row.withdraw_requested_at)
  const lastHour = (requestedAt !== 0n ? requestedAt : BigInt(now)) / 3600n
  if (lastHour <= vault.lastSettledHour) return 0n
  const openHours = lastHour - vault.lastSettledHour
  const openDays = lastHour / 24n - (vault.lastSettledHour + 1n) / 24n + 1n
  const { hourlyCap, dailyCap } = foldedCaps(row, vault.lastSettledHour)
  return min(balance, min(hourlyCap * openHours, dailyCap * openDays))
}

export function buyerView(row: BuyerRow, vault: VaultState, now: number) {
  const { hourlyCap, dailyCap, decreasePending } = foldedCaps(row, vault.lastSettledHour)
  const requestedAt = BigInt(row.withdraw_requested_at)
  const balance = BigInt(row.balance)
  const reason = vault.usagePaused
    ? "paused"
    : requestedAt !== 0n
      ? "withdraw_requested"
      : balance <= 0n
        ? "no_balance"
        : hourlyCap <= 0n
          ? "no_caps"
          : undefined
  return {
    balance,
    reserve: reserveOf(row, vault, now),
    hourlyCap,
    dailyCap,
    pendingHourlyCap: decreasePending ? BigInt(row.pending_hourly_cap) : 0n,
    pendingDailyCap: decreasePending ? BigInt(row.pending_daily_cap) : 0n,
    capsEffectiveAfterHour: decreasePending ? BigInt(row.caps_effective_after_hour) : 0n,
    withdrawRequestedAt: requestedAt,
    withdrawDueAt: requestedAt !== 0n ? requestedAt + WITHDRAW_ALL_MAX_DELAY_S : 0n,
    lastSettledHour: vault.lastSettledHour,
    usagePaused: vault.usagePaused,
    unsettledHours: BigInt(Math.floor(now / 3600)) - vault.lastSettledHour,
    servable: reason === undefined,
    ...(reason ? { reason } : {}),
  }
}
