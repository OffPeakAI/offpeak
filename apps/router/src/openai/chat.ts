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

const BILL_CONCURRENCY = 16
const billingLanes = new Map<string, { running: number; waiting: Array<() => void> }>()

/** Bills wait their turn per host, so a burst cannot starve first tokens and one stuck host cannot stop the rest. */
async function inBillingTurn<T>(host: string, work: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const lane = billingLanes.get(host) ?? { running: 0, waiting: [] }
  billingLanes.set(host, lane)
  if (lane.running >= BILL_CONCURRENCY) await new Promise<void>((resolve) => lane.waiting.push(resolve))
  lane.running += 1
  try {
    return await work()
  } finally {
    lane.running -= 1
    lane.waiting.shift()?.()
  }
}

const chunkBody = (reqId: Hex, modelName: string, created: number, delta: object, finish: string | null) => ({ id: reqId, object: "chat.completion.chunk", created, model: modelName, choices: [{ index: 0, delta, finish_reason: finish }] })

function chunk(reqId: Hex, modelName: string, created: number, delta: object, finish: string | null) {
  return `data: ${JSON.stringify(chunkBody(reqId, modelName, created, delta, finish))}\n\n`
}

/** Stock OpenAI readers parse every `data:` line as a chunk whatever its event name, so Offpeak's events are also empty chunks. */
function offpeakEvent(name: string, reqId: Hex, modelName: string, created: number, finish: string, fields: object) {
  return `event: ${name}\ndata: ${JSON.stringify({ ...chunkBody(reqId, modelName, created, {}, finish), ...fields })}\n\n`
}

const requestLimitMs = () => (MAX_REQUEST_S - BILLING_MARGIN_S) * 1000

/** Counts a Window's output as it passes, so a long stream lands in the minutes it actually ran. */
function meterWindow(ctx: Ctx, event: HostEvent, piece: string) {
  if (ctx.flow && (piece || event.choices?.[0]?.delta?.tool_calls)) ctx.flow.tokens(countText(ctx.tokenizer, piece) || 1)
}

function streamResponse(ctx: Ctx, opened: Opened, priced: Priced, entered: number, headers: Record<string, string>) {
  const { stack, reqId, started, modelName, pay, feeBps } = ctx
  const output = emptyAssembly()
  let cancelled = false
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (line: string) => {
          if (!cancelled) controller.enqueue(encoder.encode(line))
        }
        const close = () => {
          if (!cancelled) controller.close()
        }
        const limit = setTimeout(() => opened.abort(), requestLimitMs())
        let tokensOut = 0
        let first = false
        let gated = false
        let failure: string | null = null
        let cut = false
        const gate = async () => {
          gated = true
          const answer = await waitAuthorized(stack, pay.payRef, stack.preconfirmTimeoutMs)
          if (answer !== "ok") failure = "authorize_failed"
        }
        const relay = async (event: HostEvent) => {
          const toolDeltas = event.choices?.[0]?.delta?.tool_calls
          const piece = absorb(output, event)
          if (!piece && !toolDeltas) return
          meterWindow(ctx, event, piece)
          const delta = toolDeltas ? { ...(piece ? { content: piece } : {}), tool_calls: toolDeltas } : { content: piece }
          // OpenAI's stream helpers need the role on the first chunk to rebuild the message.
          send(chunk(reqId, modelName, started, first ? delta : { role: "assistant", ...delta }, null))
          if (stack.serverTtftMs && !first) stack.serverTtftMs.push(performance.now() - entered)
          first = true
          if (pay.kind === "upto" && !gated) {
            tokensOut += countText(ctx.tokenizer, piece) || 1
            const running = quoteCost({ tokensIn: ctx.tokensIn, tokensOut, priceIn: priced.price.in, priceOut: priced.price.out, feeBps })
            if (preconfirmReached(tokensOut, running.totalMicro)) await gate()
          }
        }
        try {
          await relay(opened.first)
          if (!failure) {
            for await (const event of opened.events) {
              if (cancelled) break
              await relay(event)
              if (failure) break
            }
          }
        } catch {
          cut = true
        }
        clearTimeout(limit)
        // A buyer who walks away before a token says nothing about the host.
        if (cancelled) ctx.flow?.drop()
        else ctx.flow?.end()
        stack.load.leave(opened.host, ctx.model.digest)
        // A reply under the budget still needs its authorization before it can bill.
        if (pay.kind === "upto" && !gated && !failure) await gate()
        if (failure) {
          opened.abort()
          await release(stack, pay).catch(() => undefined)
          send(`event: error\ndata: ${JSON.stringify({ error: { message: "Authorization did not arrive", code: failure } })}\n\n`)
          close()
          return
        }
        const partial = cut || cancelled
        const billed = await inBillingTurn(opened.host, () => billSafely(ctx, opened, priced, output, opened.ttftMs, partial))
        const jsonError = partial ? null : assertJsonOutput(output.text, ctx.body.response_format as never, output.finish ?? "stop")
        if (!billed) send(`event: error\ndata: ${JSON.stringify({ error: { message: "Host did not sign", code: "unbilled" } })}\n\n`)
        else {
          if (jsonError) send(`event: error\ndata: ${JSON.stringify({ error: { message: jsonError, code: "bad_json" } })}\n\n`)
          const finish = partial ? "length" : (output.finish ?? "stop")
          const { tokensIn: prompt_tokens, tokensOut: completion_tokens } = billed.counts
          send(chunk(reqId, modelName, started, {}, finish))
          if (billed.channelOwed !== undefined) send(offpeakEvent("offpeak.channel", reqId, modelName, started, finish, { owed: billed.channelOwed.toString() }))
          send(offpeakEvent("offpeak.usage", reqId, modelName, started, finish, { usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }, ...billed.envelope }))
          send(`data: [DONE]\n\n`)
        }
        close()
      },
      cancel() {
        cancelled = true
        opened.abort()
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...headers } },
  )
}

async function jsonResponse(ctx: Ctx, opened: Opened, priced: Priced, headers: Record<string, string>) {
  const { stack, reqId, started, modelName, pay } = ctx
  const output = emptyAssembly()
  meterWindow(ctx, opened.first, absorb(output, opened.first))
  const limit = setTimeout(() => opened.abort(), requestLimitMs())
  let cut = false
  try {
    for await (const event of opened.events) meterWindow(ctx, event, absorb(output, event))
  } catch {
    cut = true
    output.finish = "length"
  }
  clearTimeout(limit)
  ctx.flow?.end()
  stack.load.leave(opened.host, ctx.model.digest)
  if (pay.kind === "upto" && (await waitAuthorized(stack, pay.payRef, stack.preconfirmTimeoutMs)) !== "ok") {
    await release(stack, pay).catch(() => undefined)
    return oai(402, "Authorization did not arrive", "payment", "authorize_failed")
  }
  const jsonError = assertJsonOutput(output.text, ctx.body.response_format as never, output.finish ?? "stop")
  if (jsonError) {
    await release(stack, pay)
    return oai(502, jsonError, "engine", "bad_json")
  }
  const billed = await billSafely(ctx, opened, priced, output, opened.ttftMs, cut)
  if (!billed) return oai(502, "Host did not sign", "engine", "unbilled")
  const { envelope, channelOwed, counts } = billed
  const toolCalls = output.toolCalls.length > 0 ? output.toolCalls : undefined
  return Response.json(
    {
      id: reqId,
      object: "chat.completion",
      created: started,
      model: modelName,
      choices: [{ index: 0, message: { role: "assistant", content: toolCalls && !output.text ? null : output.text, tool_calls: toolCalls }, finish_reason: output.finish ?? (toolCalls ? "tool_calls" : "stop") }],
      usage: { prompt_tokens: counts.tokensIn, completion_tokens: counts.tokensOut, total_tokens: counts.tokensIn + counts.tokensOut },
      offpeak_usage: envelope,
    },
    {
      headers: {
        "x-offpeak-usage": Buffer.from(JSON.stringify(envelope)).toString("base64url"),
        ...headers,
        ...(channelOwed !== undefined ? { "x-offpeak-channel-owed": channelOwed.toString() } : {}),
      },
    },
  )
}

/** A night job's line: runs as the account at the locked price, with no API key involved. */
export type NightLine = { lockedPrice: PriceLock; actor: Payer; reqId: Hex; fromHold?: string }

const flexTime = z.iso.datetime({ offset: true })

const tokenLimit = z.int().positive().nullish()
/** Both names, because the audit shape reads the one that loses. `z.int` keeps out values like 1e308. */
export const tokenLimits = z.looseObject({ max_tokens: tokenLimit, max_completion_tokens: tokenLimit })

/** Seconds, `undefined` with no header, or `null` when the header cannot be read. */
function parseFlex(header: string | null) {
  if (header === null) return undefined
  const parsed = flexTime.safeParse(header.trim())
  return parsed.success ? Math.floor(Date.parse(parsed.data) / 1000) : null
}

export async function serveChat(stack: Stack, req: Request, night?: NightLine): Promise<Response> {
  const entered = performance.now()
  const started = stack.clock()
  if (isSealed(req)) return serveSealed(stack, req)
  const flexDeadline = night ? undefined : parseFlex(req.headers.get("x-offpeak-flex"))
  if (flexDeadline === null) return oai(400, "X-Offpeak-Flex cannot be read", "invalid_request", "bad_flex")
  if (flexDeadline !== undefined && !stack.flags.night_jobs) return featureOff("Night jobs")
  const raw = await req.text()
  if (raw.length > 4 * 1024 * 1024) return oai(413, "Body too large", "invalid_request", "body_too_large")
  let body: Record<string, any>
  try {
    body = JSON.parse(raw)
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object")
  } catch {
    return oai(400, "Body is not valid JSON", "invalid_request", "bad_json")
  }
  if (body.n && body.n > 1) return oai(400, "Only n = 1 is supported", "invalid_request", "n_unsupported")
  const authed = night ? night.actor : await auth(stack, req)
  const unpaid = authed instanceof Response && authed.status === 402 && ((await authed.clone().json()) as { error: { code: string } }).error.code === "payment_required"
  if (authed instanceof Response && !unpaid) return authed
  const modelName = String(body.model ?? "")
  const model = stack.models.find((row) => row.name === modelName && row.kind === "chat")
  if (!model) return oai(404, "Unknown model", "invalid_request", "model_not_found")
  if (!unpaid && (authed as Payer).mode === 2) return oai(400, "exact is for fixed-cost calls such as embeddings", "invalid_request", "exact_not_allowed")
  if (!messagesOk(body.messages)) return oai(400, "Messages need text content", "invalid_request", "bad_messages")
  const tokensIn = Buffer.byteLength(raw) + 64
  if (!tokenLimits.safeParse(body).success) return oai(400, "max_tokens must be a positive integer", "invalid_request", "bad_max_tokens")
  const asked = askedTokens(body) as number | null | undefined
  const room = roomLeft(model, tokensIn, body)
  if (room === null) return oai(400, "Messages do not fit the model's chat template", "invalid_request", "bad_messages")
  if (room < 1) return oai(400, "Input is longer than the model's context", "invalid_request", "context_length_exceeded")
  const maxTokens = outputLimit(asked, room)
  let cap: ReturnType<typeof parseMaxPrice>
  try {
    cap = parseMaxPrice(req.headers.get("x-offpeak-max-price") ?? undefined)
  } catch {
    return oai(400, "X-Offpeak-Max-Price cannot be read", "invalid_request", "bad_max_price")
  }
  if (authed instanceof Response) {
    const unpaidRoute = await chooseRoute(stack, { cap, model, modelName, feeBps: FEE_BPS_DEFAULT, started, tokensIn, maxTokens, unattended: false })
    return unpaidRoute instanceof Response ? unpaidRoute : paymentRequiredResponse(stack, ceilDiv(unpaidRoute.quote * QUOTE_MARGIN_BPS, 10_000n), false)
  }
  const sent = hostChatBody(body, maxTokens)
  const metered = meterable(model, body, sent)
  if (!metered) return oai(400, "Body cannot be billed. Numbers must be finite and messages must fit the model's chat template", "invalid_request", "bad_body")
  const { payload, promptHash, tokensIn: inputTokens } = metered
  const reqId = night?.reqId ?? (`0x${randomBytes(32).toString("hex")}` as Hex)
  const headerP = signRouterBody(stack.router, { reqId, ts: started, payload })
  const resolved = await resolveWindow(stack, authed, req, tokensIn, maxTokens, model.digest)
  if (resolved instanceof Response) return resolved
  const windowRun = "reservedTokens" in resolved ? resolved : undefined
  const payer = windowRun ? windowRun.payer : (resolved as Payer)
  const feeBps = payer.mode === 4 ? 0 : payer.feeBps
  const dropWindow = async () => {
    if (windowRun) await stack.counters.add(windowRun.pendingKey, -windowRun.reservedTokens, 3 * 86_400)
  }
  if (flexDeadline !== undefined && (payer.mode === 1 || payer.mode === 2 || payer.mode === 3)) return oai(400, "Night jobs are prepaid", "invalid_request", "prepaid_only")
  const flow = payer.mode === 4 ? stack.windowPerf.begin(payer.windowId) : undefined
  /** A holder who was turned away is still demand, and it goes on record. */
  const endFlow = async () => {
    flow?.end()
    if (payer.mode === 4) await noteWindowMinute(stack, payer.windowId).catch(() => undefined)
  }
  const flex = flexDeadline !== undefined && payer.mode === 0 ? { deadline: flexDeadline, payer, body } : undefined
  // With no cap, the deadline alone says this can wait. With one, a price under it is served now.
  const scheduled = flex && !cap ? await intakeFlex(stack, flex.payer, modelName, flex.body, flex.deadline) : null
  if (scheduled) return scheduled
  const route = await chooseRoute(stack, { cap, model, modelName, payer, feeBps, started, tokensIn, maxTokens, locked: night?.lockedPrice, unattended: Boolean(night || flex), flex }).catch(async (err) => {
    await endFlow()
    await dropWindow()
    throw err
  })
  if (route instanceof Response) {
    await endFlow()
    await dropWindow()
    return route
  }
  const pay = await authorize(stack, payer, route.quote, raw, windowRun, night?.fromHold).catch(async (err) => {
    await endFlow()
    await dropWindow()
    throw err
  })
  if (pay instanceof Response) {
    await endFlow()
    return pay
  }
  const opened = await openHost(stack, route.ranked, payload, await headerP)
  if (opened.ok) stack.hostWaitMs?.push(opened.ttftMs)
  if (!opened.ok) {
    const refused = opened.error === "refused"
    // A host that turned this request down was not asked to serve anything, so no demand goes on record.
    if (refused) flow?.drop()
    else await endFlow()
    await release(stack, pay)
    return refused ? oai(400, "The host refused this request", "invalid_request", "host_refused") : oai(503, "Host failed before the first token", "engine", "no_capacity")
  }
  stack.load.enter(opened.host, model.digest)
  const servedPrice = opened.host === route.best.host ? route.priced : route.second!
  const ctx: Ctx = { stack, reqId, started, model, modelName, payer, pay, feeBps, maxTokens, body, sent, promptHash, tokensIn: inputTokens, tokenizer: tokenizerFor(model), flow }
  const shown = payer.mode === 4 ? { in: 0n, out: 0n } : { in: buyerUnitPrice(servedPrice.price.in, feeBps), out: buyerUnitPrice(servedPrice.price.out, feeBps) }
  const headers = { "x-offpeak-price": `in=${shown.in},out=${shown.out}`, "x-offpeak-host": opened.host }
  return body.stream ? streamResponse(ctx, opened, servedPrice, entered, headers) : jsonResponse(ctx, opened, servedPrice, headers)
}

const CHAT_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"])

export function messagesOk(messages: unknown): messages is ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return false
  return messages.every((message) => {
    if (!CHAT_ROLES.has(message?.role)) return false
    const content = message?.content
    if (content === null || content === undefined || typeof content === "string") return true
    return Array.isArray(content) && content.every((part) => part?.type === "text" && typeof part.text === "string")
  })
}

/**
 * Everything billing needs from the buyer's body, ready before any money moves. A body that throws here would
 * otherwise throw in `bill`, after the host has served it. `null` means it cannot be billed.
 */
function meterable(model: ModelEntry, body: Record<string, any>, sent: Record<string, unknown>) {
  try {
    return { payload: JSON.stringify(sent), promptHash: promptHashOf(sent), tokensIn: countChat(model, body) }
  } catch {
    return null
  }
}

/** Output left after the input, or `null` when the model's template refuses these messages. */
function roomLeft(model: ModelEntry, tokensIn: number, body: Record<string, any>) {
  // Counting costs real time at load, and a prompt this small cannot reach the limit in any tokenizer.
  if (tokensIn + MAX_OUTPUT_TOKENS < model.contextLength) return MAX_OUTPUT_TOKENS
  try {
    return model.contextLength - countChat(model, body)
  } catch {
    return null
  }
}

type RouteInput = {
  cap: ReturnType<typeof parseMaxPrice>
  model: ModelEntry
  modelName: string
  /** Absent for a request that has not paid yet, which only wants a quote. */
  payer?: Payer
  feeBps: number
  started: number
  tokensIn: number
  maxTokens: number
  locked?: PriceLock
  unattended: boolean
  flex?: { deadline: number; payer: Extract<Payer, { mode: 0 }>; body: Record<string, unknown> }
}

/** A Window keeps its share of the host. Everyone else is served from what is left. */
function outsideWindows(stack: Stack, rows: HostCandidate[], model: Hex) {
  if (stack.windowShares.size === 0) return rows
  return rows.filter((h) => h.util < 1 - (stack.windowShares.get(`${h.host.toLowerCase()}:${model}`) ?? 0))
}

/** The locked price averages floors, but only of the hosts forecast. Another host's floor can sit above it. */
function aboveFloor(stack: Stack, h: HostCandidate, model: Hex, now: number, locked: PriceLock) {
  const sheet = sheetFor(stack, h.host, model, now)
  return Boolean(sheet && sheet.floorIn <= locked.in && sheet.floorOut <= locked.out)
}

const takesNightJobs = (stack: Stack, h: HostCandidate, model: Hex) => stack.nightModels?.get(h.host.toLowerCase())?.has(model.toLowerCase()) ?? !stack.nightModels

async function chooseRoute(stack: Stack, input: RouteInput) {
  const { cap, model, modelName, payer, feeBps, started, tokensIn, maxTokens, locked, unattended, flex } = input
  const chosen = await candidates(stack, model.digest, started, feeBps)
  const windowHost = payer?.mode === 4 ? (await stack.indexer.window(payer.windowId.toString()))?.host.toLowerCase() : undefined
  const selected = selectHost(chosen, { sealed: false, windowHost, canary: false, interactive: !unattended })
  const open = payer?.mode === 4 ? selected : outsideWindows(stack, selected, model.digest)
  const healthy = locked ? open.filter((h) => takesNightJobs(stack, h, model.digest) && aboveFloor(stack, h, model.digest, started, locked)) : open
  if (healthy.length === 0) return oai(503, "No healthy host", "capacity", "no_capacity", { next_forecast_hour: hourIndex(started) + 1 })
  // A Window was paid for at purchase, so a live price cap has nothing to say about drawing it.
  const capped = payer?.mode === 4 ? undefined : cap
  const ranked = capped ? healthy.filter((h) => h.priceIn <= capped.inPerM && h.priceOut <= capped.outPerM) : healthy
  const best = (ranked[0] ?? healthy[0])!
  const priced = hostPrice(stack, best, model.digest, started, locked)
  if (!priced) return oai(503, "No price", "capacity", "no_capacity")
  if (priceAboveCap(priced.price.in, priced.price.out, feeBps, capped)) {
    const scheduled = flex && (await intakeFlex(stack, flex.payer, modelName, flex.body, flex.deadline, capped))
    if (scheduled) return scheduled
    const cheaper = await nextCheaper(stack, model.digest, feeBps, capped, started)
    return oai(429, "Live price is above the cap", "rate_limit", "price_above_cap", {
      best_price: { in: buyerUnitPrice(priced.price.in, feeBps).toString(), out: buyerUnitPrice(priced.price.out, feeBps).toString() },
      next_cheaper_hour: cheaper?.hour ?? null,
      next_cheaper_price: cheaper ? { in: cheaper.in.toString(), out: cheaper.out.toString() } : null,
    })
  }
  const quoteFor = (row: Priced) => quoteCost({ tokensIn: Math.max(tokensIn, 1), tokensOut: maxTokens, priceIn: row.price.in, priceOut: row.price.out, feeBps }).totalMicro
  const nextHost = ranked.find((host) => host.host !== best.host)
  const second = nextHost ? hostPrice(stack, nextHost, model.digest, started, locked) : null
  const firstQuote = quoteFor(priced)
  const secondQuote = second ? quoteFor(second) : 0n
  return { ranked: ranked.length > 0 ? ranked : healthy, best, priced, second, quote: secondQuote > firstQuote ? secondQuote : firstQuote }
}
