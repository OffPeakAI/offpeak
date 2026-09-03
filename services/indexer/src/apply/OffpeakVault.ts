import type { Db } from "@offpeak/common"
import { hourIndex } from "@offpeak/shared"
import type { ChainEvent } from "./index.ts"

const addr = (v: unknown) => String(v).toLowerCase()

type StoredOutcome = {
  rejects?: { reqId: string; reason: string }[]
  payments?: {
    drawn: string[]
    writtenOff: string[]
    orphans?: string[]
    swept?: { paymentId: string; source: string; amount: string }[]
    refunds?: { id: string; payer: string; amount: string; reason: string; reqIds: string[] }[]
  }
}

async function touchBuyer(tx: Db, buyer: string) {
  await tx.query("INSERT INTO chain.buyers (address) VALUES ($1) ON CONFLICT DO NOTHING", [buyer])
}

async function applySettled(tx: Db, e: ChainEvent) {
  const { hour, root, totalsHash, debited, credited, fees } = e.args
  await tx.query(
    `INSERT INTO chain.settlements (hour, root, totals_hash, debited, credited, fees, tx_hash, block, settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (hour) DO UPDATE SET root = $2, totals_hash = $3, debited = $4, credited = $5, fees = $6,
       tx_hash = $7, block = $8, settled_at = $9`,
    [hour, root, totalsHash, debited, credited, fees, e.txHash, e.blockNumber, e.blockTs],
  )
  await tx.query("UPDATE chain.vault_state SET last_settled_hour = $1", [hour])
  const signed = await tx.query<{ batch: StoredOutcome }>(
    `SELECT batch FROM chain.settlement_sigs
     WHERE kind = 'settle' AND hour = $1 AND batch->'b'->>'root' = $2 AND batch->'b'->>'totalsHash' = $3 LIMIT 1`,
    [hour, root, totalsHash],
  )
  const outcome = signed.rows[0]?.batch
  for (const reject of outcome?.rejects ?? []) {
    await tx.query(
      "INSERT INTO chain.settlement_rejects (hour, req_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [hour, reject.reqId, reject.reason],
    )
  }
  const payments = outcome?.payments
  await tx.query("UPDATE shared.usage_hours SET settle_tx = $1, settled_at = to_timestamp($2) WHERE hour = $3", [
    e.txHash,
    e.blockTs,
    hour,
  ])
  await tx.query(
    `UPDATE shared.usage_records SET settled_hour_tx = $1
     WHERE hour = $2 AND status = 'final'
       AND req_id NOT IN (SELECT req_id FROM chain.settlement_rejects WHERE hour = $2)`,
    [e.txHash, hour],
  )
  if (!payments) return
  await tx.query("UPDATE shared.agent_payments SET drawn_hour = $1 WHERE payment_id = ANY($2)", [hour, payments.drawn])
  await tx.query("UPDATE shared.agent_payments SET written_off_hour = $1 WHERE payment_id = ANY($2)", [
    hour,
    payments.writtenOff,
  ])
  for (const reqId of payments.orphans ?? []) {
    await tx.query("INSERT INTO chain.orphan_writeoffs (req_id, hour) VALUES ($1,$2) ON CONFLICT DO NOTHING", [reqId, hour])
  }
  for (const sweep of payments.swept ?? []) {
    await tx.query("INSERT INTO chain.swept_payments (payment_id, source, amount, hour) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [
      sweep.paymentId,
      sweep.source,
      sweep.amount,
      hour,
    ])
  }
  for (const refund of payments.refunds ?? []) {
    await tx.query(
      "INSERT INTO shared.refunds (id, payer, amount, reason, req_ids) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [refund.id, refund.payer, refund.amount, refund.reason, refund.reqIds],
    )
  }
}

async function applyCollection(tx: Db, e: ChainEvent) {
  const hour = hourIndex(e.blockTs)
  await tx.query(
    `INSERT INTO chain.collections (payment_id, tx_hash, hour) VALUES ($1,$2,$3)
     ON CONFLICT (payment_id) DO UPDATE SET tx_hash = $2, hour = $3`,
    [e.args.paymentId, e.txHash, hour],
  )
}
