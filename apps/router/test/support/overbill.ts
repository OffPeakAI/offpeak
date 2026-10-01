import { domain, parseRecord, quoteCost, recordToMessage, signTyped, usageTypes } from "@offpeak/shared"
import { roleAccount } from "../../../../packages/shared/src/test-keys.ts"
import type { bootStack } from "./stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

/** Rewrites a record the way a metering or pricing bug would have left it: wrong, and properly signed. */
export async function resignedOverbill(booted: Booted, reqId: string, tokensOut: number, price?: { in: bigint; out: bigint }) {
  const row = (await booted.stack.db.query<Record<string, any>>("SELECT * FROM shared.usage_records WHERE req_id = $1", [reqId])).rows[0]!
  const priceIn = price?.in ?? BigInt(row.price_in)
  const priceOut = price?.out ?? BigInt(row.price_out)
  const cost = quoteCost({ tokensIn: row.tokens_in, tokensOut, priceIn, priceOut, feeBps: row.fee_bps })
  const record = parseRecord({
    reqId: row.req_id,
    buyerRef: row.buyer_ref,
    host: row.host,
    modelDigest: row.model_digest,
    tokensIn: row.tokens_in,
    tokensOut,
    promptHash: row.prompt_hash,
    outputHash: row.output_hash,
    priceIn: priceIn.toString(),
    priceOut: priceOut.toString(),
    hostCostMicro: cost.hostCostMicro.toString(),
    feeMicro: cost.feeMicro.toString(),
    payMode: row.pay_mode,
    payRef: row.pay_ref,
    ts: Number(row.ts),
    sheetHash: row.sheet_hash,
  })
  const sign = (account: never) => signTyped(account, { domain: domain("OffpeakUsage", booted.stack.usageLedger), types: usageTypes, primaryType: "UsageRecord", message: recordToMessage(record) as never })
  const routerSig = await sign(booted.stack.router as never)
  const hostSig = await sign(roleAccount("host") as never)
  await booted.stack.db.exec("ALTER TABLE shared.usage_records DISABLE TRIGGER USER")
  await booted.stack.db.query("UPDATE shared.usage_records SET tokens_out = $2, host_cost_micro = $3, fee_micro = $4, router_sig = $5, host_sig = $6, price_in = $7, price_out = $8 WHERE req_id = $1", [
    reqId,
    tokensOut,
    cost.hostCostMicro.toString(),
    cost.feeMicro.toString(),
    routerSig,
    hostSig,
    priceIn.toString(),
    priceOut.toString(),
  ])
  await booted.stack.db.exec("ALTER TABLE shared.usage_records ENABLE TRIGGER USER")
  return cost
}
