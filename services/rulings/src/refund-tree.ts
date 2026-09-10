import type { Db } from "@offpeak/common"
import { merkleProof, merkleRoot } from "@offpeak/shared"
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem"

export type RefundEntry = { buyer: Address; amount: bigint; proof: Hex[] }

export function refundLeaf(buyer: Address, amount: bigint): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [buyer, amount]))
  return keccak256(inner)
}

/** Splits `pool` by each buyer's spend. Rounding dust stays in the court and sweeps with the rest. */
export function buildRefundTree(spend: { buyer: Address; spent: bigint }[], pool: bigint) {
  const total = spend.reduce((sum, s) => sum + s.spent, 0n)
  if (total === 0n || pool === 0n) return { root: `0x${"00".repeat(32)}` as Hex, entries: [] as RefundEntry[] }
  const shares = spend
    .map((s) => ({ buyer: s.buyer, amount: (pool * s.spent) / total }))
    .filter((s) => s.amount > 0n)
    .sort((a, b) => (a.buyer < b.buyer ? -1 : 1))
  const leaves = shares.map((s) => refundLeaf(s.buyer, s.amount))
  return {
    root: merkleRoot(leaves),
    entries: shares.map((s, i) => ({ ...s, proof: merkleProof(leaves, i) })),
  }
}

/** Everyone who paid this host across the evidence's hours, whatever way they paid. */
export async function spendWithHost(db: Db, host: string, hours: number[]) {
  const rows = await db.query<{ payer: string; spent: string }>(
    `SELECT payer, SUM(host_cost_micro + fee_micro) AS spent FROM shared.usage_records
     WHERE host = $1 AND hour >= $2 AND hour <= $3 AND status = 'final' AND settled_hour_tx IS NOT NULL
     GROUP BY payer ORDER BY payer`,
    [host, Math.min(...hours), Math.max(...hours)],
  )
  return rows.rows.map((r) => ({ buyer: r.payer as Address, spent: BigInt(r.spent) }))
}

export async function storeRefundTree(db: Db, challengeId: number, slashBps: number, tree: ReturnType<typeof buildRefundTree>) {
  for (const entry of tree.entries) {
    await db.query(
      `INSERT INTO chain.refund_trees (challenge_id, slash_bps, buyer, amount, proof) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (challenge_id, slash_bps, buyer) DO NOTHING`,
      [challengeId, slashBps, entry.buyer, entry.amount.toString(), JSON.stringify(entry.proof)],
    )
  }
}
