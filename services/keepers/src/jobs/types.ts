import type { Db, Metrics } from "@offpeak/common"
import type { Account, Address, PublicClient, WalletClient } from "viem"

export type KeeperDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: Account
  contracts: Record<string, Address>
  metrics: Metrics
}
