import { FeeSplitterAbi, HostRegistryAbi } from "@offpeak/abis"
import { agreedSignatures, firstBlockAtOrAfter, readSignatures, storeSignature, type Db } from "@offpeak/common"
import { domain, rewardTypes } from "@offpeak/shared"
import { hashTypedData, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem"

const WEEK_S = 604_800
/** Unix time zero was a Thursday, so this shift makes weeks start on Monday. */
const MONDAY_OFFSET_S = 259_200
const POST_AFTER_S = 1_800
const MAX_CREDITS = 500
const STATUS_ACTIVE = 2
const BPS = 10_000n

export type RewardDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: LocalAccount
  chainId: number
  contracts: Record<string, Address>
  settlers: Address[]
}

export type StatusChange = { ts: number; status: number }
export type RewardCredit = { host: Address; amount: bigint }

export const weekStart = (week: number) => week * WEEK_S - MONDAY_OFFSET_S
export const weekOf = (ts: number) => Math.floor((ts + MONDAY_OFFSET_S) / WEEK_S)

/** Share of a week a host was routable, in bps. Frozen, probation and delisted time all count as off. */
export function uptimeBps(changes: StatusChange[], start: number, end: number) {
  let status = 0
  let since = start
  let active = 0
  for (const change of changes) {
    const at = Math.min(Math.max(change.ts, start), end)
    if (status === STATUS_ACTIVE) active += at - since
    since = at
    status = change.status
  }
  if (status === STATUS_ACTIVE) active += end - since
  return (BigInt(active) * BPS) / BigInt(end - start)
}

/** Splits the bucket by bond times uptime. Rounding stays in the bucket for next week. */
export function splitRewards(bucket: bigint, hosts: { host: Address; bond: bigint; uptime: bigint }[]): RewardCredit[] {
  const weighted = hosts
    .map((h) => ({ host: h.host, weight: h.bond * h.uptime }))
    .filter((h) => h.weight > 0n)
    .sort((a, b) => (a.weight === b.weight ? (a.host < b.host ? -1 : 1) : a.weight > b.weight ? -1 : 1))
    .slice(0, MAX_CREDITS)
  const total = weighted.reduce((sum, h) => sum + h.weight, 0n)
  if (total === 0n) return []
  return weighted
    .map((h) => ({ host: h.host, amount: (bucket * h.weight) / total }))
    .filter((c) => c.amount > 0n)
    .sort((a, b) => (a.host.toLowerCase() < b.host.toLowerCase() ? -1 : 1))
}

async function hostInputs(deps: RewardDeps, blockNumber: bigint, start: number, end: number) {
  const hosts = await deps.db.query<{ address: string }>("SELECT address FROM chain.hosts ORDER BY address")
  const logs = await deps.db.query<{ host: string; ts: string; status: number }>(
    "SELECT host, ts, status FROM chain.host_status_log WHERE ts < $1 ORDER BY host, seq",
    [end],
  )
  return Promise.all(
    hosts.rows.map(async ({ address }) => {
      const view = await deps.reader.readContract({
        address: deps.contracts.HostRegistry!,
        abi: HostRegistryAbi,
        functionName: "hostView",
        args: [address as Address],
        blockNumber,
      })
      const changes = logs.rows.filter((row) => row.host === address).map((row) => ({ ts: Number(row.ts), status: Number(row.status) }))
      return { host: address as Address, bond: view.bondUsdg, uptime: uptimeBps(changes, start, end) }
    }),
  )
}

/** Signs last week's split once it has closed, and submits as soon as two signers agree. */
export async function rewardTick(deps: RewardDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const week = weekOf(Number(head.timestamp)) - 1
  const start = weekStart(week)
  const end = start + WEEK_S
  if (Number(head.timestamp) < end + POST_AFTER_S) return null
  const splitter = { address: deps.contracts.FeeSplitter!, abi: FeeSplitterAbi }
  if (await deps.reader.readContract({ ...splitter, functionName: "rewardWeekPaid", args: [BigInt(week)] })) return null

  const pin = await firstBlockAtOrAfter(deps.reader, end + POST_AFTER_S)
  if (pin === null) return null
  const cursor = await deps.db.query<{ block: string }>("SELECT block FROM chain.cursor WHERE id = 'main'")
  if (BigInt(cursor.rows[0]?.block ?? -1) < pin) return null
  const bucket = await deps.reader.readContract({ ...splitter, functionName: "hostRewardBucket", blockNumber: pin })
  const credits = splitRewards(bucket, await hostInputs(deps, pin, start, end))
  if (credits.length === 0) return null

  const message = { week: BigInt(week), credits }
  const hash = hashTypedData({
    domain: domain("OffpeakSettlement", deps.contracts.OffpeakVault!, deps.chainId),
    types: rewardTypes,
    primaryType: "RewardBatch",
    message,
  })
  const sig = await deps.account.sign!({ hash })
  await storeSignature(deps.db, "reward", week, deps.account.address, hash, sig, { message })
  const agreed = await agreedSignatures(await readSignatures(deps.db, "reward", week), deps.settlers)
  if (!agreed) return null
  const { request } = await deps.reader.simulateContract({
    ...splitter,
    functionName: "distributeRewards",
    args: [message, agreed.thresholdSig as Hex],
    account: deps.account,
  })
  const tx = await deps.writer.writeContract(request)
  await deps.reader.waitForTransactionReceipt({ hash: tx })
  return { week, total: credits.reduce((sum, c) => sum + c.amount, 0n) }
}

