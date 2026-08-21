import {
  FEE_BPS_DEFAULT,
  HOST_STATUS,
  MAX_OUTPUT_TOKENS,
  MAX_REQUEST_S,
  ZERO_BYTES32,
  askedTokens,
  buyerRefOf,
  buyerUnitPrice,
  ceilDiv,
  countText,
  hostChatBody,
  hourIndex,
  hourOfWeek,
  outputHashOf,
  outputLimit,
  promptHashOf,
  quoteCost,
  type ChatMessage,
  type Hex,
  type TokenCounter,
  type UsageRecord,
} from "@offpeak/shared"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { countChat, countOutput, tokenizerFor } from "../metering/tokenize.ts"
import { parseMaxPrice, priceAboveCap } from "../pay/quote.ts"
import { preconfirmReached } from "../pay/x402.ts"
import { livePrice, loadFactorBps } from "../pricing/live.ts"
import { selectHost, type HostCandidate } from "../routing/select.ts"
import { signRouterBody } from "../../../host-agent/src/proxy.ts"
import { assertJsonOutput } from "./json-mode.ts"
import { intakeFlex } from "./batches.ts"
import { commitRecord, flagMetering } from "./commit.ts"
import type { ModelEntry, PayHold, Payer, Stack } from "../context.ts"
import { auth } from "../auth/keys.ts"
import { nextCheaper } from "../offpeak/forecast.ts"
import { authorize, paymentRequiredResponse, release, resolveWindow, waitAuthorized } from "../pay/authorize.ts"
import { flushCapture } from "../pay/captures.ts"
import { noteWindowMinute, type PerfFlow } from "../pay/window-perf.ts"
import { absorb, emptyAssembly, openHost, type Assembled, type HostEvent, type Opened } from "../routing/dispatch.ts"
import { featureOff, oai } from "../http.ts"
import { noteForAudit } from "../audit/capture.ts"
import { isSealed, serveSealed } from "./sealed.ts"

export function sheetFor(stack: Stack, host: string, model: Hex, ts: number) {
  return stack.sheets
    .filter((s) => s.host.toLowerCase() === host.toLowerCase() && s.modelDigest === model && s.validFrom <= ts)
    .sort((a, b) => b.validFrom - a.validFrom)[0]
}

const CANDIDATE_TTL_MS = 200
// Leaves room to bill before the hour closes at its grace period, which equals MAX_REQUEST_S.
const BILLING_MARGIN_S = 30
// Load moves the price between a 402 and the paid retry, and a payment under the new quote is refused.
const QUOTE_MARGIN_BPS = 11_000n

/** A burst for one model shares one view of hosts and prices. Any chain push clears it. */
export async function candidates(stack: Stack, model: Hex, now: number, feeBps: number): Promise<HostCandidate[]> {
  const key = `${model}:${feeBps}:${now}`
  const hit = stack.candidateCache.get(key)
  if (hit && performance.now() - hit.at < CANDIDATE_TTL_MS) return hit.rows
  const rows = await buildCandidates(stack, model, now, feeBps)
  if (stack.candidateCache.size > 64) stack.candidateCache.clear()
  stack.candidateCache.set(key, { at: performance.now(), rows })
  return rows
}

async function buildCandidates(stack: Stack, model: Hex, now: number, feeBps: number): Promise<HostCandidate[]> {
  const how = hourOfWeek(now)
  const out: HostCandidate[] = []
  for (const host of await stack.indexer.hostList()) {
    const sheet = sheetFor(stack, host.operator, model, now)
    if (!sheet) continue
    const serves = host.models.find((m) => m.digest === model)
    if (!serves || !host.endpoint) continue
    if (!host.routable && host.status !== HOST_STATUS.Probation) continue
    const maxTps = serves.maxTps
    const u = stack.load.util(host.operator, model, maxTps, now)
    const price = livePrice(sheet, how, loadFactorBps(u))
    out.push({
      host: host.operator,
      endpoint: host.endpoint,
      priceIn: buyerUnitPrice(price.in, feeBps),
      priceOut: buyerUnitPrice(price.out, feeBps),
      sheetHash: sheet.sheetHash,
      bondUsdg: host.bondUsdg,
      routingBonusBps: host.routingBonusBps,
      strikes: host.strikes,
      auditedSamples: 0,
      util: u,
      healthy: stack.probesOk.has(host.operator.toLowerCase()),
      ttftP95Ms: stack.load.ttftP95(host.operator),
      errorRate: stack.load.errorRate(host.operator),
      status: host.status === 2 ? "Active" : host.status === 1 ? "Probation" : "Frozen",
      sealedOk: Boolean(host.attestationRef && host.attestationRef !== ZERO_BYTES32),
      modelDigest: model,
      maxTps,
    })
  }
  return out
}

export function hostPrice(stack: Stack, candidate: HostCandidate, model: Hex, now: number, locked?: PriceLock) {
  const sheet = sheetFor(stack, candidate.host, model, now)
  if (!sheet) return null
  const u = stack.load.util(candidate.host, model, candidate.maxTps, now)
  return { sheet, price: locked ?? livePrice(sheet, hourOfWeek(now), loadFactorBps(u)) }
}

export type PriceLock = { in: bigint; out: bigint }

type Priced = NonNullable<ReturnType<typeof hostPrice>>

type Ctx = {
  stack: Stack
  reqId: Hex
  started: number
  model: ModelEntry
  modelName: string
  payer: Payer
  pay: PayHold
  feeBps: number
  maxTokens: number
  body: { messages?: ChatMessage[]; tools?: unknown; response_format?: unknown }
  /** The body as it went to the host, which is what `promptHash` covers (3.2). */
  sent: Record<string, unknown>
  /** Worked out before payment, so a body that cannot be billed never reaches a host. */
  promptHash: Hex
  tokensIn: number
  tokenizer: TokenCounter
  flow?: PerfFlow
}

/** Meters what the host served, signs the record and takes payment. `null` means nothing was billed. */
async function bill(ctx: Ctx, opened: Opened, priced: Priced, output: Assembled, ttftMs: number, cut: boolean) {
  const { stack, reqId, started, model, payer, pay, feeBps, body } = ctx
  const toolCalls = output.toolCalls.length > 0 ? output.toolCalls : undefined
  const counted = countOutput(model, output.text, toolCalls, output.finish)
  // A compact tool call can re-render longer than it was generated, so running over here proves nothing against the host.
  const counts = { tokensIn: ctx.tokensIn, tokensOut: Math.min(counted, ctx.maxTokens) }
  let partial = cut || counted > ctx.maxTokens
  stack.load.note(opened.host, model.digest, "prefill", counts.tokensIn, stack.clock())
  stack.load.note(opened.host, model.digest, "output", counts.tokensOut, stack.clock())
  const zero = pay.kind === "window"
  const costOf = (tokensOut: number) => quoteCost({ tokensIn: counts.tokensIn, tokensOut, priceIn: priced.price.in, priceOut: priced.price.out, feeBps })
  if (!zero && costOf(counts.tokensOut).totalMicro > pay.max) {
    // The buyer never pays past the hold. The record bills what fits, so it still equals the charge.
    await flagMetering(stack, reqId, opened.host, counts, {}, "over_hold")
    partial = true
    let fits = 0
    for (let span = counts.tokensOut; span > 0; span = Math.floor(span / 2)) {
      while (fits + span <= counts.tokensOut && costOf(fits + span).totalMicro <= pay.max) fits += span
    }
    counts.tokensOut = fits
    if (costOf(fits).totalMicro > pay.max) {
      await release(stack, pay)
      return null
    }
  }
  const cost = zero ? { hostCostMicro: 0n, feeMicro: 0n, totalMicro: 0n } : costOf(counts.tokensOut)
  const record: UsageRecord = {
    reqId,
    buyerRef: buyerRefOf(pay.wallet, reqId),
    host: opened.host as Hex,
    modelDigest: model.digest,
    tokensIn: counts.tokensIn,
    tokensOut: counts.tokensOut,
    promptHash: ctx.promptHash,
    outputHash: outputHashOf(output.text, toolCalls ?? []),
    priceIn: zero ? 0n : priced.price.in,
    priceOut: zero ? 0n : priced.price.out,
    hostCostMicro: zero ? 0n : cost.hostCostMicro,
    feeMicro: zero ? 0n : cost.feeMicro,
    payMode: zero ? 4 : payer.mode,
    payRef: pay.payRef,
    ts: started,
    sheetHash: priced.sheet.sheetHash,
  }
  const committed = await commitRecord({ stack, payer, pay, feeBps, record, host: opened.host, endpoint: opened.endpoint, ttftMs, partial })
  if ("refused" in committed) {
    await release(stack, pay)
    await flagMetering(stack, reqId, opened.host, counts, committed.hostCounts, committed.refused ?? "sign_refused")
    return null
  }
  // The record is final from here. Nothing below can undo it, so nothing below may fail the request.
  void noteForAudit(stack, { reqId, host: opened.host, modelDigest: model.digest, accountId: "accountId" in payer ? payer.accountId : null, body: ctx.sent, text: output.text, toolCalls: toolCalls ?? [], ts: started }, body)
  await afterCommit(ctx, counts).catch((err) => console.error(JSON.stringify({ service: "router", event: "after_commit_failed", reqId, error: String(err) })))
  return { envelope: committed.envelope, channelOwed: committed.channelOwed, counts }
}

async function afterCommit(ctx: Ctx, counts: { tokensIn: number; tokensOut: number }) {
  const { stack, reqId, pay } = ctx
  if (pay.kind === "prepaid" || pay.kind === "upto") await flushCapture(stack, reqId)
  if (pay.kind === "window") {
    await stack.counters.add(pay.pendingKey, BigInt(counts.tokensIn + counts.tokensOut) - pay.reservedTokens, 3 * 86_400)
    await noteWindowMinute(stack, pay.windowId)
  }
}

/**
 * Billing runs after tokens have gone out, so a failure is flagged for review, never lost silently. Whatever a
 * buyer's body can break is refused before payment, which leaves failures of the database or the host link.
 * Those can strike after the record committed, so the hold stands until it expires rather than being handed back.
 */
async function billSafely(ctx: Ctx, opened: Opened, priced: Priced, output: Assembled, ttftMs: number, partial = false) {
  try {
    return await bill(ctx, opened, priced, output, ttftMs, partial)
  } catch (err) {
    console.error(JSON.stringify({ service: "router", event: "bill_failed", reqId: ctx.reqId, error: String(err) }))
    await flagMetering(ctx.stack, ctx.reqId, opened.host, {}, {}, "bill_failed").catch(() => undefined)
    return null
  }
}
