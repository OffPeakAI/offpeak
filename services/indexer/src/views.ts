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

export async function emptyBuyerRow(): Promise<BuyerRow> {
  return {
    balance: "0",
    hourly_cap: "0",
    daily_cap: "0",
    pending_hourly_cap: "0",
    pending_daily_cap: "0",
    caps_effective_after_hour: "0",
    withdraw_requested_at: "0",
  }
}

/** Required bond counts credits over the same 30-day window as the registry's ring; rewards stay out. */
export async function requiredBond(db: Db, host: string, now: number) {
  const day = BigInt(now) / 86_400n
  const rows = await db.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM chain.host_credits
     WHERE host = $1 AND kind = 'credit' AND accrued_at / 86400 > $2`,
    [host, (day - RING_DAYS).toString()],
  )
  const required = (BigInt(rows.rows[0]?.total ?? 0) * REQUIRED_BOND_BPS) / 10_000n
  return required > HOST_MIN_BOND ? required : HOST_MIN_BOND
}

export async function hostView(db: Db, address: string, now: number) {
  const hosts = await db.query<Record<string, string>>("SELECT * FROM chain.hosts WHERE address = $1", [address])
  const host = hosts.rows[0]
  if (!host) return null
  const models = await db.query<{ digest: string; max_tps: string | number }>("SELECT digest, max_tps FROM chain.host_models WHERE host = $1 ORDER BY digest", [address])
  const credits = await db.query<{ releasable: string | null; pending: string | null }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE releasable_at <= $2), 0) AS releasable,
       COALESCE(SUM(amount) FILTER (WHERE releasable_at > $2), 0) AS pending
     FROM chain.host_credits WHERE host = $1 AND state = 'open'`,
    [address, now],
  )
  const required = await requiredBond(db, address, now)
  const bondUsdg = BigInt(host.bond_usdg!)
  return {
    operator: address,
    status: Number(host.status),
    bondUsdg,
    bondOfpk: BigInt(host.bond_ofpk!),
    requiredBond: required,
    imageDigest: host.image_digest,
    gpuClass: host.gpu_class,
    attestationRef: host.attestation_ref,
    probationEnds: BigInt(host.probation_ends!),
    strikes: Number(host.strikes),
    openChallenges: Number(host.open_challenges),
    releasableCredits: BigInt(credits.rows[0]?.releasable ?? 0),
    pendingCredits: BigInt(credits.rows[0]?.pending ?? 0),
    models: models.rows.map((m) => ({ digest: m.digest, maxTps: Number(m.max_tps) })),
    routable: Number(host.status) === 2 && bondUsdg >= required,
    routingBonusBps: 0,
    endpointHash: host.endpoint_hash,
  }
}

export type ChannelRow = {
  payer: string
  deposit: string
  claimed: string
  last_seq: string
  expiry: string
  challenge_ends_at: string
  status: number
}

export function channelView(row: ChannelRow) {
  const status = Number(row.status)
  return {
    payer: row.payer,
    deposit: BigInt(row.deposit),
    claimed: BigInt(row.claimed),
    lastSeq: BigInt(row.last_seq),
    expiry: BigInt(row.expiry),
    challengeEndsAt: BigInt(row.challenge_ends_at),
    status,
    closeRequested: status === 2,
  }
}

export type EscrowRow = { max_amount: string; captured: string; status: string; tx_hash: string }

export function escrowView(row?: EscrowRow) {
  if (!row) return { status: "none", maxAmount: 0n, captured: 0n, txHash: null }
  return { status: row.status, maxAmount: BigInt(row.max_amount), captured: BigInt(row.captured), txHash: row.tx_hash }
}
