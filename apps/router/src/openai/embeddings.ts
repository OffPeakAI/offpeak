import {
  DEFAULT_EMBEDDINGS_MODEL,
  FEE_BPS_DEFAULT,
  MAX_REQUEST_S,
  UPTO_PRECONFIRM_BUDGET_MICRO,
  buyerRefOf,
  buyerUnitPrice,
  hostEmbeddingsBody,
  promptHashOf,
  quoteCost,
  reqIdFromUlid,
  ulid,
  type Hex,
  type UsageRecord,
} from "@offpeak/shared"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { beforeCounting } from "../auth/limits.ts"
import { countInputs } from "../metering/tokenize.ts"
import { auth, type Payer, type PayHold, type Stack } from "../pipeline.ts"
import { signRouterBody } from "../../../host-agent/src/proxy.ts"
import { oai } from "../http.ts"
import { authorize, paymentRequiredResponse, release, waitAuthorized } from "../pay/authorize.ts"
import { flushCapture } from "../pay/captures.ts"
import { selectHost, type HostCandidate } from "../routing/select.ts"
import { candidates, hostPrice } from "./chat.ts"
import { commitRecord, flagMetering } from "./commit.ts"

const BODY_LIMIT = 4 * 1024 * 1024
const MAX_INPUTS = 2048

const embeddingsBody = z.object({
  model: z.string().min(1).optional(),
  input: z.union([z.string(), z.array(z.string()).min(1).max(MAX_INPUTS)]),
  encoding_format: z.enum(["float", "base64"]).default("float"),
})

type Priced = NonNullable<ReturnType<typeof hostPrice>>
type Route = { target: HostCandidate; priced: Priced; total: bigint; cost: ReturnType<typeof quoteCost> }

const paysOnChain = (pay: PayHold) => pay.kind === "upto" || pay.kind === "exact"

async function askHost(stack: Stack, route: Route, reqId: Hex, started: number, payload: string) {
  const header = await signRouterBody(stack.router, { reqId, ts: started, payload })
  const res = await stack.hosts
    .request(route.target.host.toLowerCase(), route.target.endpoint, "/offpeak/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-offpeak-req": header },
      body: payload,
      signal: AbortSignal.timeout(MAX_REQUEST_S * 1000),
    })
    .catch(() => null)
  return res
}

/** Failover stays inside what was paid: an `exact` payment cannot stretch to a dearer host. A 4xx answers the request, so it is not held against the host. */
async function serveOne(stack: Stack, routes: Route[], pay: PayHold, reqId: Hex, started: number, payload: string) {
  let refused = false
  for (const route of routes) {
    if (route.total > pay.max) continue
    const host = route.target.host
    stack.load.enter(host, route.target.modelDigest)
    const res = await askHost(stack, route, reqId, started, payload)
    stack.load.leave(host, route.target.modelDigest)
    if (res?.ok) return { ok: true as const, res, route }
    refused = res !== null && res.status < 500
    if (!refused) stack.load.noteResult(route.target.host, false)
  }
  return { ok: false as const, refused }
}

/** Embeddings are billed on input tokens only. Known cost, so `exact` is a valid agent path. */
export async function serveEmbeddings(stack: Stack, req: Request, ip = "unknown"): Promise<Response> {
  const raw = await req.text()
  if (raw.length > BODY_LIMIT) return oai(413, "Body too large", "invalid_request", "body_too_large")
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return oai(400, "Body is not valid JSON", "invalid_request", "bad_json")
  }
  const parsed = embeddingsBody.safeParse(json)
  if (!parsed.success) return oai(400, `Input must be text, 1 to ${MAX_INPUTS} items`, "invalid_request", "bad_input")
  const body = parsed.data
  const inputs = Array.isArray(body.input) ? body.input : [body.input]
  const modelName = body.model ?? DEFAULT_EMBEDDINGS_MODEL
  const model = stack.models.find((row) => row.name === modelName && row.kind === "embeddings")
  if (!model) return oai(404, "Unknown model", "invalid_request", "model_not_found")
  const started = stack.clock()
  const authed = await auth(stack, new Request(req.url, { headers: req.headers }))
  const quoteOnly = authed instanceof Response && authed.status === 402 && ((await authed.clone().json()) as { error: { code: string } }).error.code === "payment_required"
  if (authed instanceof Response && !quoteOnly) return authed
  if (!(authed instanceof Response) && authed.mode === 4) return oai(400, "Windows draw on chat requests only", "invalid_request", "window_unsupported")
  const refused = await beforeCounting(stack, quoteOnly ? null : (authed as Payer), raw, ip)
  if (refused) return refused
  const tokensIn = countInputs(model, inputs)
  const feeBps = authed instanceof Response ? FEE_BPS_DEFAULT : (authed as Exclude<Payer, { mode: 4 }>).feeBps
  const targets = selectHost(await candidates(stack, model.digest, started, feeBps), { sealed: false, canary: false, interactive: true }).slice(0, 2)
  const routes = targets.flatMap((target): Route[] => {
    const priced = hostPrice(stack, target, model.digest, started)
    if (!priced) return []
    const cost = quoteCost({ tokensIn: Math.max(tokensIn, 1), tokensOut: 0, priceIn: priced.price.in, priceOut: 0n, feeBps })
    return [{ target, priced, cost, total: cost.totalMicro }]
  })
  const first = routes[0]
  if (!first) return oai(503, "No healthy host", "capacity", "no_capacity")
  if (authed instanceof Response) return paymentRequiredResponse(stack, first.total, true)
  const payer = authed as Exclude<Payer, { mode: 4 }>
  const quote = routes.reduce((max, route) => (route.total > max ? route.total : max), 0n)
  // `exact` pays the best host's price. A prepaid hold or a channel reservation can cover the failover too.
  const pay = await authorize(stack, payer, payer.mode === 2 ? first.total : quote, raw)
  if (pay instanceof Response) return pay
  const settled = async () => !paysOnChain(pay) || (await waitAuthorized(stack, pay.payRef, stack.preconfirmTimeoutMs)) === "ok"
  const unpaid = async () => {
    await release(stack, pay)
    return oai(402, "Authorization did not arrive", "payment", "authorize_failed")
  }
  // Under the budget, work starts while the payment confirms. Past it, the chain goes first.
  if (first.total > UPTO_PRECONFIRM_BUDGET_MICRO && !(await settled())) return unpaid()
  const reqId = reqIdFromUlid(ulid(started * 1000, randomBytes(10)))
  const sent = hostEmbeddingsBody({ model: modelName, input: inputs, encoding_format: body.encoding_format })
  const payload = JSON.stringify(sent)
  const served = await serveOne(stack, routes, pay, reqId, started, payload)
  if (!served.ok) {
    await release(stack, pay)
    return served.refused ? oai(400, "The host refused this request", "invalid_request", "host_refused") : oai(503, "Host failed", "engine", "no_capacity")
  }
  const reply = (await served.res.json()) as { data?: unknown }
  if (!(await settled())) return unpaid()
  const { route } = served
  const host = route.target.host.toLowerCase()
  const record: UsageRecord = {
    reqId,
    buyerRef: buyerRefOf(pay.wallet, reqId),
    host: host as Hex,
    modelDigest: model.digest,
    tokensIn,
    tokensOut: 0,
    promptHash: promptHashOf(sent),
    outputHash: promptHashOf(reply.data ?? []),
    priceIn: route.priced.price.in,
    priceOut: 0n,
    hostCostMicro: route.cost.hostCostMicro,
    feeMicro: route.cost.feeMicro,
    payMode: payer.mode,
    payRef: pay.payRef,
    ts: started,
    sheetHash: route.priced.sheet.sheetHash,
  }
  const committed = await commitRecord({ stack, payer, pay, feeBps, record, host, endpoint: route.target.endpoint, ttftMs: 1 }).catch((err: unknown) => ({ refused: String(err).slice(0, 120), hostCounts: {} }))
  if ("refused" in committed) {
    await release(stack, pay)
    await flagMetering(stack, reqId, host, { tokensIn }, committed.hostCounts, "sign_refused").catch(() => undefined)
    return oai(502, "Host did not sign", "engine", "unbilled")
  }
  // The record is final, and the sweep finishes any capture that fails here.
  if (pay.kind === "prepaid" || pay.kind === "upto") await flushCapture(stack, reqId).catch(() => undefined)
  const { envelope, channelOwed } = committed
  const headers: Record<string, string> = {
    "x-offpeak-price": `in=${buyerUnitPrice(route.priced.price.in, feeBps)},out=0`,
    "x-offpeak-host": host,
    "x-offpeak-usage": Buffer.from(JSON.stringify(envelope)).toString("base64url"),
  }
  if (channelOwed !== undefined) headers["x-offpeak-channel-owed"] = channelOwed.toString()
  if (paysOnChain(pay)) headers["payment-response"] = Buffer.from(JSON.stringify({ success: true, scheme: pay.kind, reqId: pay.payRef, payer: pay.wallet })).toString("base64url")
  return Response.json({ ...reply, usage: { prompt_tokens: tokensIn, total_tokens: tokensIn }, offpeak_usage: envelope }, { headers })
}
