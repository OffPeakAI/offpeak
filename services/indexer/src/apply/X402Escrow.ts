import type { Db } from "@offpeak/common"
import type { ChainEvent } from "./index.ts"

export async function applyX402Escrow(tx: Db, e: ChainEvent) {
  const args = e.args
  const reqId = String(args.reqId).toLowerCase()
  switch (e.event) {
    case "Authorized":
      await tx.query(
        `INSERT INTO chain.escrows (req_id, payer, max_amount, valid_before, status, tx_hash) VALUES ($1,$2,$3,$4,'authorized',$5)
         ON CONFLICT (req_id) DO NOTHING`,
        [reqId, String(args.payer).toLowerCase(), args.maxAmount, args.validBefore, e.txHash],
      )
      return
    case "Captured":
      await tx.query("UPDATE chain.escrows SET status = 'captured', captured = $1, tx_hash = $2 WHERE req_id = $3", [args.actual, e.txHash, reqId])
      return
    case "ExactSettled":
      await tx.query(
        `INSERT INTO chain.escrows (req_id, payer, max_amount, captured, status, tx_hash) VALUES ($1,$2,$3,$3,'captured',$4)
         ON CONFLICT (req_id) DO NOTHING`,
        [reqId, String(args.payer).toLowerCase(), args.amount, e.txHash],
      )
      return
    case "Expired":
      await tx.query("UPDATE chain.escrows SET status = 'expired', tx_hash = $1 WHERE req_id = $2", [e.txHash, reqId])
      return
  }
}
