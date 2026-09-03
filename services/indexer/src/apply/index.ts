import type { Db } from "@offpeak/common"
import { applyAuditCourt } from "./AuditCourt.ts"
import { applyChannelManager } from "./ChannelManager.ts"
import { applyHostRegistry } from "./HostRegistry.ts"
import { applyOffpeakVault } from "./OffpeakVault.ts"
import { applyUsageLedger } from "./UsageLedger.ts"
import { applyWindowMarket } from "./WindowMarket.ts"
import { applyX402Escrow } from "./X402Escrow.ts"

export type ChainEvent = {
  txHash: string
  logIndex: number
  blockNumber: bigint
  blockTs: number
  contract: string
  event: string
  args: Record<string, unknown>
}

const APPLIERS: Record<string, (tx: Db, e: ChainEvent) => Promise<void>> = {
  OffpeakVault: applyOffpeakVault,
  HostRegistry: applyHostRegistry,
  UsageLedger: applyUsageLedger,
  AuditCourt: applyAuditCourt,
  ChannelManager: applyChannelManager,
  X402Escrow: applyX402Escrow,
  WindowMarket: applyWindowMarket,
}

/** Each applier is pure over the transaction, so a replay of the events rebuilds the same state. */
export async function applyEvent(tx: Db, e: ChainEvent) {
  await APPLIERS[e.contract]?.(tx, e)
}
