import { OffpeakVaultAbi } from "@offpeak/abis"
import { log, readSignatures, type Metrics } from "@offpeak/common"
import { hourEnd, hourIndex } from "@offpeak/shared"
import type { LocalAccount, WalletClient } from "viem"
import { buildBatch } from "./build.ts"
import { gatherHour, type GatherDeps } from "./gather.ts"
import { perfTick } from "./perf.ts"
import { refundTick } from "./refunds.ts"
import { rewardTick } from "./rewards.ts"
import { signHour } from "./sign.ts"
import { trySubmitHour } from "./submit.ts"

export type WorkerDeps = GatherDeps & {
  account: LocalAccount
  writer: WalletClient
  settlers: `0x${string}`[]
  metrics: Metrics
}

async function recordHealth(deps: WorkerDeps, hour: number) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  deps.metrics.set("settle_lag_seconds", Math.max(0, Number(head.timestamp) - hourEnd(hour)))
  const reserve = await deps.reader.readContract({
    address: deps.contracts.OffpeakVault!,
    abi: OffpeakVaultAbi,
    functionName: "protocolReserve",
  })
  deps.metrics.set("reserve_balance_usdg", Number(reserve) / 1e6)
}

/**
 * One pass for the next unsettled hour. Nothing here waits on a person: a signer that cannot act
 * yet says why, disagreements resolve by rebuilding on the next pass, and bad records leave the
 * batch by rule.
 */
export async function settlementTick(deps: WorkerDeps) {
  const vault = deps.contracts.OffpeakVault!
  const lastSettled = await deps.reader.readContract({ address: vault, abi: OffpeakVaultAbi, functionName: "lastSettledHour" })
  const hour = Number(lastSettled) + 1
  await recordHealth(deps, hour)
  const gathered = await gatherHour(deps, hour)
  if ("waiting" in gathered) return { hour, status: gathered.waiting }

  const built = await buildBatch(gathered.input)
  await signHour(deps.db, deps.account, built)
  if (built.rejects.length > 0) log("settlement", "records_excluded", { hour, rejects: built.rejects })
  if (!built.closeMatched) log("settlement", "router_close_mismatch", { hour, root: built.b.root })
  deps.metrics.inc("settlement_records_excluded_total", built.rejects.length)
  const overCapacity = built.rejects.filter((r) => r.reason === "over_batch_capacity").length
  if (overCapacity > 0) {
    log("settlement", "hour_over_capacity", { hour, records: overCapacity })
    deps.metrics.inc("settlement_capacity_exclusions_total", overCapacity)
  }

  const signed = await readSignatures(deps.db, "settle", hour)
  if (new Set(signed.map((row) => row.batch_hash)).size > 1) deps.metrics.inc("settlement_signer_disagreement_total")

  const submit = { db: deps.db, reader: deps.reader, writer: deps.writer, account: deps.account, vault, settlers: deps.settlers, metrics: deps.metrics }
  const result = await trySubmitHour(submit, hour).catch((err) => {
    log("settlement", "submit_retry", { hour, error: String(err).slice(0, 200) })
    return "retry"
  })
  return { hour, status: result }
}

export async function perfPass(deps: WorkerDeps) {
  return perfTick(deps).catch((err) => {
    log("settlement", "perf_retry", { error: String(err).slice(0, 200) })
    return []
  })
}

export async function rewardPass(deps: WorkerDeps) {
  return rewardTick(deps).catch((err) => {
    log("settlement", "reward_retry", { error: String(err).slice(0, 200) })
    return null
  })
}

export async function refundPass(deps: WorkerDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const hour = hourIndex(Number(head.timestamp))
  const pass = refundTick(
    {
      db: deps.db,
      reader: deps.reader,
      writer: deps.writer,
      account: deps.account,
      vault: deps.contracts.OffpeakVault!,
      settlers: deps.settlers,
      chainId: deps.chainId,
    },
    hour,
  )
  return pass.catch((err) => {
    log("settlement", "refund_retry", { hour, error: String(err).slice(0, 200) })
    return "retry"
  })
}
