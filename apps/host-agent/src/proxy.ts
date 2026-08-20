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
