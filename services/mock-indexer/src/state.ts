import {
  HOST_STATUS,
  type BuyerChain,
  type BuyerView,
  type ChainPush,
  type ChainReader,
  type ChannelChain,
  type EscrowChain,
  type HolderView,
  type HostChain,
  type HostView,
  type OfpkChain,
  type ProofChain,
  type WindowView,
} from "@offpeak/shared"

export type { BuyerChain, ChainPush, HostChain } from "@offpeak/shared"

function computeBuyer(view: BuyerView): Pick<BuyerChain, "servable" | "reason"> {
  if (view.withdrawRequestedAt > 0n) return { servable: false, reason: "withdraw_requested" }
  if (view.usagePaused) return { servable: false, reason: "paused" }
  if (view.balance <= 0n) return { servable: false, reason: "no_balance" }
  if (view.hourlyCap <= 0n) return { servable: false, reason: "no_caps" }
  return { servable: true }
}

function emptyBuyer(): BuyerView {
  return {
    balance: 0n,
    reserve: 0n,
    hourlyCap: 0n,
    dailyCap: 0n,
    pendingHourlyCap: 0n,
    pendingDailyCap: 0n,
    capsEffectiveAfterHour: 0n,
    withdrawRequestedAt: 0n,
    withdrawDueAt: 0n,
    lastSettledHour: 0n,
    usagePaused: false,
  }
}

export class MockIndexer implements ChainReader {
  head = { block: 1, blockTs: 0, finalizedBlock: 1 }
  buyers = new Map<string, BuyerView>()
  hosts = new Map<string, HostChain>()
  channels = new Map<string, ChannelChain>()
  escrows = new Map<string, EscrowChain>()
  windows = new Map<string, WindowView>()
  holders = new Map<string, HolderView>()
  settlements = new Map<string, { root: string; totalsHash: string; txHash: string; settledAt: number }>()
  proofs = new Map<string, ProofChain>()
  challenges: { host: string; id: string; status: string; kind: number; state?: number; filedAt?: number }[] = []
  ofpk = new Map<string, OfpkChain>()
  private listeners = new Set<(msg: ChainPush) => void>()

  buyerNow(addr: string, now: number): BuyerChain {
    const view = this.buyers.get(addr.toLowerCase()) ?? emptyBuyer()
    return { ...view, ...computeBuyer(view), fetchedAt: now }
  }

  async buyer(addr: string, now: number) {
    return this.buyerNow(addr, now)
  }

  async hostList() {
    return [...this.hosts.values()]
  }

  async host(addr: string) {
    return this.hosts.get(addr.toLowerCase()) ?? null
  }

  async channel(id: string) {
    return this.channels.get(id.toLowerCase()) ?? null
  }

  async escrow(reqId: string) {
    return this.escrows.get(reqId) ?? null
  }

  async window(id: string): Promise<WindowView | null> {
    return this.windows.get(id) ?? null
  }

  async windowList() {
    return [...this.windows.values()]
  }

  async holder(id: string, addr: string): Promise<HolderView | null> {
    return this.holders.get(`${id}:${addr.toLowerCase()}`) ?? null
  }

  async ofpkOf(addr: string) {
    return this.ofpk.get(addr.toLowerCase()) ?? null
  }

  async proof(reqId: string) {
    return this.proofs.get(reqId) ?? null
  }

  async challengesOf(host: string) {
    return this.challenges
      .filter((row) => row.host === host.toLowerCase())
      .map((row) => ({ id: row.id, host: row.host, kind: row.kind, state: row.state ?? 1, slashBps: 0, filedAt: row.filedAt ?? 0, reviewEndsAt: 0 }))
  }

  /** Overrides a buyer view. Amounts arrive as decimal strings, the way the indexer API sends them. */
  setBuyer(addr: string, overrides: Record<string, unknown>) {
    const key = addr.toLowerCase()
    const view: Record<string, unknown> = { ...(this.buyers.get(key) ?? emptyBuyer()) }
    for (const [field, value] of Object.entries(overrides)) {
      if (!(field in view)) continue
      view[field] = field === "usagePaused" ? Boolean(value) : BigInt(value as string)
    }
    this.buyers.set(key, view as BuyerView)
  }

  subscribe(fn: (msg: ChainPush) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(msg: ChainPush) {
    if (msg.type === "WithdrawAllRequested") {
      const buyer = this.buyers.get(String(msg.buyer).toLowerCase())
      if (buyer) {
        buyer.withdrawRequestedAt = BigInt(msg.requestedAt as number)
        buyer.withdrawDueAt = BigInt(msg.dueAt as number)
      }
    }
    if (msg.type === "CapsChangeRequested") {
      const buyer = this.buyers.get(String(msg.buyer).toLowerCase())
      if (buyer) {
        buyer.pendingHourlyCap = BigInt(msg.hourlyCap as string)
        buyer.pendingDailyCap = BigInt(msg.dailyCap as string)
        buyer.capsEffectiveAfterHour = BigInt(msg.effectiveAfterHour as string)
      }
    }
    if (msg.type === "Paused") {
      for (const buyer of this.buyers.values()) buyer.usagePaused = Boolean(msg.usagePaused)
    }
    if (msg.type === "CloseRequested") {
      const ch = this.channels.get(String(msg.channelId).toLowerCase())
      if (ch) {
        ch.closeRequested = true
        ch.status = 2
        ch.challengeEndsAt = BigInt(msg.challengeEndsAt as number)
      }
    }
    if (msg.type === "HostStatusChanged") {
      const host = this.hosts.get(String(msg.host).toLowerCase())
      if (host) {
        host.status = Number(msg.status) as HostView["status"]
        host.routable = host.status === HOST_STATUS.Active
      }
    }
    if (msg.type === "Authorized" || msg.type === "AuthorizeFailed" || msg.type === "ExactSettled" || msg.type === "Captured") {
      const row = this.escrows.get(String(msg.reqId)) ?? { status: "none" as const, maxAmount: 0n, captured: 0n }
      if (msg.type === "Authorized") row.status = "authorized"
      if (msg.type === "Captured") row.status = "captured"
      if (msg.type === "ExactSettled") {
        row.status = "captured"
        row.captured = BigInt(String(msg.amount ?? 0))
      }
      this.escrows.set(String(msg.reqId), row)
    }
    this.head.block += 1
    for (const fn of this.listeners) fn(msg)
  }
}
