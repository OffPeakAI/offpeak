import { randomBytes } from "node:crypto"
import { ZERO_BYTES32, canonicalJson, type Hex } from "@offpeak/shared"
import { z } from "zod"
import {
  ACCEPTED_TCB,
  REVERIFY_S,
  TRANSCRIPT_MAX_AGE_S,
  attestReplySchema,
  checkTranscript,
  dcapVerify,
  gpuVerify,
  measurementSchema,
  quotesAllowed,
  type Measurement,
  type Transcript,
} from "../../../../packages/sdk/src/sealed/attest.ts"
import type { Stack } from "../context.ts"
import { oai } from "../http.ts"

export type AttestationTranscript = {
  host: string
  tcbStatus: string
  gpuOk: boolean
  measurementOk: boolean
  reportDataOk: boolean
}

export function verifyTranscript(row: AttestationTranscript): boolean {
  return ACCEPTED_TCB.includes(row.tcbStatus) && row.gpuOk && row.measurementOk && row.reportDataOk
}

const STATUS_TIMEOUT_MS = 2_000
const statusSchema = z.looseObject({ attestationRef: z.string() })
/** A fresh quote waits on the GPU tool, which can take most of a minute. */
const ATTEST_TIMEOUT_MS = 75_000
const RETRY_AFTER_S = 300

export type AttestConfig = {
  tdxVerifierUrl?: string
  gpuAttestationUrl?: string
  /** Empty means no host passes. */
  measurements: Measurement[]
}

/** Reads the allow-list from `OFFPEAK_SEALED_MEASUREMENTS`. A list that cannot be read stops the boot, and so does a verifier reached in the clear in production. */
export function readAttestConfig(env: { OFFPEAK_TDX_VERIFIER_URL?: string; OFFPEAK_GPU_ATTESTATION_URL?: string; OFFPEAK_SEALED_MEASUREMENTS?: string }, production = false): AttestConfig {
  const raw = env.OFFPEAK_SEALED_MEASUREMENTS
  for (const url of [env.OFFPEAK_TDX_VERIFIER_URL, env.OFFPEAK_GPU_ATTESTATION_URL]) {
    if (production && url && !url.startsWith("https://")) throw new Error("sealed verifiers must be https in production")
  }
  return {
    tdxVerifierUrl: env.OFFPEAK_TDX_VERIFIER_URL,
    gpuAttestationUrl: env.OFFPEAK_GPU_ATTESTATION_URL,
    measurements: raw ? z.array(measurementSchema).parse(JSON.parse(raw)) : [],
  }
}

export type VerifiedHost = { host: Hex; endpoint: string; attestationRef: Hex; tcbStatus: string; verifiedAt: number; transcript: Transcript }

/** Verified hosts in this process. It starts empty, so a restart trusts nothing until each host passes with a fresh nonce. */
export class AttestBook {
  readonly hosts = new Map<string, VerifiedHost>()
  readonly retryAt = new Map<string, number>()

  constructor(readonly config: AttestConfig) {}
}

type RegistryHost = Awaited<ReturnType<Stack["indexer"]["hostList"]>>[number]

const registryOf = (host: RegistryHost) => ({
  attestationRef: host.attestationRef.toLowerCase() as Hex,
  imageDigest: host.imageDigest.toLowerCase() as Hex,
  modelDigests: host.models.map((row) => row.digest.toLowerCase() as Hex),
})

const log = (event: string, host: string, reasons: string[]) => console.error(JSON.stringify({ service: "router", event, host, reasons }))

/** One full check with a new nonce. Anything that does not answer counts against the host. */
export async function attestHost(stack: Stack, book: AttestBook, host: RegistryHost): Promise<{ transcript: Transcript } | { reasons: string[] }> {
  const { tdxVerifierUrl, gpuAttestationUrl, measurements } = book.config
  if (!tdxVerifierUrl || !gpuAttestationUrl) return { reasons: ["no_verifier"] }
  if (!host.endpoint) return { reasons: ["no_endpoint"] }
  const owner = host.operator.toLowerCase() as Hex
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex
  const reply = await stack.hosts
    .request(owner, host.endpoint, `/offpeak/v1/attest?nonce=${nonce}`, { signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS) })
    .then(async (res) => (res.ok ? attestReplySchema.parse(await res.json()) : null))
    .catch(() => null)
  if (!reply) return { reasons: ["no_attestation"] }
  if (reply.nonce !== nonce) return { reasons: ["nonce"] }
  if (reply.hpkePublicKey !== reply.bindings.hpkePublicKey) return { reasons: ["identity"] }
  const send = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch
  const [fresh, boot, gpuResult] = await Promise.all([dcapVerify(send, tdxVerifierUrl, reply.quote), dcapVerify(send, tdxVerifierUrl, reply.boot.quote), gpuVerify(send, gpuAttestationUrl, nonce, reply.gpuEvidence)])
  const registry = registryOf(host)
  const transcript: Transcript = {
    v: 1,
    host: owner,
    nonce,
    verifiedAt: stack.clock(),
    bindings: reply.bindings,
    quote: reply.quote,
    gpuEvidence: reply.gpuEvidence,
    boot: reply.boot,
    registry,
    verdict: {
      quoteVerified: fresh.verified && boot.verified,
      tcbStatus: fresh.tcbStatus,
      bootTcbStatus: boot.tcbStatus,
      allowListed: quotesAllowed(measurements, registry.imageDigest, [reply, reply.boot]),
      gpuResult,
    },
  }
  const reasons = checkTranscript(transcript, { host: owner, now: stack.clock(), measurements })
  return reasons.length > 0 ? { reasons } : { transcript }
}
