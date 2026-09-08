import { storeSignature, type Db } from "@offpeak/common"
import type { RootTotals } from "@offpeak/shared"
import type { Hex, LocalAccount } from "viem"
import type { BuiltHour, PayerRefund, Reject, SettleBatch, Sweep } from "./build.ts"

export type StoredBatch = {
  b: SettleBatch
  t: RootTotals
  rejects: Reject[]
  payments: { drawn: Hex[]; writtenOff: Hex[]; orphans: string[]; swept: Sweep[]; refunds: PayerRefund[] }
}

/** Revives what JSON flattened. The contract call needs real bigints back. */
export function reviveBatch(stored: StoredBatch): { b: SettleBatch; t: RootTotals } {
  const { b, t } = stored
  return {
    b: {
      ...b,
      chainId: BigInt(b.chainId),
      hour: BigInt(b.hour),
      debits: b.debits.map((d) => ({ ...d, amount: BigInt(d.amount), lastTs: BigInt(d.lastTs) })),
      credits: b.credits.map((c) => ({ ...c, amount: BigInt(c.amount) })),
      windowDraws: b.windowDraws.map((w) => ({ ...w, windowId: BigInt(w.windowId), tokens: BigInt(w.tokens) })),
      fees: BigInt(b.fees),
      agentPoolDraw: BigInt(b.agentPoolDraw),
      reserveDraw: BigInt(b.reserveDraw),
    },
    t: {
      records: Number(t.records),
      tokensIn: BigInt(t.tokensIn),
      tokensOut: BigInt(t.tokensOut),
      prepaidDebit: BigInt(t.prepaidDebit),
      agentCollected: BigInt(t.agentCollected),
      windowDrawn: BigInt(t.windowDrawn),
      hostCredit: BigInt(t.hostCredit),
      fees: BigInt(t.fees),
    },
  }
}

export async function signHour(db: Db, account: LocalAccount, built: BuiltHour) {
  const sig = await account.sign!({ hash: built.batchHash })
  const stored: StoredBatch = {
    b: built.b,
    t: built.t,
    rejects: built.rejects,
    payments: { drawn: built.drawn, writtenOff: built.writtenOff, orphans: built.orphans, swept: built.swept, refunds: built.refunds },
  }
  await storeSignature(db, "settle", Number(built.b.hour), account.address, built.batchHash, sig, stored)
  await db.query(
    `INSERT INTO chain.settlements_audit (hour, records, rejected, close_matched) VALUES ($1,$2,$3,$4)
     ON CONFLICT (hour) DO UPDATE SET records = $2, rejected = $3, close_matched = $4`,
    [built.b.hour, built.t.records, built.rejects.length, built.closeMatched],
  )
}
