import type {
  BuyerChain,
  ChainPush,
  ChallengeChain,
  ChainReader,
  ChannelChain,
  EscrowChain,
  Hex,
  HolderView,
  HostChain,
  OfpkChain,
  ProofChain,
  WindowView,
} from "@offpeak/shared"
import { keccak256, toBytes } from "viem"

type Fields = Record<string, unknown>

const big = (value: unknown) => BigInt(String(value ?? 0))

function parseBuyer(row: Fields, now: number): BuyerChain {
  return {
    balance: big(row.balance),
    reserve: big(row.reserve),
    hourlyCap: big(row.hourlyCap),
    dailyCap: big(row.dailyCap),
    pendingHourlyCap: big(row.pendingHourlyCap),
    pendingDailyCap: big(row.pendingDailyCap),
    capsEffectiveAfterHour: big(row.capsEffectiveAfterHour),
    withdrawRequestedAt: big(row.withdrawRequestedAt),
    withdrawDueAt: big(row.withdrawDueAt),
    lastSettledHour: big(row.lastSettledHour),
    usagePaused: Boolean(row.usagePaused),
    servable: Boolean(row.servable),
    ...(row.reason ? { reason: row.reason as BuyerChain["reason"] } : {}),
    fetchedAt: now,
  }
}

function parseHost(row: Fields, endpoint: string): HostChain {
  return {
    operator: row.operator as Hex,
    status: Number(row.status) as HostChain["status"],
    bondUsdg: big(row.bondUsdg),
    bondOfpk: big(row.bondOfpk),
    requiredBond: big(row.requiredBond),
    imageDigest: row.imageDigest as Hex,
    gpuClass: row.gpuClass as Hex,
    attestationRef: row.attestationRef as Hex,
    probationEnds: big(row.probationEnds),
    strikes: Number(row.strikes),
    openChallenges: Number(row.openChallenges),
    releasableCredits: big(row.releasableCredits),
    pendingCredits: big(row.pendingCredits),
    models: (row.models as { digest: Hex; maxTps: number }[]).map((m) => ({ digest: m.digest, maxTps: Number(m.maxTps) })),
    routable: Boolean(row.routable),
    routingBonusBps: Number(row.routingBonusBps ?? 0),
    endpointHash: row.endpointHash as Hex,
    endpoint,
  }
}

function parseChannel(row: Fields): ChannelChain {
  return {
    payer: row.payer as Hex,
    deposit: big(row.deposit),
    claimed: big(row.claimed),
    lastSeq: big(row.lastSeq),
    expiry: big(row.expiry),
    challengeEndsAt: big(row.challengeEndsAt),
    status: Number(row.status) as ChannelChain["status"],
    closeRequested: Boolean(row.closeRequested),
  }
}

function parseWindow(row: Fields): WindowView {
  const out: Fields = { ...row }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && /^\d+$/.test(value)) out[key] = BigInt(value)
  }
  return out as WindowView
}

type Slot<T> = { value: T; at: number }

const CACHE_MAX = 50_000
const OVERLAY_TTL_MS = 15 * 60_000
const FROZEN_OR_DELISTED = new Set([3, 5])

function remember<T>(cache: Map<string, Slot<T>>, key: string, slot: Slot<T>) {
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, slot)
}

/** Short caches keep the request path off the network. A push for a key drops it at once. */
export class LiveChain implements ChainReader {
  private buyers = new Map<string, Slot<BuyerChain>>()
  private channels = new Map<string, Slot<ChannelChain | null>>()
  private ofpks = new Map<string, Slot<OfpkChain | null>>()
  private hosts: Slot<HostChain[]> | null = null
  private hostsLoading: Promise<HostChain[]> | null = null
  private generation = 0
  // A tightening push beats the indexer's confirmed view, which can lag it by minutes.
  private withdrawing = new Map<string, { requestedAt: bigint; dueAt: bigint; at: number; block: number }>()
  private lowered = new Map<string, { hourly: bigint; daily: bigint; after: bigint; at: number; block: number }>()
  private closing = new Map<string, { at: number; block: number }>()
  private frozen = new Map<string, { status: number; at: number; block: number }>()
  private paused: { value: boolean; at: number; block: number } | null = null
  private listeners = new Set<(msg: ChainPush) => void>()

  constructor(
    private opts: {
      url: string
      token: string
      endpointOf: (host: string) => string | undefined
      buyerTtlMs?: number
      channelTtlMs?: number
      hostTtlMs?: number
      timeoutMs?: number
    },
  ) {}

  private live(at: number) {
    return performance.now() - at < OVERLAY_TTL_MS
  }

  private applyBuyer(key: string, view: BuyerChain): BuyerChain {
    const out = { ...view }
    const leaving = this.withdrawing.get(key)
    if (leaving && this.live(leaving.at) && out.withdrawRequestedAt === 0n) {
      out.withdrawRequestedAt = leaving.requestedAt
      out.withdrawDueAt = leaving.dueAt
    }
    const lower = this.lowered.get(key)
    if (lower && this.live(lower.at)) {
      const pending = out.capsEffectiveAfterHour !== 0n
      out.pendingHourlyCap = pending && out.pendingHourlyCap < lower.hourly ? out.pendingHourlyCap : lower.hourly
      out.pendingDailyCap = pending && out.pendingDailyCap < lower.daily ? out.pendingDailyCap : lower.daily
      out.capsEffectiveAfterHour = out.capsEffectiveAfterHour > lower.after ? out.capsEffectiveAfterHour : lower.after
    }
    if (this.paused && this.live(this.paused.at)) out.usagePaused = this.paused.value
    if (out.usagePaused) return { ...out, servable: false, reason: "paused" }
    if (out.withdrawRequestedAt !== 0n) return { ...out, servable: false, reason: "withdraw_requested" }
    return out
  }

  private async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.opts.url}${path}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3_000),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`indexer ${path}: ${res.status}`)
    return ((await res.json()) as { data: T }).data
  }

  private fresh<T>(slot: Slot<T> | null | undefined, ttlMs: number) {
    return slot && performance.now() - slot.at < ttlMs ? slot : null
  }
