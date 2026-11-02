import { WindowMarketAbi } from "@offpeak/abis"
import { agreedSignatures, log, readSignatures, storeSignature, type Db } from "@offpeak/common"
import { domain, merkleRoot, windowPerfTypes } from "@offpeak/shared"
import { encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem"

/** Performance waits this long after a Window ends, so the last samples are in. */
const POST_AFTER_S = 3600
const PERF_NONE = 0
const PERF_DISPUTED = 2
/** The router writes one sample a minute, so each demanded sample stands for 60 seconds. */
const SAMPLE_S = 60
/** A share of a few demanded minutes says nothing about a host, and one holder can make those. The auditor holds to the same floor. */
const MIN_MEASURED_S = 600

export type PerfDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: LocalAccount
  chainId: number
  contracts: Record<string, Address>
  settlers: Address[]
}

type Sample = { minute: string; demanded: boolean; below: boolean }

export async function measure(db: Db, windowId: string, minTps: string) {
  const rows = await db.query<Sample>(
    `SELECT EXTRACT(EPOCH FROM ts)::bigint / $1 AS minute, demanded, (demanded AND tokens_per_s < $2) AS below
     FROM shared.window_perf WHERE window_id = $3 ORDER BY ts`,
    [SAMPLE_S, minTps, windowId],
  )
  const leaves = rows.rows.map((row) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint64" }, { type: "bool" }, { type: "bool" }],
        [BigInt(windowId), BigInt(row.minute), row.demanded, row.below],
      ),
    ),
  )
  const measuredSeconds = rows.rows.filter((row) => row.demanded).length * SAMPLE_S
  return {
    windowId: BigInt(windowId),
    measuredSeconds,
    // The contract fails a Window on the share alone, so under the floor nothing goes on record as below. The leaves keep what was seen.
    belowMinSeconds: measuredSeconds < MIN_MEASURED_S ? 0 : rows.rows.filter((row) => row.below).length * SAMPLE_S,
    evidenceRoot: merkleRoot(leaves),
  }
}

async function post(deps: PerfDeps, market: Address, windowId: string, message: Awaited<ReturnType<typeof measure>>) {
  const agreed = await agreedSignatures(await readSignatures(deps.db, "perf", Number(windowId)), deps.settlers)
  if (!agreed) return false
  const { request } = await deps.reader.simulateContract({
    address: market,
    abi: WindowMarketAbi,
    functionName: "postPerformance",
    args: [message, agreed.thresholdSig],
    account: deps.account,
  })
  await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
  return true
}

/** Signs and posts each Window that ended, and again for any its host disputed, where the second post is final. */
export async function perfTick(deps: PerfDeps) {
  const market = deps.contracts.WindowMarket
  if (!market) return []
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const due = await deps.db.query<{ id: string; min_tps: string }>(
    "SELECT id, min_tps FROM chain.windows WHERE t1 + $1 <= $2 AND perf_state IN ($3, $4) ORDER BY id",
    [POST_AFTER_S, Number(head.timestamp), PERF_NONE, PERF_DISPUTED],
  )
  const posted: string[] = []
  for (const row of due.rows) {
    const message = await measure(deps.db, row.id, row.min_tps)
    const hash = hashTypedData({
      domain: domain("OffpeakWindows", market, deps.chainId),
      types: windowPerfTypes,
      primaryType: "WindowPerformance",
      message,
    })
    const sig = await deps.account.sign!({ hash })
    await storeSignature(deps.db, "perf", Number(row.id), deps.account.address, hash, sig, { message })
    try {
      if (await post(deps, market, row.id, message)) posted.push(row.id)
    } catch (err) {
      log("settlement", "perf_submit_retry", { windowId: row.id, error: String(err).slice(0, 160) })
    }
  }
  return posted
}

