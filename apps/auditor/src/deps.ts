import type { ChainReader, Hex } from "@offpeak/shared"
import type { Address, LocalAccount, PublicClient, WalletClient } from "viem"
import type { Db } from "../../../services/common/src/db.ts"
import type { Metrics } from "../../../services/common/src/metrics.ts"
import type { CanaryAccount, CanaryPlan } from "./canaries.ts"
import type { Corpus } from "./corpus.ts"
import type { Fetcher } from "./score.ts"

export type AuditModel = { name: string; digest: Hex }

/** Everything the auditor's jobs touch. `main.ts` builds it from the environment. */
export type AuditDeps = {
  env: "local" | "testnet-fork" | "mainnet"
  db: Db
  chain: Pick<ChainReader, "hostList" | "host" | "proof">
  fetcher: Fetcher
  /** The auditor key, which also signs score requests to reference hosts. */
  account: LocalAccount
  reader: PublicClient
  writer: WalletClient
  contracts: Record<string, Address>
  metrics: Metrics
  kek: Buffer
  routerUrl: string
  indexerUrl: string
  internalToken: string
  accounts: CanaryAccount[]
  /** Null means no canaries run: nothing here falls back to prompts a host could hold. */
  corpus: Corpus | null
  models: AuditModel[]
  enqueueCanary: (plan: CanaryPlan) => Promise<unknown>
  fileThroughput: boolean
  rng: () => number
  clock: () => number
}
