import { randomBytes } from "node:crypto"
import { ZERO_BYTES32, ceilDiv, channelAuthMessage, domain, hourIndex, voucherTypes, type BuyerChain, type ChannelChain, type Hex, type PaymentPayload } from "@offpeak/shared"
import { keccak256, toBytes } from "viem"
import { acceptVoucher, claimPaymentId, releaseChannel, reserveChannel } from "./channel-store.ts"
import { creditLimit } from "./channel.ts"
import { paymentRequired } from "./x402.ts"
import { admitWindow, pendingKey } from "./window.ts"
import { effectiveCaps, type HoldView } from "./prepaid.ts"
import { verifyPersonal, verifyTyped, type SigVerdict } from "./signatures.ts"
import { settleAuthorization } from "../chainview/push.ts"
import type { PayHold, Payer, Stack } from "../context.ts"
import { oai } from "../http.ts"

const CHANNEL_PROOF_WINDOW_S = 60
/** Each of these can serve the pre-confirmation budget and then fail unbilled, so this bounds what one wallet can get that way. */
const MAX_UNCONFIRMED = 8n
/** Past the longest a request waits for the chain, so a router that dies gives its slots back. */
const UNCONFIRMED_TTL_S = 60
const WINDOW_LOOKBACK_HOURS = 48
/** A falling price can leave `exact` a little above the quote between a 402 and its retry. Settlement refunds any excess from the reserve. */
const EXACT_MARGIN_BPS = 11_000n
const EXACT_MARGIN_MIN_MICRO = 100n
const WINDOW_REFUSED: Record<string, string> = {
  window_exhausted: "Window is exhausted",
  window_not_active: "Window is not active",
  window_wrong_model: "Window is for another model",
}

const unverified = () => oai(503, "Could not check the wallet's signature", "server_error", "verify_unavailable")

/** Draws not yet on chain, by hour, so a settled hour stops counting once `drawnTokens` includes it. */
async function windowPending(stack: Stack, id: bigint, wallet: string, lastSettledHour: bigint) {
  const hour = hourIndex(stack.clock())
  const oldest = Math.max(Number(lastSettledHour) + 1, hour - WINDOW_LOOKBACK_HOURS)
  const hours = Array.from({ length: Math.max(hour - oldest + 1, 0) }, (_, i) => oldest + i)
  const values = await Promise.all(hours.map((h) => stack.counters.get(pendingKey(id, wallet, h))))
  return values.reduce((sum, value) => sum + value, 0n)
}

/**
 * Settles who pays before a host or price is chosen. A Window that cannot cover the request either
 * ends it or, when the buyer asked, turns it into an ordinary prepaid request at the prepaid price.
 */
export async function resolveWindow(stack: Stack, payer: Payer, req: Request, tokensIn: number, maxOut: number, modelDigest: Hex): Promise<Payer | { reservedTokens: bigint; pendingKey: string; payer: Payer } | Response> {
  if (payer.mode !== 4) return payer
  const prepaidInstead = (code: string = "window_exhausted") =>
    req.headers.get("x-offpeak-window-fallback") === "prepaid"
      ? ({ mode: 0, accountId: payer.accountId, wallet: payer.wallet, feeBps: payer.prepaidFeeBps } as const)
      : oai(402, WINDOW_REFUSED[code] ?? "Window is exhausted", "payment", code)
  const win = await stack.indexer.window(payer.windowId.toString())
  const holder = await stack.indexer.holder(payer.windowId.toString(), payer.wallet)
  if (!win || !holder || holder.balance <= 0n) return prepaidInstead()
  if (win.modelDigest !== modelDigest) return prepaidInstead("window_wrong_model")
  if (win.failed) return prepaidInstead("window_not_active")
  const need = BigInt(tokensIn + maxOut)
  const key = pendingKey(payer.windowId, payer.wallet, hourIndex(stack.clock()))
  const buyer = await stack.indexer.buyer(payer.wallet, stack.clock())
  await stack.counters.add(key, need, 3 * 86_400)
  const pending = await windowPending(stack, payer.windowId, payer.wallet, buyer.lastSettledHour).catch(async (err) => {
    await stack.counters.add(key, -need, 3 * 86_400)
    throw err
  })
  const left = holder.balance * 1_000_000n - holder.drawnTokens - pending
  const decision = admitWindow({ now: stack.clock(), t0: Number(win.t0), t1: Number(win.t1), available: left >= 0n ? left + need : 0n, tokensInEst: tokensIn, maxTokensOut: maxOut })
  if (decision.ok) return { payer, reservedTokens: need, pendingKey: key }
  await stack.counters.add(key, -need, 3 * 86_400)
  return prepaidInstead(decision.error)
}

/** Checks a voucher's signature and takes it. A `Response` means it was refused. */
export async function applyVoucher(stack: Stack, ch: ChannelChain, channelId: Hex, voucher: { seq: bigint; cumulative: bigint; sig: Hex }) {
  const signed = await verifyTyped(
    stack,
    ch.payer,
    {
      domain: domain("OffpeakChannel", stack.channelManager),
      types: voucherTypes,
      primaryType: "Voucher",
      message: { channelId, seq: voucher.seq, cumulative: voucher.cumulative },
    },
    voucher.sig,
  )
  if (signed === "unavailable") return unverified()
  if (signed === "bad") return oai(402, "Voucher signer is not the payer", "payment", "bad_voucher")
  const accepted = await acceptVoucher(stack.db, ch, channelId, voucher, { contract: signed === "contract" })
  if (accepted === "bad_boundary") return oai(402, "Voucher is not on a reported boundary", "payment", "bad_voucher")
  if (accepted === "closing") return oai(409, "Channel is closing", "invalid_request", "channel_closing")
  if (accepted === "payment_id_taken") return oai(409, "This sequence number's payment id is taken", "invalid_request", "payment_id_taken")
  return null
}

/** A channel id is public, so every request proves the payer sent it. */
export async function channelProof(stack: Stack, ch: ChannelChain, channelId: Hex, proof: { ts: number; nonce: string; sig: Hex } | undefined, rawBody: string): Promise<SigVerdict> {
  if (!proof || Math.abs(stack.clock() - proof.ts) > CHANNEL_PROOF_WINDOW_S) return "bad"
  const message = channelAuthMessage({ channelId, ts: proof.ts, nonce: proof.nonce, bodyHash: keccak256(toBytes(rawBody)) })
  const signed = await verifyPersonal(stack, ch.payer, message, proof.sig)
  if (signed === "bad" || signed === "unavailable") return signed
  // Keyed on the message, since a signature can have two valid forms and a wallet may reuse its bytes.
  const used = await stack.counters.add(`offpeak:proof:${keccak256(toBytes(message))}`, 1n, CHANNEL_PROOF_WINDOW_S * 3)
  return used === 1n ? signed : "bad"
}

/** Checks a channel request's proof once, as early as its route can. A `Response` means it was refused. */
export async function proveChannel(stack: Stack, payer: Extract<Payer, { mode: 3 }>, rawBody: string) {
  const ch = await stack.indexer.channel(payer.channelId)
  if (!ch) return oai(402, "Unknown channel", "payment", "payment_required")
  const proved = await channelProof(stack, ch, payer.channelId, payer.proof, rawBody)
  if (proved === "unavailable") return unverified()
  if (proved === "bad") return oai(401, "Channel request is not signed by the payer", "auth", "bad_channel_auth")
  payer.proved = proved
  return null
}

/** The buyer's chain state as admission reads it, with any pending lower cap already applied. */
export function holdView(stack: Stack, buyer: BuyerChain): HoldView {
  const caps = effectiveCaps(buyer.hourlyCap, buyer.dailyCap, buyer.pendingHourlyCap, buyer.pendingDailyCap, buyer.capsEffectiveAfterHour > 0n)
  return {
    servable: buyer.servable,
    hourlyCap: caps.hourlyCap,
    dailyCap: caps.dailyCap,
    balance: buyer.balance,
    hour: hourIndex(stack.clock()),
    day: Math.floor(stack.clock() / 86400),
    lastSettledHour: buyer.lastSettledHour,
  }
}

export function insufficientReserve(buyer: BuyerChain, view: HoldView) {
  return oai(402, "Reserve or caps are exhausted", "payment", "insufficient_reserve", { available: buyer.balance.toString(), hourly_remaining: view.hourlyCap.toString(), daily_remaining: view.dailyCap.toString() })
}

/** Why a buyer cannot be served at all, whatever the amount. */
export function buyerRefused(stack: Stack, buyer: BuyerChain) {
  if (buyer.servable) return null
  if (buyer.reason === "withdraw_requested") return oai(403, "Withdraw-all is pending", "auth", "withdraw_pending")
  if (buyer.reason === "paused") return oai(403, "Usage is paused", "auth", "paused")
  return insufficientReserve(buyer, holdView(stack, buyer))
}

export async function authorize(stack: Stack, payer: Payer, maxCostMicro: bigint, rawBody: string, windowRun?: { reservedTokens: bigint; pendingKey: string }, fromHold?: string): Promise<PayHold | Response> {
  if (payer.mode === 0) {
    const buyer = await stack.indexer.buyer(payer.wallet, stack.clock())
    const refused = buyerRefused(stack, buyer)
    if (refused) return refused
    const view = holdView(stack, buyer)
    const holdId = `hold_${randomBytes(8).toString("hex")}`
    const admitted = await stack.ledger.admit(payer.wallet, maxCostMicro, view, holdId, stack.clock(), undefined, fromHold)
    if (!admitted.ok) return insufficientReserve(buyer, view)
    return { kind: "prepaid", holdId, wallet: payer.wallet, max: maxCostMicro, payRef: ZERO_BYTES32 }
  }
  if (payer.mode === 3) {
    const refused = payer.proved ? null : await proveChannel(stack, payer, rawBody)
    if (refused) return refused
    const ch = await stack.indexer.channel(payer.channelId)
    if (!ch) return oai(402, "Unknown channel", "payment", "payment_required")
    if (payer.voucher) {
      const voucherRefused = await applyVoucher(stack, ch, payer.channelId, payer.voucher)
      if (voucherRefused) return voucherRefused
    }
    const decision = await reserveChannel(stack.db, ch, payer.channelId, maxCostMicro, stack.clock(), { contractPayer: payer.proved === "contract" })
    if (!decision.ok) return oai(402, decision.error, "payment", decision.error)
    return { kind: "channel", channelId: payer.channelId, reservationId: decision.reservationId, wallet: ch.payer as Hex, max: maxCostMicro, payRef: payer.channelId }
  }
  if (payer.mode !== 4) {
    const exact = payer.mode === 2 ? witnessAmount(payer.payment) : null
    if (payer.mode === 2 && (exact === null || exact < maxCostMicro || exact > exactCeiling(maxCostMicro))) return paymentRequiredResponse(stack, maxCostMicro, true)
    const verified = await stack.facilitator.verify({
      paymentPayload: payer.payment,
      paymentRequirements: { payTo: stack.vault, asset: stack.usdg, maxAmountRequired: maxCostMicro.toString() },
    })
    if (!verified.isValid) return oai(402, verified.invalidReason ?? "invalid", "payment", "payment_required")
    const reqId = String(payer.payment.payload.witness.reqId).toLowerCase()
    if (!(await holdUnconfirmedSlot(stack, verified.payer as string, reqId))) return oai(429, "Too many payments from this wallet are waiting for the chain", "rate_limit", "unconfirmed_limit")
    // For `exact` this comes before the money can move, so a crash at any later point still leaves a row for the sweep to refund.
    const claimed = await claimPaymentId(stack.db, {
      reqId,
      payer: verified.payer as string,
      amount: exact ?? maxCostMicro,
      status: exact !== null ? "submitted" : "upto",
      validBefore: String(payer.payment.payload.witness.validBefore ?? 0),
      now: stack.clock(),
    })
    if (!claimed) return oai(402, "This payment's reqId is taken", "payment", "payment_id_taken")
    void Promise.resolve(stack.facilitator.settle({ paymentPayload: payer.payment, mode: exact !== null ? "exact" : "authorize" }))
      .then((result) => {
        if ((result as { success?: boolean }).success === false) settleAuthorization(stack, reqId, "fail")
      })
      .catch(() => settleAuthorization(stack, reqId, "fail"))
    if (exact !== null) return { kind: "exact", wallet: verified.payer as Hex, max: maxCostMicro, payRef: reqId as Hex, paid: exact }
    return { kind: "upto", wallet: verified.payer as Hex, max: maxCostMicro, payRef: reqId as Hex }
  }
  return {
    kind: "window",
    wallet: payer.wallet,
    max: maxCostMicro,
    payRef: `0x${payer.windowId.toString(16).padStart(64, "0")}` as Hex,
    windowId: payer.windowId,
    pendingKey: windowRun!.pendingKey,
    reservedTokens: windowRun!.reservedTokens,
  }
}

export async function release(stack: Stack, pay: PayHold) {
  if (pay.kind === "prepaid") await stack.ledger.release(pay.wallet, pay.holdId)
  if (pay.kind === "channel") await releaseChannel(stack.db, pay.reservationId)
  if (pay.kind === "window") await stack.counters.add(pay.pendingKey, -pay.reservedTokens, 3 * 86_400)
  if (pay.kind === "upto") await stack.db.query("DELETE FROM serving.x402_requests WHERE req_id = $1 AND status = 'upto'", [pay.payRef])
  // The money may already be on chain. The sweep refunds it once the chain says so.
  if (pay.kind === "exact") await stack.db.query("UPDATE serving.x402_requests SET status = 'refund_due' WHERE req_id = $1 AND status = 'submitted'", [pay.payRef])
}

/** A slot lasts until the chain answers for this payment, or a request would have given up waiting for it. */
async function holdUnconfirmedSlot(stack: Stack, wallet: string, reqId: string) {
  const key = `offpeak:unconfirmed:${wallet.toLowerCase()}`
  const free = () => stack.counters.add(key, -1n, UNCONFIRMED_TTL_S)
  if ((await stack.counters.add(key, 1n, UNCONFIRMED_TTL_S)) > MAX_UNCONFIRMED) {
    await free()
    return false
  }
  void waitAuthorized(stack, reqId, stack.preconfirmTimeoutMs)
    .then(free)
    .catch((err) => console.error(JSON.stringify({ service: "router", event: "unconfirmed_slot_failed", reqId, error: String(err) })))
  return true
}

function exactCeiling(quote: bigint) {
  const scaled = ceilDiv(quote * EXACT_MARGIN_BPS, 10_000n)
  return scaled > quote + EXACT_MARGIN_MIN_MICRO ? scaled : quote + EXACT_MARGIN_MIN_MICRO
}

function witnessAmount(payment: PaymentPayload) {
  const amount = String(payment.payload.witness.amount ?? "")
  return /^\d{1,30}$/.test(amount) ? BigInt(amount) : null
}

export async function waitAuthorized(stack: Stack, reqId: string, timeoutMs: number): Promise<"ok" | "fail" | "timeout"> {
  const key = reqId.toLowerCase()
  const known = stack.authResults.get(key)
  if (known) return known
  const decided = new Promise<"ok" | "fail" | "timeout">((resolve) => {
    const finish = (kind: string) => {
      clearTimeout(timer)
      resolve(kind === "fail" ? "fail" : "ok")
    }
    const timer = setTimeout(() => {
      const list = stack.authWaiters.get(key)?.filter((fn) => fn !== finish) ?? []
      if (list.length > 0) stack.authWaiters.set(key, list)
      else stack.authWaiters.delete(key)
      resolve("timeout")
    }, timeoutMs)
    stack.authWaiters.set(key, [...(stack.authWaiters.get(key) ?? []), finish])
  })
  const row = await stack.indexer.escrow(key).catch(() => null)
  if (row?.status === "authorized" || row?.status === "captured") settleAuthorization(stack, key, "ok")
  return decided
}

export function paymentRequiredResponse(stack: Stack, maxAmount: bigint, exact: boolean) {
  const reqId = `0x${randomBytes(32).toString("hex")}` as Hex
  const built = paymentRequired({
    asset: stack.usdg as Hex,
    channelManager: stack.channelManager as Hex,
    payee: stack.channelPayee.toLowerCase() as Hex,
    vault: stack.vault as Hex,
    permit2: stack.permit2,
    escrow: stack.escrow as Hex,
    maxAmount,
    reqId,
    validBefore: stack.clock() + 600,
    resourceHash: ZERO_BYTES32,
    exact,
    creditLimit: creditLimit(1_000_000n).toString(),
    channels: stack.flags.channels,
    x402: stack.flags.upto,
  })
  const message = built.accepts.length > 0 ? "Payment required" : "Send an API key. Only prepaid balances are switched on"
  return Response.json({ x402Version: 2, accepts: built.accepts, error: { message, type: "payment", code: "payment_required" } }, {
    status: 402,
    headers: { "payment-required": JSON.stringify({ accepts: built.accepts }) },
  })
}
