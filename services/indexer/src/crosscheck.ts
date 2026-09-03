import { OffpeakVaultAbi } from "@offpeak/abis"
import type { Db, Metrics } from "@offpeak/common"
import type { Address, PublicClient } from "viem"
import { readVaultState, reserveOf, type BuyerRow } from "./views.ts"

/** Compares a random sample of computed reserves with the contract's own. The metric must stay 0. */
export async function crossCheckBuyers(deps: { db: Db; reader: PublicClient; vault: Address; metrics: Metrics }, sample = 50) {
  const rows = await deps.db.query<BuyerRow & { address: string }>("SELECT * FROM chain.buyers ORDER BY random() LIMIT $1", [sample])
  const vault = await readVaultState(deps.db)
  const block = await deps.reader.getBlock({ blockTag: "latest" })
  let mismatches = 0
  for (const row of rows.rows) {
    const onChain = await deps.reader.readContract({
      address: deps.vault,
      abi: OffpeakVaultAbi,
      functionName: "reserveOf",
      args: [row.address as Address],
      blockNumber: block.number,
    })
    if (onChain !== reserveOf(row, vault, Number(block.timestamp))) mismatches++
  }
  deps.metrics.inc("indexer_view_mismatch_total", mismatches)
  return mismatches
}
