import type { Db } from "@offpeak/common"
import type { ChainEvent } from "./index.ts"

export async function applyUsageLedger(tx: Db, e: ChainEvent) {
  if (e.event !== "RootPosted") return
  const { hour, root, totalsHash, records } = e.args
  await tx.query(
    `INSERT INTO chain.roots (hour, root, totals_hash, records) VALUES ($1,$2,$3,$4)
     ON CONFLICT (hour) DO UPDATE SET root = $2, totals_hash = $3, records = $4`,
    [hour, root, totalsHash, records],
  )
}
