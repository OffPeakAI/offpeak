import { FeeSplitterAbi } from "@offpeak/abis"
import { log } from "@offpeak/common"
import { zeroAddress } from "viem"
import type { KeeperDeps } from "./types.ts"

const USDG_UNIT = 1_000_000n

/** Anyone may call this. Burning stays with its own job, behind the legal gate. */
export async function runFeeDistribute(deps: KeeperDeps) {
  const splitter = { address: deps.contracts.FeeSplitter!, abi: FeeSplitterAbi }
  const owed = await deps.reader.readContract({ ...splitter, functionName: "undistributed" })
  if (owed === 0n) return { distributed: 0n }
  const { request } = await deps.reader.simulateContract({ ...splitter, functionName: "distribute", account: deps.account })
  await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
  log("keepers", "fees_distributed", { amount: owed })
  return { distributed: owed }
}

/**
 * Off unless the legal gate has passed, a swap adapter is set and this keeper holds the burn role.
 * `minOfpkPerUsdg` is token units per whole USDG, set by whoever runs the keeper, since a bad floor loses money.
 */
export async function runBurn(deps: KeeperDeps, minOfpkPerUsdg?: bigint) {
  const splitter = { address: deps.contracts.FeeSplitter!, abi: FeeSplitterAbi }
  const read = <T>(functionName: string) => deps.reader.readContract({ ...splitter, functionName } as never) as Promise<T>
  const [enabled, adapter, keeper, bucket] = await Promise.all([
    read<boolean>("tokenHooksEnabled"),
    read<string>("swapAdapter"),
    read<string>("burnKeeper"),
    read<bigint>("burnBucket"),
  ])
  if (!enabled || adapter === zeroAddress || bucket === 0n) return { burned: 0n, skipped: "not_due" }
  if (keeper.toLowerCase() !== deps.account.address.toLowerCase() || minOfpkPerUsdg === undefined) {
    log("keepers", "burn_skipped", { bucket, reason: "no_keeper_or_floor" })
    return { burned: 0n, skipped: "no_keeper_or_floor" }
  }
  const minOut = (bucket * minOfpkPerUsdg) / USDG_UNIT
  const { request } = await deps.reader.simulateContract({ ...splitter, functionName: "executeBurn", args: [minOut], account: deps.account })
  await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
  log("keepers", "burn_executed", { bucket, minOut })
  return { burned: bucket }
}
