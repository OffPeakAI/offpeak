import { agreedSignatures, log, type Db, type SigRow } from "@offpeak/common"
import { hourIndex } from "@offpeak/shared"
import { recoverAddress, type Address, type Hex } from "viem"
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

/**
 * What landed, from the rows for the landed hash whose signatures hold. Both signers normally agree. One
 * may have re-signed since, which replaces its row, so the other's row alone still stands for the batch.
 */
async function landedOutcome(tx: Db, e: ChainEvent) {
  const { hour, batchHash, signers } = e.args as { hour: unknown; batchHash?: Hex; signers?: Address[] }
  const rows = batchHash
    ? await tx.query<SigRow>("SELECT signer, batch_hash, sig, batch FROM chain.settlement_sigs WHERE kind = 'settle' AND hour = $1 AND batch_hash = $2", [hour, batchHash])
    : { rows: [] }
  const accepted = signers ?? []
  const agreed = await agreedSignatures(rows.rows, accepted)
  if (agreed) return agreed.batch as StoredOutcome
  for (const row of rows.rows) {
    if (!accepted.some((signer) => addr(signer) === row.signer)) continue
    const recovered = await recoverAddress({ hash: row.batch_hash, signature: row.sig }).catch(() => null)
    if (recovered?.toLowerCase() === row.signer) return row.batch as StoredOutcome
  }
  log("indexer", "settlement_outcome_missing", { hour: String(hour), txHash: e.txHash })
  return undefined
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
  const outcome = await landedOutcome(tx, e)
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

export async function applyOffpeakVault(tx: Db, e: ChainEvent) {
  const args = e.args
  switch (e.event) {
    case "Deposited":
    case "Withdrawn": {
      const buyer = addr(args.buyer)
      await touchBuyer(tx, buyer)
      await tx.query("UPDATE chain.buyers SET balance = $1 WHERE address = $2", [args.balance, buyer])
      return
    }
    case "Debited": {
      const buyer = addr(args.buyer)
      await touchBuyer(tx, buyer)
      await tx.query("UPDATE chain.buyers SET balance = $1 WHERE address = $2", [args.balance, buyer])
      return
    }
    case "CapsChanged": {
      const buyer = addr(args.buyer)
      await touchBuyer(tx, buyer)
      await tx.query(
        `UPDATE chain.buyers SET hourly_cap = $1, daily_cap = $2, pending_hourly_cap = 0, pending_daily_cap = 0,
           caps_effective_after_hour = 0 WHERE address = $3`,
        [args.hourlyCap, args.dailyCap, buyer],
      )
      return
    }
    case "CapsChangeRequested": {
      const buyer = addr(args.buyer)
      await touchBuyer(tx, buyer)
      await tx.query(
        `UPDATE chain.buyers SET pending_hourly_cap = $1, pending_daily_cap = $2, caps_effective_after_hour = $3
         WHERE address = $4`,
        [args.hourlyCap, args.dailyCap, args.effectiveAfterHour, buyer],
      )
      return
    }
    case "WithdrawAllRequested": {
      const buyer = addr(args.buyer)
      await touchBuyer(tx, buyer)
      await tx.query("UPDATE chain.buyers SET withdraw_requested_at = $1 WHERE address = $2", [args.requestedAt, buyer])
      return
    }
    case "WithdrawAllCancelled":
      await tx.query("UPDATE chain.buyers SET withdraw_requested_at = 0 WHERE address = $1", [addr(args.buyer)])
      return
    case "WithdrawAllExecuted":
      await tx.query("UPDATE chain.buyers SET balance = 0, withdraw_requested_at = 0 WHERE address = $1", [addr(args.buyer)])
      return
    case "Refunded": {
      const payer = addr(args.payer)
      await touchBuyer(tx, payer)
      await tx.query("UPDATE chain.buyers SET balance = balance + $1 WHERE address = $2", [args.amount, payer])
      await tx.query(
        `INSERT INTO chain.refunds_paid (refund_id, payer, amount, tx_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [args.refundId, payer, args.amount, e.txHash],
      )
      await tx.query(
        `UPDATE shared.refunds SET paid_hour = $1 WHERE id IN (SELECT id FROM chain.refund_ids WHERE refund_id = $2)`,
        [hourIndex(e.blockTs), args.refundId],
      )
      return
    }
    case "Settled":
      await applySettled(tx, e)
      return
    case "AgentPoolCredited":
      await applyCollection(tx, e)
      return
    case "Paused":
      await tx.query("UPDATE chain.vault_state SET usage_paused = $1, settles_paused = $2", [args.usagePaused, args.settlesPaused])
      return
    case "SignersChanged":
      await tx.query(
        `INSERT INTO chain.signer_sets (contract, block, signers) VALUES ('OffpeakVault', $1, $2::jsonb)
         ON CONFLICT DO NOTHING`,
        [e.blockNumber, JSON.stringify(args.newSigners)],
      )
      return
  }
}
