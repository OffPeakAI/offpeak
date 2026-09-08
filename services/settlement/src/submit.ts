import { OffpeakVaultAbi } from "@offpeak/abis"
import { agreedSignatures, log, readSignatures, type Db, type Metrics } from "@offpeak/common"
import type { Account, Address, Hex, PublicClient, WalletClient } from "viem"
import { reviveBatch, type StoredBatch } from "./sign.ts"

export type SubmitDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: Account
  vault: Address
  settlers: Address[]
  metrics?: Metrics
}

/** The chain's per-transaction limit, read from the ArbGasInfo precompile. A batch above it can never land. */
export const MAX_TX_GAS = 32_000_000n

/** Any signer may submit. Losing the race surfaces as a failed simulation and changes nothing. */
export async function trySubmitHour(deps: SubmitDeps, hour: number): Promise<Hex | "waiting"> {
  const agreed = await agreedSignatures(await readSignatures(deps.db, "settle", hour), deps.settlers)
  if (!agreed) return "waiting"
  const { b, t } = reviveBatch(agreed.batch as StoredBatch)
  const { request } = await deps.reader.simulateContract({
    address: deps.vault,
    abi: OffpeakVaultAbi,
    functionName: "settle",
    args: [b as never, t as never, agreed.thresholdSig],
    account: deps.account,
  })
  const gas = await deps.reader.estimateContractGas(request)
  deps.metrics?.set("settle_batch_gas", Number(gas))
  if (gas > MAX_TX_GAS) {
    log("settlement", "batch_over_gas_limit", { hour, gas, debits: b.debits.length, credits: b.credits.length })
    deps.metrics?.inc("settle_batch_over_gas_total")
    throw new Error(`hour ${hour} needs ${gas} gas, over the ${MAX_TX_GAS} limit`)
  }
  const hash = await deps.writer.writeContract(request)
  await deps.reader.waitForTransactionReceipt({ hash })
  return hash
}
