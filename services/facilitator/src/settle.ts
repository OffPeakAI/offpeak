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
