import type { Hex } from "viem"
import type { Slot } from "./forecast.ts"
import type { Flags } from "./labels.ts"

export type Tx = { to: Hex; data: Hex; value: "0"; chainId: number }
export type Approval = { token: Hex; spender: Hex; amount: string; tx: Tx }
export type Plan = { approval: Approval; tx: Tx }

export type Status = { features: Flags; health: { router: string; hosts: number } }

export type Network = {
  chainId: number
  deployed: boolean
  vault: Hex
  usdg: Hex
  permit2: Hex
  registry: Hex
  usageLedger: Hex
  channelManager: Hex
  windowMarket: Hex
  routerSigner: Hex
  channelPayee: Hex
  serverTime: number
}

export type ModelRow = { id: string; offpeak: { kind?: "chat" | "embeddings"; digest: Hex; context_length: number; hosts: number; live_price_from: { in: string; out: string } | null; sealed_available: boolean } }

export type Leg = { in: string; out: string }

export type Board = {
  model: string
  digest: Hex
  feeBps: number
  serverTime: number
  now: (Leg & { host: Hex }) | null
  hosts: {
    host: Hex
    status: number
    routable: boolean
    strikes: number
    bond: string
    live: Leg
    base: Leg
    floor: Leg
    effective_discount_30d_bps: number | null
    sealed: boolean
  }[]
  next168h: Slot[]
  forecastFromHistory: boolean
}

export type Summary = {
  wallet: Hex
  serverTime: number
  balance: string
  reserve: string
  withdrawable: string
  hourlyCap: string
  dailyCap: string
  pendingHourlyCap: string
  pendingDailyCap: string
  capsEffectiveAfterHour: string
  withdrawRequestedAt: string
  withdrawDueAt: string
  lastSettledHour: string
  usagePaused: boolean
  servable: boolean
  reason: "withdraw_requested" | "paused" | "no_balance" | "no_caps" | null
  auditOptIn: boolean
  feeBps: number
  betaCap: string | null
}

export type ApiKey = { id: string; accountId: string; label: string; rpm: number; audit: boolean; createdAt: number }

export type Channel = {
  id: Hex
  deposit: string
  claimed: string
  cumulative: string
  owed: string
  latestSeq: string
  status: number
  expiry: string
  challengeEndsAt: string
  closeRequested: boolean
}

export type WindowRow = {
  id: string
  host: Hex
  modelDigest: Hex
  model: string | null
  t0: number
  t1: number
  minTps: number
  units: string
  hostPricePerUnit: string
  buyerPricePerUnit: string
  failed: boolean
}

export type Holding = { id: string; balance: string; lockedPartial: string; drawnTokens: string; costBasis: string }

export type Listing = { listingId: bigint; id: bigint; seller: Hex; units: bigint; pricePerUnit: bigint }

export type HostMe = {
  wallet: Hex
  serverTime: number
  host: {
    operator: Hex
    status: number
    routable: boolean
    bondUsdg: string
    bondOfpk: string
    requiredBond: string
    probationEnds: string
    strikes: number
    openChallenges: number
    releasableCredits: string
    pendingCredits: string
    models: { digest: Hex; maxTps: number }[]
  } | null
}

export type Payouts = { releasable: string; pending: string; strikes: number; served: { hour: number; tokens: string; records: number }[] }

export type Challenge = { id: string; host: string; kind: number; state: number; slashBps: number; filedAt: number; reviewEndsAt: number; respondBy: number }

export type Dispute = { id: string; reqIds: string[]; reason: string; status: string; outcome: string | null; refundId: string | null; refundMicro: string; createdAt: number }

export type PermitPlan = {
  approval: Approval
  tx: Tx | null
  permit: {
    domain: { name: string; chainId: number; verifyingContract: Hex }
    types: Record<string, readonly { name: string; type: string }[]>
    primaryType: "PermitTransferFrom"
    message: { permitted: { token: Hex; amount: string }; spender: Hex; nonce: string; deadline: string }
  } | null
}
