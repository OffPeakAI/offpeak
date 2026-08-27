import { domain, hourIndex, leafFor, recordToMessage, serializeEnvelope, serializeRecord, signTyped, usageTypes, type Hex, type UsageRecord } from "@offpeak/shared"
import type { PayHold, Payer, Stack } from "../context.ts"
import { queueCapture } from "../pay/captures.ts"
import { noteChannel } from "../pay/channel-store.ts"
import { captureTx } from "../store.ts"

const SIGN_TIMEOUT_MS = 10_000

export type Commit = {
  stack: Stack
  payer: Payer
  pay: PayHold
  feeBps: number
  record: UsageRecord
  host: string
  endpoint: string
  ttftMs: number
  /** The host may have produced more than the record bills, because the stream was cut. */
  partial?: boolean
  /** The hashes are over ciphertext and the counts are the attested host's. */
  sealed?: boolean
}

export async function flagMetering(stack: Stack, reqId: string, host: string, counts: unknown, hostCounts: unknown, reason: string) {
  await stack.db.query(`INSERT INTO serving.metering_flags (req_id, host, router_counts, host_counts, reason) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT (req_id) DO NOTHING`, [
    reqId,
    host,
    JSON.stringify(counts),
    JSON.stringify(hostCounts),
    reason,
  ])
}

/** Signs a record, gets the host's signature, and takes payment in the one transaction that stores it. */
export async function commitRecord(commit: Commit) {
  const { stack, payer, pay, feeBps, record, host, endpoint, ttftMs, partial } = commit
  const sealed = commit.sealed === true
  const { reqId, ts } = record
  const routerSig = await signTyped(stack.router, {
    domain: domain("OffpeakUsage", stack.usageLedger),
    types: usageTypes,
    primaryType: "UsageRecord",
    message: recordToMessage(record) as never,
  })
  const signed = await stack.hosts.request(host, endpoint, "/offpeak/v1/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ record: serializeRecord(record), routerSig, partial }),
    signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
  })
  const signBody = (await signed.json()) as { hostSig: Hex; hostCounts: { tokensIn: number; tokensOut: number }; reason?: string }
  if (!signed.ok) return { refused: signBody.reason ?? "sign_refused", hostCounts: signBody.hostCounts ?? {} }
  const envelope = serializeEnvelope({
    v: 1,
    record,
    routerSig,
    hostSig: signBody.hostSig,
    leaf: leafFor(record, routerSig, signBody.hostSig),
    hostCounts: signBody.hostCounts,
    sealed,
    proofUrl: `/v1/usage/${reqId}`,
  })
  const hour = hourIndex(ts)
  const actual = record.hostCostMicro + record.feeMicro
  let channelOwed: bigint | undefined
  await captureTx(
    stack.db,
    {
      reqId,
      hour,
      ts,
      payer: pay.wallet,
      buyerRef: record.buyerRef,
      host: record.host,
      modelDigest: record.modelDigest,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      promptHash: record.promptHash,
      outputHash: record.outputHash,
      priceIn: record.priceIn,
      priceOut: record.priceOut,
      hostCostMicro: record.hostCostMicro,
      feeMicro: record.feeMicro,
      feeBps,
      payMode: record.payMode,
      payRef: record.payRef,
      sheetHash: record.sheetHash,
      windowId: pay.kind === "window" ? pay.windowId.toString() : undefined,
      routerSig,
      hostSig: signBody.hostSig,
      leaf: envelope.leaf,
      sealed,
    },
    {
      reqId,
      accountId: payer.mode === 0 ? payer.accountId : null,
      wallet: pay.wallet,
      modelDigest: record.modelDigest,
      host,
      payMode: record.payMode,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      ttftMs,
      durationMs: Math.round((stack.clock() - ts) * 1000),
      status: "ok",
      errorCode: null,
      sealed,
      ts,
      hostCounts: signBody.hostCounts,
    },
    async (tx) => {
      if (pay.kind === "prepaid") await queueCapture(tx, { reqId, kind: "prepaid", wallet: pay.wallet, holdId: pay.holdId, hour, amount: actual })
      if (pay.kind === "upto") {
        await tx.query(`INSERT INTO shared.agent_payments (payment_id, kind, payer, amount_micro, req_ids) VALUES ($1,'upto',$2,$3,$4)`, [pay.payRef, pay.wallet, actual.toString(), [reqId]])
        await queueCapture(tx, { reqId, kind: "upto", wallet: pay.wallet, holdId: pay.payRef, hour, amount: actual })
      }
      if (pay.kind === "exact") {
        // What was collected, which a falling price can leave above the record. Settlement refunds that difference.
        await tx.query(`INSERT INTO shared.agent_payments (payment_id, kind, payer, amount_micro, req_ids) VALUES ($1,'exact',$2,$3,$4)`, [pay.payRef, pay.wallet, pay.paid.toString(), [reqId]])
        await tx.query("UPDATE serving.x402_requests SET status = 'served' WHERE req_id = $1", [pay.payRef])
      }
      if (pay.kind === "channel") channelOwed = await noteChannel(tx, pay.wallet, pay.channelId, pay.reservationId, actual, reqId)
    },
  )
  return { envelope, channelOwed }
}
