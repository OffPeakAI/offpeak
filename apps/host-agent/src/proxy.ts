import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { keccak256, toBytes, type Hex } from "viem"
import { z } from "zod"
import { BODY_MAX_BYTES, MAX_REQUEST_S, canonicalJson, privateKeyOf, recoverPersonal, signPersonal, signRouterCanon, type ChatBody, type ChatMessage } from "@offpeak/shared"
import { EngineOutput, ServedBook, SseReader, settleChat, settleEmbeddings, type AgentTokenizer } from "./meter.ts"
import { healthBody, type EngineWatch } from "./health.ts"
import { createSigner, type SignerDeps } from "./sign.ts"
import { mountSealed, type SealedAgent } from "./sealed/serve.ts"

type SigningAccount = { getHdKey?: () => { privateKey: Uint8Array | null }; localKey?: Hex; signMessage?: (args: { message: string }) => Promise<Hex> }

const REQ_MAX_SKEW_S = 120
// The router's limit counts characters, and a character can take three bytes.
const RAW_BODY_MAX_BYTES = BODY_MAX_BYTES * 3 + 4096
const SIGN_BODY_MAX_BYTES = 64 * 1024
/** A socket with nothing signed on it gets this long. Bun's limit is 255 seconds. */
export const IDLE_TIMEOUT_S = 30

const AGENT_VERSION = "0.1.0"

const ZERO_ADDRESS = `0x${"00".repeat(20)}`

const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex)

const signedReqSchema = z.object({
  reqId: hash32,
  ts: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  bodyHash: hash32,
  sig: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((value) => value as Hex),
})

export function reqMessage(req: { reqId: string; ts: number; bodyHash: string }): string {
  return canonicalJson({ bodyHash: req.bodyHash, reqId: req.reqId, ts: req.ts })
}

export async function verifyRouterReq(header: string | undefined, router: string): Promise<{ reqId: Hex; ts: number; bodyHash: Hex } | null> {
  if (!header) return null
  let parsed: z.infer<typeof signedReqSchema>
  try {
    parsed = signedReqSchema.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")))
  } catch {
    return null
  }
  let addr: string
  try {
    addr = await recoverPersonal(reqMessage(parsed), parsed.sig)
  } catch {
    return null
  }
  if (addr === ZERO_ADDRESS || addr.toLowerCase() !== router.toLowerCase()) return null
  return parsed
}

export async function signRouterReq(account: SigningAccount, req: { reqId: Hex; ts: number; bodyHash: Hex }) {
  const sig = await signPersonal(reqMessage(req), privateKeyOf(account))
  return Buffer.from(JSON.stringify({ ...req, sig })).toString("base64url")
}

/** The auditor signs `/offpeak/v1/score` calls with this too, and sends the result as `X-Offpeak-Audit`. */
export async function signRouterBody(account: SigningAccount, input: { reqId: Hex; ts: number; payload: string }) {
  const { sig, bodyHash } = await signRouterCanon(privateKeyOf(account), {
    canon: canonicalJson(input.payload),
    reqId: input.reqId,
    ts: input.ts,
  })
  return Buffer.from(JSON.stringify({ reqId: input.reqId, ts: input.ts, bodyHash, sig })).toString("base64url")
}

/** A request is good only if the expected key signed these exact bytes a moment ago. */
export async function checkSignedReq(header: string | undefined, signer: string, rawBody: string, now: number) {
  const req = await verifyRouterReq(header, signer)
  if (!req || Math.abs(now - req.ts) > REQ_MAX_SKEW_S) return null
  return keccak256(toBytes(canonicalJson(rawBody))) === req.bodyHash.toLowerCase() ? req : null
}

const textPart = z.object({ type: z.literal("text"), text: z.string() })

const chatMessage = z.object({
  role: z.string().min(1),
  content: z.union([z.string(), z.array(textPart)]).nullish(),
  name: z.string().optional(),
  tool_calls: z.array(z.looseObject({})).nullish(),
  tool_call_id: z.string().optional(),
})

export const chatBody = z.looseObject({
  model: z.string().min(1),
  messages: z.array(chatMessage).min(1),
  tools: z.array(z.looseObject({})).nullish(),
  stream: z.boolean().optional(),
  n: z.literal(1).optional(),
})

const embeddingsBody = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1).max(2048)]),
  encoding_format: z.enum(["float", "base64"]).optional(),
})

const scoreBody = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessage).min(1).optional(),
  prompt: z.union([z.string().min(1), z.array(chatMessage).min(1)]).optional(),
  tools: z.array(z.looseObject({})).nullish(),
  output: z.string().min(1),
})

const logprobRow = z.record(z.string(), z.looseObject({ logprob: z.number(), decoded_token: z.string().nullish() })).nullable()

const scoredCompletion = z.looseObject({ choices: z.array(z.looseObject({ prompt_logprobs: z.array(logprobRow) })).min(1) })

const usageOnly = z.looseObject({ usage: z.looseObject({ prompt_tokens: z.number().optional() }).nullish() })

/** What a buyer may set. Anything else stays here, so nobody can change how vLLM renders or reports a prompt. */
const FORWARDED_FIELDS = ["model", "messages", "stream", "stream_options", "max_tokens", "temperature", "top_p", "stop", "seed", "tools", "tool_choice", "response_format", "logprobs", "top_logprobs", "n", "presence_penalty", "frequency_penalty"]

export function forwardedBody(body: Record<string, unknown>) {
  const out = Object.fromEntries(FORWARDED_FIELDS.filter((field) => body[field] !== undefined && body[field] !== null).map((field) => [field, body[field]]))
  // vLLM rejects these options outside a stream, and a stream without usage leaves nothing to compare.
  if (out.stream) out.stream_options = { include_usage: true }
  else delete out.stream_options
  return out
}

const authError = (code: string) => Response.json({ error: { message: "signature required", type: "auth", code } }, { status: 401 })

const engineError = (status: number, code: string, message: string) => Response.json({ error: { message, type: "engine", code } }, { status })

export type AgentModel = { name: string; digest: Hex; engine: string; tokenizer: AgentTokenizer; nightJobs: boolean }

export type AgentDeps = Omit<SignerDeps, "served" | "nightJobs"> & {
  imageDigest: Hex
  gpuClass: string
  models: AgentModel[]
  integrity: { failed: string | null }
  engines: EngineWatch
  /** Set on reference hosts. Holds the only address `/offpeak/v1/score` answers. */
  auditor: Hex | null
  /** Set inside an attested VM. Without it the sealed routes do not exist. */
  sealed?: SealedAgent
}

/** Bun's server, passed in by `serveAgent`. Tests that call the app directly have none. */
type AgentBindings = { server?: { timeout: (request: Request, seconds: number) => void } }

/** The host agent's HTTP surface. It sits in front of vLLM, which only this process can reach. */
export function createAgentApp(deps: AgentDeps) {
  const served = new ServedBook()
  const byName = new Map(deps.models.map((model) => [model.name, model]))
  const byDigest = new Map(deps.models.map((model) => [model.digest.toLowerCase(), model]))
  const sign = createSigner({ ...deps, served, nightJobs: (digest) => byDigest.get(digest.toLowerCase())?.nightJobs ?? false })
  const limit = bodyLimit({ maxSize: RAW_BODY_MAX_BYTES, onError: () => engineError(413, "body_too_large", "Body too large") })
  let inflight = 0
  const app = new Hono()

  /**
   * Runs before any body is read, so nobody without the key can make this process hold 12 MB. Once
   * the header proves who is calling, a stream may sit quiet on the GPU for as long as the request lasts.
   */
  const signedBy = (name: string, signer: string, code: string): MiddlewareHandler =>
    async (c, next) => {
      const req = await verifyRouterReq(c.req.header(name), signer)
      if (!req || Math.abs(deps.clock() - req.ts) > REQ_MAX_SKEW_S) return authError(code)
      const bindings = c.env as AgentBindings | undefined
      bindings?.server?.timeout(c.req.raw, 0)
      await next()
    }
  const fromRouter = signedBy("x-offpeak-req", deps.routerAddress, "bad_router_req")

  /** Everything both inference routes share before a byte goes to vLLM. */
  const admit = async (rawBody: string, header: string | undefined) => {
    const req = await checkSignedReq(header, deps.routerAddress, rawBody, deps.clock())
    if (!req) return authError("bad_router_req")
    if (!served.claim(req.reqId, deps.clock())) return authError("replayed_req")
    if (deps.integrity.failed) return engineError(503, "model_integrity", "Model files failed their check")
    return req
  }

  const parseJson = (rawBody: string): unknown => {
    try {
      return JSON.parse(rawBody)
    } catch {
      return null
    }
  }

  const callEngine = async (url: string, body: unknown, signal: AbortSignal) => {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }).catch(() => null)
  }

  const relayFailure = async (res: Response | null) => {
    if (!res) return engineError(503, "engine_down", "Engine is not answering")
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } })
  }

  const streamChat = (upstream: Response, control: AbortController, tokenizer: AgentTokenizer, body: ChatBody, run: ReturnType<ServedBook["begin"]>) => {
    const output = new EngineOutput()
    const events = new SseReader()
    const reader = upstream.body!.getReader()
    let open = true
    const end = () => {
      if (!open) return
      open = false
      inflight -= 1
      settleChat(run.request, tokenizer, body, output)
      run.finish()
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            end()
            controller.close()
            return
          }
          for (const event of events.push(value)) output.chunk(event)
          controller.enqueue(value)
        } catch (err) {
          end()
          controller.error(err)
        }
      },
      // The router hung up, so the GPU stops here and the record covers what went out.
      cancel() {
        control.abort()
        end()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
  }

  app.post("/offpeak/v1/chat/completions", fromRouter, limit, async (c) => {
    const rawBody = await c.req.text()
    const req = await admit(rawBody, c.req.header("x-offpeak-req"))
    if (req instanceof Response) return req
    const parsed = chatBody.safeParse(parseJson(rawBody))
    if (!parsed.success) return c.json({ error: { message: "Body is not a chat request", type: "invalid_request", code: "bad_request" } }, 400)
    const model = byName.get(parsed.data.model)
    if (!model) return c.json({ error: { message: "This host does not serve that model", type: "invalid_request", code: "model_not_found" } }, 404)
    const body: ChatBody = { messages: parsed.data.messages as ChatMessage[], tools: parsed.data.tools ?? undefined }
    const control = new AbortController()
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(MAX_REQUEST_S * 1000)])
    inflight += 1
    const upstream = await callEngine(`${model.engine}/v1/chat/completions`, forwardedBody(parsed.data), signal)
    if (!upstream?.ok || !upstream.body) {
      inflight -= 1
      return relayFailure(upstream)
    }
    const run = served.begin({ reqId: req.reqId, ts: req.ts, modelDigest: model.digest })
    if (parsed.data.stream) return streamChat(upstream, control, model.tokenizer, body, run)
    const text = await upstream.text().catch(() => "")
    const output = new EngineOutput()
    const complete = output.completion(parseJson(text))
    inflight -= 1
    if (complete) settleChat(run.request, model.tokenizer, body, output)
    run.finish()
    if (!complete) return engineError(502, "bad_engine_reply", "Engine sent no completion")
    return new Response(text, { headers: { "content-type": "application/json" } })
  })

  app.post("/offpeak/v1/embeddings", fromRouter, limit, async (c) => {
    const rawBody = await c.req.text()
    const req = await admit(rawBody, c.req.header("x-offpeak-req"))
    if (req instanceof Response) return req
    const parsed = embeddingsBody.safeParse(parseJson(rawBody))
    if (!parsed.success) return c.json({ error: { message: "Body is not an embeddings request", type: "invalid_request", code: "bad_request" } }, 400)
    const model = byName.get(parsed.data.model)
    if (!model) return c.json({ error: { message: "This host does not serve that model", type: "invalid_request", code: "model_not_found" } }, 404)
    const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input]
    inflight += 1
    const upstream = await callEngine(`${model.engine}/v1/embeddings`, parsed.data, AbortSignal.timeout(MAX_REQUEST_S * 1000))
    inflight -= 1
    if (!upstream?.ok) return relayFailure(upstream)
    const text = await upstream.text()
    const run = served.begin({ reqId: req.reqId, ts: req.ts, modelDigest: model.digest })
    settleEmbeddings(run.request, model.tokenizer, inputs, usageOnly.safeParse(parseJson(text)).data?.usage ?? null)
    run.finish()
    return new Response(text, { headers: { "content-type": "application/json" } })
  })

  /** Teacher forcing: how likely each token of `output` is under this model, given the prompt before it. */
  const fromAuditor: MiddlewareHandler = deps.auditor ? signedBy("x-offpeak-audit", deps.auditor, "bad_audit_req") : async (c) => c.notFound()
  app.post("/offpeak/v1/score", fromAuditor, limit, async (c) => {
    const rawBody = await c.req.text()
    const req = await checkSignedReq(c.req.header("x-offpeak-audit"), deps.auditor!, rawBody, deps.clock())
    if (!req) return authError("bad_audit_req")
    if (!served.claim(req.reqId, deps.clock())) return authError("replayed_req")
    if (deps.integrity.failed) return engineError(503, "model_integrity", "Model files failed their check")
    const parsed = scoreBody.safeParse(parseJson(rawBody))
    const prompt = parsed.data?.messages ?? parsed.data?.prompt
    if (!parsed.success || !prompt) return c.json({ error: { message: "Body needs a model, a prompt and an output", type: "invalid_request", code: "bad_request" } }, 400)
    const model = byName.get(parsed.data.model)
    if (!model) return c.json({ error: { message: "This host does not serve that model", type: "invalid_request", code: "model_not_found" } }, 404)
    const messages = (typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt) as ChatMessage[]
    let rendered: string
    try {
      rendered = model.tokenizer.render({ messages, tools: parsed.data.tools ?? undefined })
    } catch {
      return c.json({ error: { message: "Prompt does not fit the model's template", type: "invalid_request", code: "bad_request" } }, 400)
    }
    const context = model.tokenizer.encode(rendered)
    const answer = model.tokenizer.encode(parsed.data.output)
    if (answer.length === 0) return c.json({ error: { message: "Output holds no tokens", type: "invalid_request", code: "bad_request" } }, 400)
    const upstream = await callEngine(`${model.engine}/v1/completions`, { model: model.name, prompt: [...context, ...answer], max_tokens: 1, temperature: 0, prompt_logprobs: 1 }, AbortSignal.timeout(MAX_REQUEST_S * 1000))
    if (!upstream?.ok) return relayFailure(upstream)
    const rows = scoredCompletion.safeParse(await upstream.json().catch(() => null)).data?.choices[0]?.prompt_logprobs
    if (!rows || rows.length !== context.length + answer.length) return engineError(502, "bad_engine_reply", "Engine did not score every token")
    const logprobs = answer.map((id, index) => {
      const entry = rows[context.length + index]?.[String(id)]
      return entry ? { id, token: entry.decoded_token ?? model.tokenizer.decodeToken(id), logprob: entry.logprob } : null
    })
    if (logprobs.includes(null)) return engineError(502, "bad_engine_reply", "Engine did not score every token")
    const scored = logprobs as { id: number; token: string; logprob: number }[]
    return c.json({ model: model.name, modelDigest: model.digest, tokens: scored.length, ll_mean: scored.reduce((sum, row) => sum + row.logprob, 0) / scored.length, logprobs: scored })
  })

  app.post("/offpeak/v1/sign", bodyLimit({ maxSize: SIGN_BODY_MAX_BYTES, onError: () => engineError(413, "body_too_large", "Body too large") }), async (c) => {
    const { status, body } = await sign(await c.req.json().catch(() => null))
    return Response.json(body, { status })
  })

  const sealedModel = deps.sealed && byName.get(deps.sealed.boot.modelName)
  if (deps.sealed && sealedModel) {
    mountSealed({ app, sealed: deps.sealed, model: sealedModel, limit, signed: fromRouter, routerAddress: deps.routerAddress, served, clock: deps.clock, admit, inflight: (by) => (inflight += by) })
  }

  app.get("/offpeak/v1/info", (c) =>
    c.json({
      operator: deps.operator.address.toLowerCase(),
      modelDigests: deps.models.map((model) => model.digest),
      imageDigest: deps.imageDigest,
      gpuClass: deps.gpuClass,
      agentVersion: AGENT_VERSION,
      sealed: Boolean(deps.sealed),
      // The models whose locked night-job prices this host signs. A router must send night jobs only to these.
      nightJobModels: deps.models.filter((model) => model.nightJobs).map((model) => model.digest),
    }),
  )

  app.get("/offpeak/v1/health", async (c) => {
    const engine = await deps.engines.state()
    return c.json(healthBody(inflight, engine.queueDepth, engine.ready && !deps.integrity.failed))
  })

  return app
}

/**
 * Plain HTTP, for a TLS proxy on this machine. The idle limit stays on until a request proves itself,
 * so a socket that sends nothing, or half a header, cannot be held open for good.
 */
export function serveAgent(app: ReturnType<typeof createAgentApp>, listen: { hostname: string; port: number }, idleTimeout = IDLE_TIMEOUT_S) {
  return Bun.serve({ ...listen, idleTimeout, fetch: (req, server) => app.fetch(req, { server }) })
}
