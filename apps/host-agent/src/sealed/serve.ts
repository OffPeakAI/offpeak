import { randomBytes } from "node:crypto"
import type { Hono, MiddlewareHandler } from "hono"
import { MAX_REQUEST_S, type ChatBody, type ChatMessage } from "@offpeak/shared"
import { bytesToHex, keccak256, type Hex } from "viem"
import { z } from "zod"
import { ZERO_NONCE, attestationRefOf, sealedConfigHash, type Bindings, type GpuEvidence } from "../../../../packages/sdk/src/sealed/attest.ts"
import { FRAME_DATA_BYTES, RESPONSE_SALT_BYTES, inputTokenCeiling } from "../../../../packages/sdk/src/sealed/hpke.ts"
import { EngineOutput, SseReader, countInput, settleChat, withinDepth, type AgentTokenizer, type ServedBook } from "../meter.ts"
import { chatBody, checkSignedReq, forwardedBody, type AgentModel } from "../proxy.ts"
import { settledRequest } from "../sign.ts"
import { buildBindings, reportDataFor, sealedEngine } from "./bindings.ts"
import { CountsKey } from "./counts.ts"
import { GPU_EVIDENCE_COMMAND, collectGpuEvidence, gpuEvidenceHash } from "./gpu-evidence.ts"
import { HPKE_STREAM_CONTENT_TYPE, HpkeIdentity, SEALED_PATH, concatBytes, responseKey, sealFrame, sealedReqPayload } from "./hpke.ts"
import { readTdxQuote } from "./tdx.ts"

export const SEALED_CHAT_ROUTE = "/offpeak/v1/sealed/chat/completions"
export const SEALED_COUNTS_ROUTE = "/offpeak/v1/sealed/counts"

const MAX_TOKENS_LIMIT = 4096
/** Quotes and GPU evidence are slow. A queue this long means somebody is asking on purpose. */
const ATTEST_QUEUE_MAX = 4

const nonceSchema = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/)
  .transform((value) => `0x${value.replace(/^0x/, "").toLowerCase()}` as Hex)
  .refine((value) => value !== ZERO_NONCE, "the zero nonce is the boot quote's")

const headersSchema = z.object({
  model: z.string().min(1).max(128),
  maxTokens: z.coerce.number().int().min(1).max(MAX_TOKENS_LIMIT),
})

const refusal = (status: number, code: string, message: string) => Response.json({ error: { message, type: "invalid_request", code } }, { status })

const OPEN_REFUSED = {
  bad_time: () => refusal(400, "sealed_bad_time", "Client time is outside the replay window"),
  replayed_enc: () => refusal(409, "sealed_replayed_enc", "This request was already used"),
  cannot_open: () => refusal(400, "sealed_cannot_open", "Request cannot be opened"),
} as const

export type SealedBoot = {
  modelName: string
  modelDigest: Hex
  imageDigest: Hex
  operator: string
  engine: string
  tsmRoot: string
  /** For tests. No configuration reaches this, so a real boot always runs `GPU_EVIDENCE_COMMAND`. */
  gpuTool?: string[]
}

export type AttestBody = { nonce: Hex; hpkePublicKey: Hex; bindings: Bindings; quote: Hex; gpuEvidence: GpuEvidence; boot: { bindings: Bindings; quote: Hex } }

/** The VM's sealed identity: its key pair and the boot quote that ties that key to this image and model. */
export class SealedAgent {
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0

  private constructor(
    readonly boot: Required<SealedBoot>,
    readonly identity: HpkeIdentity,
    readonly countsKey: CountsKey,
    readonly bootBindings: Bindings,
    readonly bootQuote: Hex,
  ) {}

  /** Runs inside the VM before the agent opens a port. Any failure stops the boot. */
  static async start(input: SealedBoot) {
    const boot = { ...input, engine: sealedEngine(input.engine), gpuTool: input.gpuTool ?? GPU_EVIDENCE_COMMAND }
    const identity = await HpkeIdentity.generate()
    const countsKey = new CountsKey()
    const evidence = await collectGpuEvidence(boot.gpuTool, ZERO_NONCE)
    const configHash = sealedConfigHash({ modelName: boot.modelName, engine: boot.engine, tsmRoot: boot.tsmRoot, gpuTool: boot.gpuTool })
    const bindings = buildBindings({ modelDigest: boot.modelDigest, imageDigest: boot.imageDigest, operator: boot.operator, hpkePublicKey: identity.publicKey, countsSigner: countsKey.address, configHash, gpuEvidenceHash: gpuEvidenceHash(evidence) })
    const quote = await readTdxQuote(boot.tsmRoot, reportDataFor(bindings, ZERO_NONCE))
    return new SealedAgent(boot, identity, countsKey, bindings, bytesToHex(quote))
  }

  /** What `HostRegistry` must hold. A new boot means a new key, so a new quote and a new ref. */
  get attestationRef() {
    return attestationRefOf(this.bootQuote)
  }

  /** GPU evidence is collected again under this nonce, so its hash differs from the boot bindings'. The key does not. */
  private async fresh(nonce: Hex): Promise<AttestBody> {
    const gpuEvidence = await collectGpuEvidence(this.boot.gpuTool, nonce)
    const bindings = { ...this.bootBindings, gpuEvidenceHash: gpuEvidenceHash(gpuEvidence) }
    const quote = bytesToHex(await readTdxQuote(this.boot.tsmRoot, reportDataFor(bindings, nonce)))
    return { nonce, hpkePublicKey: this.identity.publicKey, bindings, quote, gpuEvidence, boot: { bindings: this.bootBindings, quote: this.bootQuote } }
  }

  /** One at a time, since the configfs entry is shared. `null` when the queue is full. */
  attest(nonce: Hex): Promise<AttestBody> | null {
    if (this.waiting >= ATTEST_QUEUE_MAX) return null
    this.waiting += 1
    const run = this.queue.then(() => this.fresh(nonce)).finally(() => (this.waiting -= 1))
    this.queue = run.catch(() => undefined)
    return run
  }
}

export type SealedRoutes = {
  app: Hono
  sealed: SealedAgent
  model: AgentModel
  limit: MiddlewareHandler
  /** Checks the router's header before any of the body is read. */
  signed: MiddlewareHandler
  routerAddress: string
  served: ServedBook
  clock: () => number
  /** The checks every inference route shares: router signature, one use per `reqId`, model integrity. */
  admit: (signedBody: string, header: string | undefined) => Promise<{ reqId: Hex; ts: number } | Response>
  inflight: (by: number) => void
}

type Open = {
  upstream: Response
  control: AbortController
  run: ReturnType<ServedBook["begin"]>
  tokenizer: AgentTokenizer
  body: ChatBody
  tokensIn: number
  secret: Uint8Array
  enc: Uint8Array
  inflight: (by: number) => void
}

/** Encrypts vLLM's stream frame by frame. A failure ends the body without the last frame, which the client reads as a cut stream. */
async function encryptStream({ upstream, control, run, tokenizer, body, tokensIn, secret, enc, inflight }: Open) {
  const output = new EngineOutput()
  const events = new SseReader()
  const reader = upstream.body!.getReader()
  const salt = new Uint8Array(randomBytes(RESPONSE_SALT_BYTES))
  const keys = await responseKey(secret, enc, salt)
  const sent: Uint8Array[] = [salt]
  let held = new Uint8Array(0)
  let index = 0
  let open = true
  const frame = async (plaintext: Uint8Array, last: boolean) => {
    const bytes = await sealFrame(keys, index, plaintext, last)
    index += 1
    sent.push(bytes)
    return bytes
  }
  const end = () => {
    if (!open) return
    open = false
    inflight(-1)
    settleChat(run.request, tokenizer, body, output, tokensIn)
    const outputHash = keccak256(concatBytes(...sent))
    // `settleChat` hashed the plaintext. A sealed request keeps no trace of it, on disk or in the signed log.
    run.request.outputHash = outputHash
    run.request.sealed!.outputHash = outputHash
    run.finish()
  }
  // The salt rides with the first frame, so the first bytes the router sees mean the engine has answered.
  let opening: Uint8Array | null = salt
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) => {
    controller.enqueue(opening ? concatBytes(opening, bytes) : bytes)
    opening = null
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Frames cut the stream at fixed offsets, so one frame is not one token. A stream pulls again only after a frame is queued.
        for (let filled = false; !filled; ) {
          const { done, value } = await reader.read()
          if (done) {
            emit(controller, await frame(held, true))
            end()
            controller.close()
            return
          }
          for (const event of events.push(value)) output.chunk(event)
          held = concatBytes(held, value)
          for (; held.length >= FRAME_DATA_BYTES; held = held.slice(FRAME_DATA_BYTES)) {
            emit(controller, await frame(held.subarray(0, FRAME_DATA_BYTES), false))
            filled = true
          }
        }
      } catch (err) {
        end()
        controller.error(err)
      }
    },
    cancel() {
      control.abort()
      end()
    },
  })
  return new Response(stream, { headers: { "content-type": HPKE_STREAM_CONTENT_TYPE, "cache-control": "no-cache" } })
}

/** The sealed routes. Decrypted bytes stay inside these handlers. Only counts and ciphertext hashes leave. */
export function mountSealed(deps: SealedRoutes) {
  const { app, sealed, model, limit, signed, served, clock, admit, inflight } = deps

  /** With no nonce this only says which boot is running, so the router can notice a restart cheaply. */
  app.get("/offpeak/v1/attest", async (c) => {
    const raw = c.req.query("nonce")
    if (raw === undefined) return c.json({ attestationRef: sealed.attestationRef, hpkePublicKey: sealed.identity.publicKey })
    const nonce = nonceSchema.safeParse(raw)
    if (!nonce.success) return refusal(400, "bad_nonce", "Nonce must be 32 bytes of hex and not zero")
    const running = sealed.attest(nonce.data)
    if (!running) return refusal(429, "attest_busy", "Too many attestations are running")
    return running.then(
      (body) => c.json(body),
      () => Response.json({ error: { message: "Attestation failed", type: "engine", code: "attest_failed" } }, { status: 503 }),
    )
  })

  app.post(SEALED_CHAT_ROUTE, signed, limit, async (c) => {
    const head = headersSchema.safeParse({ model: c.req.header("x-offpeak-model"), maxTokens: c.req.header("x-offpeak-max-tokens") })
    if (!head.success) return refusal(400, "bad_request", "Model and max tokens headers are required")
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const promptHash = keccak256(bytes)
    const req = await admit(sealedReqPayload({ bodyHash: promptHash, ...head.data }), c.req.header("x-offpeak-req"))
    if (req instanceof Response) return req
    if (head.data.model !== sealed.boot.modelName) return refusal(404, "model_not_found", "This host does not seal that model")
    const opened = await sealed.identity.open(bytes, SEALED_PATH, clock() * 1000)
    if ("refused" in opened) return OPEN_REFUSED[opened.refused]()
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(opened.plaintext))
    } catch {
      return refusal(400, "bad_request", "Body is not a chat request")
    }
    const parsed = chatBody.safeParse(json)
    if (!parsed.success || !withinDepth(json)) return refusal(400, "bad_request", "Body is not a chat request")
    // The router priced and held the clear headers. The body inside must not ask for more than they paid for.
    if (parsed.data.model !== head.data.model) return refusal(400, "sealed_model_mismatch", "The sealed body names another model")
    const asked = parsed.data.max_completion_tokens ?? parsed.data.max_tokens
    if (asked != null && (!Number.isInteger(asked) || (asked as number) < 1)) return refusal(400, "bad_max_tokens", "max_tokens must be a positive integer")
    const maxTokens = Math.min((asked as number | null | undefined) ?? head.data.maxTokens, head.data.maxTokens)
    const body: ChatBody = { messages: parsed.data.messages as ChatMessage[], tools: parsed.data.tools ?? undefined }
    // Counted before the engine runs. Output the VM cannot put a count on is output nobody can be billed for.
    const tokensIn = countInput(model.tokenizer, body)
    if (tokensIn === null || tokensIn > inputTokenCeiling(bytes.length)) return refusal(400, "uncountable", "This request cannot be counted")
    const control = new AbortController()
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(MAX_REQUEST_S * 1000)])
    inflight(1)
    const upstream = await fetch(`${sealed.boot.engine}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardedBody({ ...parsed.data, stream: true, max_tokens: maxTokens })),
      redirect: "error",
      signal,
    }).catch(() => null)
    // vLLM's error text can quote the prompt, and the router would read it. Only a code goes back.
    if (!upstream?.ok || !upstream.body) {
      inflight(-1)
      await upstream?.body?.cancel().catch(() => undefined)
      return Response.json({ error: { message: "Engine refused the request", type: "engine", code: "engine_refused" } }, { status: 502 })
    }
    const run = served.begin({ reqId: req.reqId, ts: req.ts, modelDigest: model.digest })
    run.request.sealed = { promptHash, outputHash: null }
    return encryptStream({ upstream, control, run, tokenizer: model.tokenizer, body, tokensIn, secret: opened.secret, enc: opened.enc, inflight })
  })

  /** The router cannot count ciphertext, so it asks here. The answer carries a signature only this VM can make. */
  app.get(`${SEALED_COUNTS_ROUTE}/:reqId`, async (c) => {
    const reqId = c.req.param("reqId")
    const req = await checkSignedReq(c.req.header("x-offpeak-req"), deps.routerAddress, reqId, clock())
    if (!req || req.reqId.toLowerCase() !== reqId.toLowerCase()) return Response.json({ error: { message: "signature required", type: "auth", code: "bad_router_req" } }, { status: 401 })
    const request = served.get(reqId)
    if (!request?.sealed) return refusal(404, "unknown_request", "No sealed request has this id")
    const finished = await settledRequest(request)
    const { promptHash, outputHash } = request.sealed
    if (!finished || !request.counts || !outputHash) return refusal(409, "uncounted", "This request has no counts yet")
    return c.json(await sealed.countsKey.sign({ reqId: request.reqId, ...request.counts, promptHash, outputHash }))
  })
}
