import type { Hex } from "viem"

export type BuyerView = {
  balance: bigint
  reserve: bigint
  hourlyCap: bigint
  dailyCap: bigint
  pendingHourlyCap: bigint
  pendingDailyCap: bigint
  capsEffectiveAfterHour: bigint
  withdrawRequestedAt: bigint
  withdrawDueAt: bigint
  lastSettledHour: bigint
  usagePaused: boolean
}

export type HostStatus = 0 | 1 | 2 | 3 | 4 | 5

export type HostView = {
  operator: Hex
  status: HostStatus
  bondUsdg: bigint
  bondOfpk: bigint
  requiredBond: bigint
  imageDigest: Hex
  gpuClass: Hex
  attestationRef: Hex
  probationEnds: bigint
  strikes: number
  openChallenges: number
  releasableCredits: bigint
  pendingCredits: bigint
}

export type ChannelStatus = 0 | 1 | 2 | 3

export type ChannelView = {
  payer: Hex
  deposit: bigint
  claimed: bigint
  lastSeq: bigint
  expiry: bigint
  challengeEndsAt: bigint
  status: ChannelStatus
}

export type WindowView = {
  id: bigint
  host: Hex
  modelDigest: Hex
  t0: bigint
  t1: bigint
  minTps: number
  units: bigint
  hostPricePerUnit: bigint
  buyerPricePerUnit: bigint
  failed: boolean
}

export type HolderView = {
  balance: bigint
  lockedPartial: bigint
  drawnTokens: bigint
  costBasis: bigint
}

export type EvidenceKind = 0 | 1 | 2 | 3

export type Evidence = {
  host: Hex
  kind: EvidenceKind
  modelDigest: Hex
  samplesRoot: Hex
  sampleCount: number
  testId: Hex
  statistic: bigint
  threshold: bigint
  uri: string
}

export const HOST_STATUS = {
  None: 0,
  Probation: 1,
  Active: 2,
  Frozen: 3,
  Exiting: 4,
  Delisted: 5,
} as const

export const CHANNEL_STATUS = {
  None: 0,
  Open: 1,
  Closing: 2,
  Closed: 3,
} as const

export const EVIDENCE_KIND = {
  Swap: 0,
  Throughput: 1,
  Metering: 2,
  Canary: 3,
} as const
