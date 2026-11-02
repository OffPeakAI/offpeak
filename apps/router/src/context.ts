import type { Db } from "@offpeak/common"
import type { ChainReader, Hex, Keyed, PaymentClient, PaymentPayload } from "@offpeak/shared"
import type { PrivateKeyAccount } from "viem/accounts"
import type { TokenizerSource } from "./metering/tokenize.ts"
import type { HoldView } from "./pay/prepaid.ts"
import type { SigVerdict, WalletChain } from "./pay/signatures.ts"
import type { WindowPerf } from "./pay/window-perf.ts"
import type { LoadMeter } from "./pricing/load.ts"
import type { PriceSheet } from "./pricing/pricebook.ts"
import type { AttestBook } from "./routing/attest.ts"
import type { HostCandidate } from "./routing/select.ts"

export const FLAGS = {
  channels: true,
  upto: true,
  night_jobs: true,
  windows: true,
  // Off until a real TDX host with a GPU has passed end to end. Fake attestation cannot turn this on.
  sealed: false,
  token_hooks: false,
  beta_cap: true,
}

/** A feature is on only once its contracts are deployed. Night jobs ship with P2. */
export function deployedFlags(contracts: Record<string, string | undefined>) {
  const live = (name: string) => /^0x[0-9a-fA-F]{40}$/.test(contracts[name] ?? "") && BigInt(contracts[name]!) !== 0n
  const channels = FLAGS.channels && live("ChannelManager")
  const upto = FLAGS.upto && live("X402Escrow")
  return { ...FLAGS, channels, upto, night_jobs: FLAGS.night_jobs && channels && upto, windows: FLAGS.windows && live("WindowMarket") }
}

export type StoredSheet = PriceSheet & { sig: Hex; sheetHash: Hex }

export type Holds = {
  admit(wallet: string, amount: bigint, view: HoldView, holdId: string, now: number, ttl?: number, fromHold?: string): Promise<{ ok: true } | { ok: false; error: string }>
  capture(wallet: string, holdId: string, actual: bigint, hour: number): Promise<void>
  release(wallet: string, holdId: string): Promise<void>
  /** Unsettled spend plus open holds. */
  committed(wallet: string, lastSettledHour: bigint): Promise<bigint>
}

/** Shared counters: rate limits and Window draws not yet settled. */
export type Counters = {
  add(key: string, by: bigint, ttlSeconds: number): Promise<bigint>
  get(key: string): Promise<bigint>
}

/** Reaches a host by address, over HTTP in production. */
export type HostLink = {
  request(host: string, endpoint: string, path: string, init: RequestInit): Promise<Response>
}

export type ModelEntry = {
  name: string
  digest: Hex
  contextLength: number
  kind: "chat" | "embeddings"
  tokenizer?: TokenizerSource
  /** Ciphertext bytes per token seen for this model. Sealed records outside this range are flagged. */
  sealedBytesPerToken?: { low: number; high: number }
}

export type Stack = {
  clock: () => number
  setClock: (n: number) => void
  ledger: Holds
  counters: Counters
  indexer: ChainReader
  facilitator: PaymentClient
  hosts: HostLink
  models: ModelEntry[]
  sheets: StoredSheet[]
  load: LoadMeter
  router: PrivateKeyAccount & Keyed
  /** Signs cooperative closes. Absent means close is refused, and buyers use the challenge path. */
  payee?: PrivateKeyAccount & Keyed
  db: Db
  probesOk: Set<string>
  /** Models each host takes night jobs on, from its last probe. Absent means every host does. */
  nightModels?: Map<string, Set<string>>
  ttftFailoverMs: number
  preconfirmTimeoutMs: number
  usageLedger: string
  registry: string
  vault: string
  channelManager: string
  channelPayee: string
  escrow: string
  windowMarket: string
  auditCourt?: string
  usdg: string
  permit2: Hex
  webDist?: string
  log: string[]
  preHostMs: number[]
  authWaiters: Map<string, Array<(kind: string) => void>>
  authResults: Map<string, "ok" | "fail">
  /** Absent means contract wallets cannot be checked, so their signatures are refused. */
  wallets?: WalletChain
  windowPerf: WindowPerf
  /** Share of a host's capacity kept for Window holders, by `host:modelDigest`. */
  windowShares: Map<string, number>
  flags: { [K in keyof typeof FLAGS]: boolean }
  /** Absent means no host is sealed-verified. */
  attest?: AttestBook
  internalToken?: string
  production: boolean
  /** Proxies in front of the router that append to `X-Forwarded-For`. Zero or absent means callers connect directly. */
  proxyHops?: number
  siweDomain?: string
  candidateCache: Map<string, { at: number; rows: HostCandidate[] }>
  serverTtftMs?: number[]
  hostWaitMs?: number[]
}

export type Payer =
  | { mode: 0; accountId: string; wallet: Hex; feeBps: number }
  | { mode: 1 | 2; wallet: Hex; payment: PaymentPayload; feeBps: number }
  | { mode: 3; wallet: Hex; channelId: Hex; feeBps: number; voucher?: { seq: bigint; cumulative: bigint; sig: Hex }; proof?: { ts: number; nonce: string; sig: Hex }; proved?: SigVerdict }
  | { mode: 4; wallet: Hex; windowId: bigint; accountId: string; prepaidFeeBps: number }

export type PayHold =
  | { kind: "prepaid"; holdId: string; wallet: Hex; max: bigint; payRef: Hex }
  | { kind: "channel"; channelId: Hex; reservationId: string; wallet: Hex; max: bigint; payRef: Hex }
  | { kind: "upto"; wallet: Hex; max: bigint; payRef: Hex; reqId?: string }
  | { kind: "exact"; wallet: Hex; max: bigint; payRef: Hex; paid: bigint }
  | { kind: "window"; wallet: Hex; max: bigint; payRef: Hex; windowId: bigint; pendingKey: string; reservedTokens: bigint }
  | { kind: "none"; wallet: Hex; max: bigint; payRef: Hex }
