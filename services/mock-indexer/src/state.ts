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
