import type { Address } from "viem"
import local from "../deployments/local.json" with { type: "json" }
import mainnet from "../deployments/4663.json" with { type: "json" }
import { AuditCourtAbi } from "./AuditCourt.ts"
import { ChannelManagerAbi } from "./ChannelManager.ts"
import { FeeSplitterAbi } from "./FeeSplitter.ts"
import { HostRegistryAbi } from "./HostRegistry.ts"
import { MockOFPKAbi } from "./MockOFPK.ts"
import { MockUSDGAbi } from "./MockUSDG.ts"
import { OffpeakVaultAbi } from "./OffpeakVault.ts"
import { OfpkHooksAbi } from "./OfpkHooks.ts"
import { UsageLedgerAbi } from "./UsageLedger.ts"
import { WindowMarketAbi } from "./WindowMarket.ts"
import { X402EscrowAbi } from "./X402Escrow.ts"

export {
  AuditCourtAbi,
  ChannelManagerAbi,
  FeeSplitterAbi,
  HostRegistryAbi,
  MockOFPKAbi,
  MockUSDGAbi,
  OffpeakVaultAbi,
  OfpkHooksAbi,
  UsageLedgerAbi,
  WindowMarketAbi,
  X402EscrowAbi,
}

export const localDeployment = local
export const mainnetDeployment = mainnet

export type ContractName = keyof typeof local.contracts

export function addressOf(name: ContractName, file: "local" | "4663" = "local"): Address {
  const table = file === "local" ? local.contracts : mainnet.contracts
  return table[name] as Address
}

export const vaultAbi = OffpeakVaultAbi
export const hostRegistryAbi = HostRegistryAbi
export const usageLedgerAbi = UsageLedgerAbi
export const x402EscrowAbi = X402EscrowAbi
export const channelManagerAbi = ChannelManagerAbi
export const windowMarketAbi = WindowMarketAbi
export const auditCourtAbi = AuditCourtAbi
export const ofpkHooksAbi = OfpkHooksAbi

export const abis = {
  OffpeakVault: OffpeakVaultAbi,
  HostRegistry: HostRegistryAbi,
  UsageLedger: UsageLedgerAbi,
  X402Escrow: X402EscrowAbi,
  ChannelManager: ChannelManagerAbi,
  WindowMarket: WindowMarketAbi,
  AuditCourt: AuditCourtAbi,
  OfpkHooks: OfpkHooksAbi,
  FeeSplitter: FeeSplitterAbi,
} as const
