import { domain, hourCloseTypes, hourIndex, merkleRoot, totalsHashOf, usageLeaf, type Hex, type RootTotals } from "@offpeak/shared"
import type { PrivateKeyAccount } from "viem"
import type { Db } from "@offpeak/common"
import { ZERO_BYTES32 } from "@offpeak/shared"

export async function closeHour(db: Db, hour: number, signer: PrivateKeyAccount, ledger: string) {
  const existing = await db.query<{ hour: string }>("SELECT hour FROM shared.usage_hours WHERE hour = $1", [hour])
  if (existing.rows.length > 0) return { idempotent: true }
  await db.query("INSERT INTO serving.hour_locks (hour) VALUES ($1) ON CONFLICT DO NOTHING", [hour])
  const rows = await db.query<{
    req_id: string
    leaf: string
    tokens_in: number
    tokens_out: number
    host_cost_micro: string
    fee_micro: string
    pay_mode: number
    status: string
  }>("SELECT req_id, leaf, tokens_in, tokens_out, host_cost_micro, fee_micro, pay_mode, status FROM shared.usage_records WHERE hour = $1 AND status = 'final' ORDER BY req_id ASC", [hour])
  const totals: RootTotals = {
    records: rows.rows.length,
    tokensIn: 0n,
    tokensOut: 0n,
    prepaidDebit: 0n,
    agentCollected: 0n,
    windowDrawn: 0n,
    hostCredit: 0n,
    fees: 0n,
  }
  const leaves: Hex[] = []
  for (const row of rows.rows) {
    leaves.push(row.leaf as Hex)
    totals.tokensIn += BigInt(row.tokens_in)
    totals.tokensOut += BigInt(row.tokens_out)
    const hostCost = BigInt(row.host_cost_micro)
    const fee = BigInt(row.fee_micro)
    if (row.pay_mode === 0) totals.prepaidDebit += hostCost + fee
    if (row.pay_mode === 1 || row.pay_mode === 2 || row.pay_mode === 3) totals.agentCollected += hostCost + fee
    if (row.pay_mode === 4) totals.windowDrawn += BigInt(row.tokens_in + row.tokens_out)
    if (row.pay_mode !== 4) {
      totals.hostCredit += hostCost
      totals.fees += fee
    }
  }
  const root = merkleRoot(leaves)
  const totalsHash = rows.rows.length === 0 ? totalsHashOf(totals) : totalsHashOf(totals)
  const signature = await signer.signTypedData({
    domain: domain("OffpeakUsage", ledger),
    types: hourCloseTypes,
    primaryType: "HourClose",
    message: { hour: BigInt(hour), records: totals.records, root, totalsHash },
  })
  await db.query(
    `INSERT INTO shared.usage_hours (hour, records, root, totals, totals_hash, router_close_sig)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [
      hour,
      totals.records,
      root,
      JSON.stringify({
        records: totals.records,
        tokensIn: totals.tokensIn.toString(),
        tokensOut: totals.tokensOut.toString(),
        prepaidDebit: totals.prepaidDebit.toString(),
        agentCollected: totals.agentCollected.toString(),
        windowDrawn: totals.windowDrawn.toString(),
        hostCredit: totals.hostCredit.toString(),
        fees: totals.fees.toString(),
      }),
      totalsHash,
      signature,
    ],
  )
  return { idempotent: false, root, totals, signature }
}

export function hourOf(ts: number) {
  return hourIndex(ts)
}

export { usageLeaf, ZERO_BYTES32 }
