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

  async buyer(addr: string, now: number) {
    const key = addr.toLowerCase()
    const cached = this.fresh(this.buyers.get(key), this.opts.buyerTtlMs ?? 2_000)
    if (cached) return this.applyBuyer(key, cached.value)
    const generation = this.generation
    const value = parseBuyer((await this.get<Fields>(`/idx/v1/buyers/${key}`)) ?? {}, now)
    if (generation === this.generation) remember(this.buyers, key, { value, at: performance.now() })
    return this.applyBuyer(key, value)
  }

  private async loadHosts() {
    const generation = this.generation
    const rows = (await this.get<Fields[]>("/idx/v1/hosts")) ?? []
    const value = rows.map((row) => {
      const stored = this.opts.endpointOf(String(row.operator)) ?? ""
      // The chain holds the endpoint's hash. A stored endpoint that disagrees with it is never used.
      return parseHost(row, stored && keccak256(toBytes(stored)) === row.endpointHash ? stored : "")
    })
    if (generation === this.generation) this.hosts = { value, at: performance.now() }
    return value
  }

  async hostList() {
    const cached = this.fresh(this.hosts, this.opts.hostTtlMs ?? 5_000)
    const rows =
      cached?.value ??
      (await (this.hostsLoading ??= this.loadHosts().finally(() => {
        this.hostsLoading = null
      })))
    if (this.frozen.size === 0) return rows
    return rows.map((row) => {
      const held = this.frozen.get(row.operator.toLowerCase())
      return !held || !this.live(held.at) ? row : { ...row, status: held.status as HostChain["status"], routable: false }
    })
  }

  async host(addr: string) {
    const key = addr.toLowerCase()
    return (await this.hostList()).find((row) => row.operator.toLowerCase() === key) ?? null
  }

  async channel(id: string) {
    const key = id.toLowerCase()
    const cached = this.fresh(this.channels.get(key), this.opts.channelTtlMs ?? 2_000)
    const generation = this.generation
    const value = cached ? cached.value : await this.get<Fields>(`/idx/v1/channels/${key}`).then((row) => (row ? parseChannel(row) : null))
    if (!cached && generation === this.generation) remember(this.channels, key, { value, at: performance.now() })
    const closing = this.closing.get(key)
    return value && closing && this.live(closing.at) ? { ...value, closeRequested: true } : value
  }

  async escrow(reqId: string): Promise<EscrowChain | null> {
    const row = await this.get<Fields>(`/idx/v1/escrows/${reqId}`)
    if (!row) return null
    return { status: row.status as EscrowChain["status"], maxAmount: big(row.maxAmount), captured: big(row.captured), txHash: (row.txHash as string) ?? null }
  }

  async window(id: string) {
    const row = await this.get<Fields>(`/idx/v1/windows/${id}`)
    return row ? parseWindow(row) : null
  }

  async windowList() {
    return ((await this.get<Fields[]>("/idx/v1/windows")) ?? []).map(parseWindow)
  }

  async holder(id: string, addr: string) {
    const row = await this.get<Fields>(`/idx/v1/windows/${id}/holders/${addr.toLowerCase()}`)
    return row ? (parseWindow(row) as unknown as HolderView) : null
  }

  async ofpkOf(addr: string) {
    const key = addr.toLowerCase()
    const cached = this.fresh(this.ofpks.get(key), 60_000)
    if (cached) return cached.value
    const value = await this.get<OfpkChain>(`/idx/v1/ofpk/${key}`)
    remember(this.ofpks, key, { value, at: performance.now() })
    return value
  }

  proof(reqId: string) {
    return this.get<ProofChain>(`/idx/v1/usage/${reqId}/proof`)
  }

  async challengesOf(host: string): Promise<ChallengeChain[]> {
    const rows = (await this.get<Fields[]>(`/idx/v1/challenges?host=${host.toLowerCase()}`)) ?? []
    return rows.map((row) => ({
      id: String(row.id),
      host: String(row.host),
      kind: Number(row.kind),
      state: Number(row.state),
      slashBps: Number(row.slash_bps ?? 0),
      filedAt: Number(row.filed_at ?? 0),
      reviewEndsAt: Number(row.review_ends_at ?? 0),
    }))
  }

  subscribe(fn: (msg: ChainPush) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Feeds one push from Redis. Cached views drop first, so listeners read fresh state. */
  push(msg: ChainPush) {
    this.generation += 1
    const buyer = typeof msg.buyer === "string" ? msg.buyer.toLowerCase() : null
    const channel = typeof msg.channelId === "string" ? msg.channelId.toLowerCase() : null
    const host = typeof msg.host === "string" ? msg.host.toLowerCase() : null
    const at = performance.now()
    if (buyer) this.buyers.delete(buyer)
    if (channel) this.channels.delete(channel)
    if (host) this.hosts = null
    if (msg.type === "Settled") this.buyers.clear()
    // A confirmed event can arrive long after a newer fast-lane one. Only a later block may undo a tightening.
    const block = Number(msg.block ?? Number.MAX_SAFE_INTEGER)
    const undoes = (row: { block: number } | undefined) => !row || block >= row.block
    if (buyer && msg.type === "WithdrawAllRequested") this.withdrawing.set(buyer, { requestedAt: big(msg.requestedAt), dueAt: big(msg.dueAt), at, block })
    if (buyer && (msg.type === "WithdrawAllCancelled" || msg.type === "WithdrawAllExecuted") && undoes(this.withdrawing.get(buyer))) this.withdrawing.delete(buyer)
    if (buyer && msg.type === "CapsChangeRequested") {
      const held = this.lowered.get(buyer)
      const hourly = big(msg.hourlyCap)
      const daily = big(msg.dailyCap)
      this.lowered.set(buyer, {
        hourly: held && held.hourly < hourly ? held.hourly : hourly,
        daily: held && held.daily < daily ? held.daily : daily,
        after: big(msg.effectiveAfterHour),
        at,
        block,
      })
    }
    if (buyer && msg.type === "CapsChanged" && undoes(this.lowered.get(buyer))) this.lowered.delete(buyer)
    if (channel && msg.type === "CloseRequested") this.closing.set(channel, { at, block })
    if (host && msg.type === "HostStatusChanged") {
      if (FROZEN_OR_DELISTED.has(Number(msg.status))) this.frozen.set(host, { status: Number(msg.status), at, block })
      else if (undoes(this.frozen.get(host))) this.frozen.delete(host)
    }
    if (msg.type === "Paused" && (!this.paused || block >= this.paused.block)) {
      this.paused = { value: Boolean(msg.usagePaused), at, block }
      this.buyers.clear()
    }
    if (msg.type === "Reorg") {
      this.dropAbove(Number(msg.fromBlock ?? 0))
      this.resync()
    }
    for (const fn of this.listeners) fn(msg)
  }

  /** Tightenings above the fork may be gone. Survivors come back through the rewound indexer. */
  private dropAbove(fork: number) {
    for (const overlay of [this.withdrawing, this.lowered, this.closing, this.frozen] as Map<string, { block: number }>[]) {
      for (const [key, row] of overlay) if (row.block > fork) overlay.delete(key)
    }
    if (this.paused && this.paused.block > fork) this.paused = null
  }

  /** Called when the push connection comes back, since messages sent while it was down are lost. */
  resync() {
    this.generation += 1
    this.buyers.clear()
    this.channels.clear()
    this.hosts = null
  }
}
