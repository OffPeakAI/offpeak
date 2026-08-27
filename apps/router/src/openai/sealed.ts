import { randomBytes } from "node:crypto"
import { BODY_MAX_BYTES, MAX_REQUEST_S, UPTO_PRECONFIRM_BUDGET_MICRO, UPTO_PRECONFIRM_TOKENS, buyerRefOf, buyerUnitPrice, hourIndex, quoteCost, type Hex, type UsageRecord } from "@offpeak/shared"
import { bytesToHex, keccak256 } from "viem"
import { z } from "zod"
import { countsSignedBy, sealedCountsSchema, type SealedCounts } from "../../../../packages/sdk/src/sealed/attest.ts"
import { FRAME_WIRE_BYTES, HPKE_CONTENT_TYPE, HPKE_STREAM_CONTENT_TYPE, REQUEST_MIN_BYTES, RESPONSE_SALT_BYTES, concatBytes, inputTokenCeiling } from "../../../../packages/sdk/src/sealed/hpke.ts"
import { FLAG_TRAILER, FrameSplitter, encodeTrailer, type Frame, type Trailer } from "../../../../packages/sdk/src/sealed/stream.ts"
import { sealedReqPayload } from "../../../host-agent/src/sealed/hpke.ts"
import { SEALED_CHAT_ROUTE, SEALED_COUNTS_ROUTE } from "../../../host-agent/src/sealed/serve.ts"
import { signRouterBody } from "../../../host-agent/src/proxy.ts"
import { auth } from "../auth/keys.ts"
import type { ModelEntry, PayHold, Payer, Stack } from "../context.ts"
import { oai } from "../http.ts"
import { nextCheaper } from "../offpeak/forecast.ts"
import { authorize, paymentRequiredResponse, release, resolveWindow, waitAuthorized } from "../pay/authorize.ts"
import { flushCapture } from "../pay/captures.ts"
import { parseMaxPrice, priceAboveCap } from "../pay/quote.ts"
import { noteWindowMinute, type PerfFlow } from "../pay/window-perf.ts"
import { relayAttest, verifiedHost } from "../routing/attest.ts"
import { selectHost, type HostCandidate } from "../routing/select.ts"
import { candidates, hostPrice } from "./chat.ts"
import { commitRecord, flagMetering } from "./commit.ts"

const MAX_TOKENS_LIMIT = 4096
const BILLING_MARGIN_S = 30
/** Past this the agent has broken the frame limits many times over, so the relay stops. */
const RELAY_MAX_BYTES = 64 * 1024 * 1024
/** One end of the range holds a tokenizer's densest output. The other allows a one-byte token an SSE event of two padded frames. */
const DEFAULT_BYTES_PER_TOKEN = { low: 1, high: 512 }
/** What a prompt of no tokens still takes: the HPKE header, `enc`, the tag and the JSON around the messages. */
const REQUEST_SLACK_BYTES = 256
/** What a reply of no tokens still takes, since padding fills whole frames and the role, finish, usage and `[DONE]` events carry no output. */
const RESPONSE_SLACK_BYTES = 8 * FRAME_WIRE_BYTES

const headersSchema = z.object({
  model: z.string().min(1).max(128),
  maxTokens: z.coerce.number().int().min(1).max(MAX_TOKENS_LIMIT),
  host: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Hex),
})

const agentError = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]{1,64}$/) }) })

type Priced = NonNullable<ReturnType<typeof hostPrice>>

type Ctx = {
  stack: Stack
  reqId: Hex
  started: number
  model: ModelEntry
  payer: Payer
  pay: PayHold
  feeBps: number
  maxTokens: number
  host: HostCandidate
  /** From the verified quote, not from anything the host says now. */
  countsSigner: Hex
  priced: Priced
  promptHash: Hex
  requestBytes: number
  ttftMs: number
  flow?: PerfFlow
}

export const isSealed = (req: Request) => (req.headers.get("content-type") ?? "").includes(HPKE_CONTENT_TYPE)

/** Bytes per token in both directions, for a model's observed range, leaving out what no token accounts for. An outlier is flagged. It is not refused. */
export function lengthOutlier(range: { low: number; high: number }, request: { bytes: number; tokens: number }, response: { bytes: number; tokens: number }) {
  const outside = ({ bytes, tokens }: { bytes: number; tokens: number }, slack: number) => tokens > 0 && (bytes / tokens < range.low || (bytes - slack) / tokens > range.high)
  return outside(request, REQUEST_SLACK_BYTES) || outside(response, RESPONSE_SLACK_BYTES)
}

function bytesPerToken(model: ModelEntry) {
  return model.sealedBytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
}

/**
 * Bytes are an upper bound on tokens, so the `upto` budget holds without reading a thing. The first
 * frame always goes out, because no chain call may sit in front of the first token, and the agent
 * keeps frames small enough that it stays inside the budget.
 */
function preconfirmBytes(priced: Priced, feeBps: number) {
  const unit = buyerUnitPrice(priced.price.out, feeBps)
  const affordable = unit > 0n ? (UPTO_PRECONFIRM_BUDGET_MICRO * 1_000_000n) / unit : BigInt(UPTO_PRECONFIRM_TOKENS)
  return Math.max(1, Math.min(UPTO_PRECONFIRM_TOKENS, Number(affordable)))
}

async function hostCounts(ctx: Ctx): Promise<SealedCounts | null> {
  const { stack, reqId, host } = ctx
  // Signed now, not at the start: a long stream outlasts the skew the agent allows.
  const header = await signRouterBody(stack.router, { reqId, ts: stack.clock(), payload: reqId })
  const res = await stack.hosts
    .request(host.host, host.endpoint, `${SEALED_COUNTS_ROUTE}/${reqId}`, { headers: { "x-offpeak-req": header }, signal: AbortSignal.timeout(10_000) })
    .catch(() => null)
  if (!res?.ok) return null
  return sealedCountsSchema.safeParse(await res.json().catch(() => null)).data ?? null
}

function fitHold(pay: PayHold, tokensOut: number, costOf: (tokensOut: number) => { totalMicro: bigint }) {
  let fits = 0
  for (let span = tokensOut; span > 0; span = Math.floor(span / 2)) {
    while (fits + span <= tokensOut && costOf(fits + span).totalMicro <= pay.max) fits += span
  }
  return fits
}

/** The router cannot count, so the VM's signed counts stand, held to the same limits as the router's own would be. */
async function bill(ctx: Ctx, outputHash: Hex, responseBytes: number, cut: boolean) {
  const { stack, reqId, started, model, payer, pay, feeBps, host, countsSigner, priced, promptHash, maxTokens } = ctx
  const counted = await hostCounts(ctx)
  if (!counted) {
    await release(stack, pay)
    await flagMetering(stack, reqId, host.host, {}, {}, "sealed_no_counts")
    return null
  }
  // The operator's key lives outside the VM, so only this signature says the VM did the work.
  if (counted.reqId !== reqId || !(await countsSignedBy(counted, countsSigner))) {
    await release(stack, pay)
    await flagMetering(stack, reqId, host.host, {}, counted, "sealed_bad_counts")
    return null
  }
  if (counted.promptHash !== promptHash) {
    await release(stack, pay)
    await flagMetering(stack, reqId, host.host, { promptHash }, counted, "sealed_prompt_hash")
    return null
  }
  if (!cut && counted.outputHash !== outputHash) {
    await release(stack, pay)
    await flagMetering(stack, reqId, host.host, { outputHash }, counted, "sealed_output_hash")
    return null
  }
  const reported = { tokensIn: counted.tokensIn, tokensOut: counted.tokensOut }
  const ceiling = inputTokenCeiling(ctx.requestBytes)
  // A Window skips the hold check below, so this is its only limit on input.
  const counts = { tokensIn: Math.min(counted.tokensIn, ceiling), tokensOut: Math.min(counted.tokensOut, maxTokens) }
  // A request has one flag row, so every reason goes in it together and none hides another.
  const reasons: string[] = []
  const flagged = async () => {
    if (reasons.length > 0) await flagMetering(stack, reqId, host.host, { ...counts, requestBytes: ctx.requestBytes, responseBytes }, reported, reasons.join(","))
  }
  if (lengthOutlier(bytesPerToken(model), { bytes: ctx.requestBytes, tokens: counted.tokensIn }, { bytes: responseBytes, tokens: counted.tokensOut })) reasons.push("sealed_length_outlier")
  let partial = cut || counted.tokensOut > maxTokens
  if (counted.tokensOut > maxTokens) reasons.push("over_max_tokens")
  if (counted.tokensIn > ceiling) reasons.push("over_input_ceiling")
  stack.load.note(host.host, model.digest, "prefill", counts.tokensIn, stack.clock())
  stack.load.note(host.host, model.digest, "output", counts.tokensOut, stack.clock())
  if (counts.tokensOut > 1) ctx.flow?.tokens(counts.tokensOut - 1)
  const zero = pay.kind === "window"
  const costOf = (tokensOut: number) => quoteCost({ tokensIn: counts.tokensIn, tokensOut, priceIn: priced.price.in, priceOut: priced.price.out, feeBps })
  if (!zero && costOf(counts.tokensOut).totalMicro > pay.max) {
    reasons.push("over_hold")
    partial = true
    counts.tokensOut = fitHold(pay, counts.tokensOut, costOf)
    if (costOf(counts.tokensOut).totalMicro > pay.max) {
      await release(stack, pay)
      await flagged()
      return null
    }
  }
  const cost = zero ? { hostCostMicro: 0n, feeMicro: 0n } : costOf(counts.tokensOut)
  const record: UsageRecord = {
    reqId,
    buyerRef: buyerRefOf(pay.wallet, reqId),
    host: host.host as Hex,
    modelDigest: model.digest,
    tokensIn: counts.tokensIn,
    tokensOut: counts.tokensOut,
    promptHash,
    outputHash,
    priceIn: zero ? 0n : priced.price.in,
    priceOut: zero ? 0n : priced.price.out,
    hostCostMicro: cost.hostCostMicro,
    feeMicro: cost.feeMicro,
    payMode: zero ? 4 : payer.mode,
    payRef: pay.payRef,
    ts: started,
    sheetHash: priced.sheet.sheetHash,
  }
  const committed = await commitRecord({ stack, payer, pay, feeBps, record, host: host.host, endpoint: host.endpoint, ttftMs: ctx.ttftMs, partial, sealed: true }).catch(async (err) => {
    await flagged()
    throw err
  })
  if ("refused" in committed) {
    await release(stack, pay)
    reasons.push(committed.refused ?? "sign_refused")
    await flagged()
    return null
  }
  await flagged()
  await afterCommit(ctx, counts).catch((err) => console.error(JSON.stringify({ service: "router", event: "after_commit_failed", reqId, error: String(err) })))
  return { ...committed, counts: counted }
}
