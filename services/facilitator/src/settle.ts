import { X402EscrowAbi } from "@offpeak/abis"
import { log, type Db, type Metrics } from "@offpeak/common"
import { parseEventLogs, type Account, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem"
import { recordGas } from "./gas.ts"
import type { PaymentPayload } from "./verify.ts"

const MAX_AUTHORIZE_BATCH = 20

export type Publish = (msg: Record<string, unknown>) => Promise<void> | void

export type RelayDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: Account
  escrow: Address
  metrics: Metrics
  publish: Publish
  nativeUsd: number
  flushMs: number
}

type Queued = { payload: PaymentPayload["payload"]; reqId: Hex; payer: Address }

function permitOf(item: Queued) {
  const { payload } = item
  return {
    permitted: { token: payload.permitted.token, amount: BigInt(payload.permitted.amount) },
    nonce: BigInt(payload.nonce),
    deadline: BigInt(payload.deadline),
  }
}

function uptoCall(item: Queued) {
  const w = item.payload.witness
  return {
    p: permitOf(item),
    sig: item.payload.signature,
    payer: item.payer,
    w: {
      reqId: item.reqId,
      payee: w.payee as Address,
      maxAmount: BigInt(String(w.maxAmount)),
      validBefore: BigInt(String(w.validBefore)),
      resourceHash: w.resourceHash as Hex,
    },
  }
}

function exactWitness(item: Queued) {
  const w = item.payload.witness
  return {
    reqId: item.reqId,
    payee: w.payee as Address,
    amount: BigInt(String(w.amount)),
    validBefore: BigInt(String(w.validBefore)),
    resourceHash: w.resourceHash as Hex,
  }
}

function jsonArgs(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))
}

/** Sends `authorize` and `exact` to the chain in small batches, on a clock rather than per block, since blocks arrive every 0.1 s. */
export class RelayBatcher {
  private authorizations: Queued[] = []
  private exacts: Queued[] = []
  private timer: Timer | null = null
  private flushing = false

  constructor(private deps: RelayDeps) {}

  enqueue(mode: "authorize" | "exact", item: Queued) {
    ;(mode === "exact" ? this.exacts : this.authorizations).push(item)
    if (this.authorizations.length >= MAX_AUTHORIZE_BATCH) void this.flush()
  }

  start() {
    this.timer = setInterval(() => void this.flush(), this.deps.flushMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  pending() {
    return this.authorizations.length + this.exacts.length
  }

  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.authorizations.length > 0) await this.sendAuthorizations(this.authorizations.splice(0, MAX_AUTHORIZE_BATCH))
      for (const item of this.exacts.splice(0)) await this.sendExact(item)
    } finally {
      this.flushing = false
    }
  }

  private async sendAuthorizations(items: Queued[]) {
    try {
      const hash = await this.deps.writer.writeContract({
        address: this.deps.escrow,
        abi: X402EscrowAbi,
        functionName: "authorizeBatch",
        args: [items.map(uptoCall)],
        account: this.deps.account,
        chain: null,
      })
      await this.mark(items, "submitted", hash)
      const receipt = await this.deps.reader.waitForTransactionReceipt({ hash })
      await this.announce(receipt, items)
    } catch (err) {
      await this.fail(items, String(err).slice(0, 200))
    }
  }

  private async sendExact(item: Queued) {
    try {
      const hash = await this.deps.writer.writeContract({
        address: this.deps.escrow,
        abi: X402EscrowAbi,
        functionName: "settleExact",
        args: [permitOf(item), item.payload.signature, item.payer, exactWitness(item)],
        account: this.deps.account,
        chain: null,
      })
      await this.mark([item], "submitted", hash)
      await this.announce(await this.deps.reader.waitForTransactionReceipt({ hash }), [item])
    } catch (err) {
      await this.fail([item], String(err).slice(0, 200))
    }
  }

  /** Confirmation goes out from the receipt, ahead of the indexer's confirmation lane. */
  private async announce(receipt: TransactionReceipt, items: Queued[]) {
    const { metrics, nativeUsd, publish } = this.deps
    recordGas(metrics, receipt, items.length, nativeUsd)
    const events = parseEventLogs({ abi: X402EscrowAbi, logs: receipt.logs })
    const settled = new Set<string>()
    for (const event of events) {
      if (event.eventName !== "Authorized" && event.eventName !== "ExactSettled" && event.eventName !== "AuthorizeFailed") continue
      const args = event.args as { reqId: Hex; reason?: Hex }
      const failed = event.eventName === "AuthorizeFailed"
      settled.add(args.reqId.toLowerCase())
      await this.deps.db.query("UPDATE chain.x402_claims SET status = $1, tx_hash = $2, reason = $3 WHERE req_id = $4", [
        failed ? "failed" : "confirmed",
        receipt.transactionHash,
        failed ? (args.reason ?? null) : null,
        args.reqId.toLowerCase(),
      ])
      await publish({ type: event.eventName, ...jsonArgs(event.args as Record<string, unknown>), block: Number(receipt.blockNumber), txHash: receipt.transactionHash })
    }
    const silent = items.filter((item) => !settled.has(item.reqId.toLowerCase()))
    if (silent.length > 0) await this.fail(silent, "no_event_in_receipt")
  }

  private async mark(items: Queued[], status: string, hash: Hex) {
    await this.deps.db.query("UPDATE chain.x402_claims SET status = $1, tx_hash = $2 WHERE req_id = ANY($3)", [
      status,
      hash,
      items.map((item) => item.reqId.toLowerCase()),
    ])
  }

  /** The router stops the stream on this message, since the money never moved. */
  private async fail(items: Queued[], reason: string) {
    log("facilitator", "authorize_failed", { reqIds: items.map((item) => item.reqId), reason })
    for (const item of items) {
      await this.deps.db.query("UPDATE chain.x402_claims SET status = 'failed', reason = $1 WHERE req_id = $2", [reason, item.reqId.toLowerCase()])
      await this.deps.publish({ type: "AuthorizeFailed", reqId: item.reqId, reason, block: 0, txHash: null })
    }
  }
}

/** Queues a payment that passed verify. Nothing here waits on the chain, so it answers inside the 50 ms budget. */
export async function acceptSettle(db: Db, batcher: RelayBatcher, payment: PaymentPayload, mode: "authorize" | "exact") {
  const reqId = String(payment.payload.witness.reqId).toLowerCase() as Hex
  const claims = await db.query<{ payer: string; scheme: string; status: string }>("SELECT payer, scheme, status FROM chain.x402_claims WHERE req_id = $1", [reqId])
  const claim = claims.rows[0]
  if (!claim) return { success: false, txHash: null, status: "submitted" as const, errorReason: "not_verified" }
  if (claim.status !== "accepted") return { success: false, txHash: null, status: "submitted" as const, errorReason: "already_settled" }
  if ((mode === "exact") !== (claim.scheme === "exact")) return { success: false, txHash: null, status: "submitted" as const, errorReason: "wrong_mode" }
  await db.query("UPDATE chain.x402_claims SET status = 'submitted' WHERE req_id = $1 AND status = 'accepted'", [reqId])
  batcher.enqueue(mode, { payload: payment.payload, reqId, payer: claim.payer as Address })
  return { success: true, txHash: null, status: "submitted" as const }
}
