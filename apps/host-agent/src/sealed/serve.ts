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
