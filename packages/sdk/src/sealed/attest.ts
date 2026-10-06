import { ZERO_BYTES32, canonicalJson, sha256Hex } from "@offpeak/shared"
import { bytesToHex, hexToBytes, verifyMessage, type Hex } from "viem"
import { z } from "zod"
import { addressSchema, bytes32Schema, hexSchema } from "../core.ts"

/** Every other status means the platform needs work before its quotes can be trusted. */
export const ACCEPTED_TCB: readonly string[] = ["UpToDate", "SWHardeningNeeded"]

export const ZERO_NONCE = ZERO_BYTES32 as Hex
export const REVERIFY_S = 86_400
/** A sweep needs a moment to finish a due check before its result counts as late. */
export const TRANSCRIPT_MAX_AGE_S = REVERIFY_S + 3_600
/** A clock this far ahead is a difference between machines. Past it, a transcript's date cannot be believed. */
const CLOCK_SKEW_S = 300

const VERIFIER_TIMEOUT_MS = 15_000
const GPU_OVERALL_CLAIM = "x-nvidia-overall-att-result"

const QUOTE_V4 = 4
const TEE_TDX = 0x81
const QUOTE_HEADER_BYTES = 48
const TD_BODY_BYTES = 584
const TD_ATTRIBUTES_AT = QUOTE_HEADER_BYTES + 120
const MRTD_AT = QUOTE_HEADER_BYTES + 136
const RTMR_AT = QUOTE_HEADER_BYTES + 328
const REPORT_DATA_AT = QUOTE_HEADER_BYTES + 520
const MEASUREMENT_BYTES = 48
const REPORT_DATA_BYTES = 64
const TD_DEBUG_BIT = 0x01
const COUNTS_DOMAIN = "offpeak-sealed-counts/v1"

const measurementHex = z
  .string()
  .regex(/^0x[0-9a-fA-F]{96}$/)
  .transform((value) => value.toLowerCase() as Hex)

export const measurementSchema = z.strictObject({
  imageDigest: bytes32Schema,
  mrtd: measurementHex,
  rtmrs: z.tuple([measurementHex, measurementHex, measurementHex, measurementHex]),
  /** The `configHash` this VM must report. The measurements do not cover `host.yaml`, and this does. */
  configHash: bytes32Schema,
})

export type Measurement = z.infer<typeof measurementSchema>

export const bindingsSchema = z.strictObject({
  v: z.literal(1),
  modelDigest: bytes32Schema,
  imageDigest: bytes32Schema,
  operator: addressSchema,
  hpkePublicKey: bytes32Schema,
  /** The address of the key that signs this boot's counts. It is made in the VM and never leaves. */
  countsSigner: addressSchema,
  configHash: bytes32Schema,
  gpuEvidenceHash: bytes32Schema,
})

export type Bindings = z.infer<typeof bindingsSchema>

/** What NVIDIA's tooling collects, kept as it came. The remote service reads it, not this code. */
export const gpuEvidenceSchema = z.looseObject({
  arch: z.string().min(1),
  evidence_list: z.array(z.looseObject({})).min(1),
})

export type GpuEvidence = z.infer<typeof gpuEvidenceSchema>

const quoteHex = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/)
  .transform((value) => value.toLowerCase() as Hex)

export const verdictSchema = z.strictObject({
  quoteVerified: z.boolean(),
  tcbStatus: z.string(),
  bootTcbStatus: z.string(),
  allowListed: z.boolean(),
  gpuResult: z.boolean(),
})

export type Verdict = z.infer<typeof verdictSchema>

export const registrySchema = z.strictObject({
  attestationRef: bytes32Schema,
  imageDigest: bytes32Schema,
  modelDigests: z.array(bytes32Schema),
})

export type RegistryView = z.infer<typeof registrySchema>

export const transcriptSchema = z.strictObject({
  v: z.literal(1),
  host: addressSchema,
  nonce: bytes32Schema,
  verifiedAt: z.int().nonnegative(),
  bindings: bindingsSchema,
  quote: quoteHex,
  gpuEvidence: gpuEvidenceSchema,
  boot: z.strictObject({ bindings: bindingsSchema, quote: quoteHex }),
  registry: registrySchema,
  verdict: verdictSchema,
})

export type Transcript = z.infer<typeof transcriptSchema>

export const attestReplySchema = z.strictObject({
  nonce: bytes32Schema,
  hpkePublicKey: bytes32Schema,
  bindings: bindingsSchema,
  quote: quoteHex,
  gpuEvidence: gpuEvidenceSchema,
  boot: z.strictObject({ bindings: bindingsSchema, quote: quoteHex }),
})

export type AttestReply = z.infer<typeof attestReplySchema>

export const gpuEvidenceHash = (evidence: GpuEvidence): Hex => sha256Hex(canonicalJson(evidence))

export const bindingsHash = (bindings: Bindings): Hex => sha256Hex(canonicalJson(bindings))

/** Everything in a host's configuration that decides where decrypted bytes go. */
export type SealedConfig = { modelName: string; engine: string; tsmRoot: string; gpuTool: string[] }

export const sealedConfigHash = (config: SealedConfig): Hex => sha256Hex(canonicalJson(config))

/** What the VM says it counted for one request. `sig` is from the key named in `countsSigner`. */
export const sealedCountsSchema = z.strictObject({
  reqId: bytes32Schema,
  tokensIn: z.int().nonnegative(),
  tokensOut: z.int().nonnegative(),
  promptHash: bytes32Schema,
  outputHash: bytes32Schema,
  sig: hexSchema,
})

export type SealedCounts = z.infer<typeof sealedCountsSchema>

export const countsMessage = ({ reqId, tokensIn, tokensOut, promptHash, outputHash }: Omit<SealedCounts, "sig">) => canonicalJson({ domain: COUNTS_DOMAIN, outputHash, promptHash, reqId, tokensIn, tokensOut })

/** True when the key the quote names signed exactly these counts. Nothing outside the VM holds that key. */
export function countsSignedBy(counts: SealedCounts, signer: Hex) {
  return verifyMessage({ address: signer, message: countsMessage(counts), signature: counts.sig }).catch(() => false)
}

/** `sha256(canonicalJson(bindings)) ‖ nonce`, the 64 bytes a TDX report carries. */
export function reportDataFor(bindings: Bindings, nonce: Hex) {
  const out = new Uint8Array(REPORT_DATA_BYTES)
  out.set(hexToBytes(bindingsHash(bindings)), 0)
  out.set(hexToBytes(nonce), 32)
  return out
}

export const attestationRefOf = (bootQuote: Hex): Hex => sha256Hex(hexToBytes(bootQuote))

export type ParsedQuote = { mrtd: Hex; rtmrs: [Hex, Hex, Hex, Hex]; reportData: Hex; debug: boolean }

/** Reads a TDX v4 quote's report body. The verifier vouches for these bytes, so they need no other source. */
export function parseQuote(quote: Hex): ParsedQuote {
  const bytes = hexToBytes(quote)
  if (bytes.length < QUOTE_HEADER_BYTES + TD_BODY_BYTES) throw new Error("quote is too short")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== QUOTE_V4 || view.getUint32(4, true) !== TEE_TDX) throw new Error("not a TDX v4 quote")
  const measurement = (at: number) => bytesToHex(bytes.subarray(at, at + MEASUREMENT_BYTES))
  return {
    mrtd: measurement(MRTD_AT),
    rtmrs: [measurement(RTMR_AT), measurement(RTMR_AT + MEASUREMENT_BYTES), measurement(RTMR_AT + 2 * MEASUREMENT_BYTES), measurement(RTMR_AT + 3 * MEASUREMENT_BYTES)],
    reportData: bytesToHex(bytes.subarray(REPORT_DATA_AT, REPORT_DATA_AT + REPORT_DATA_BYTES)),
    debug: (bytes[TD_ATTRIBUTES_AT]! & TD_DEBUG_BIT) !== 0,
  }
}

/** An empty list matches nothing, so no host passes until real values are configured. */
export function measurementAllowed(list: Measurement[], imageDigest: Hex, parsed: ParsedQuote, configHash: Hex) {
  return list.some((row) => row.imageDigest === imageDigest && row.configHash === configHash && row.mrtd === parsed.mrtd && row.rtmrs.every((rtmr, index) => rtmr === parsed.rtmrs[index]))
}

/** Every quote against one list. A quote that cannot be read is not allowed. */
export function quotesAllowed(list: Measurement[], imageDigest: Hex, quotes: { quote: Hex; bindings: Bindings }[]) {
  try {
    return quotes.every(({ quote, bindings }) => measurementAllowed(list, imageDigest, parseQuote(quote), bindings.configHash))
  } catch {
    return false
  }
}

export type Expected = {
  host: string
  now: number
  maxAgeS?: number
  /** Given, this list decides. Left out, the transcript's `allowListed` does. */
  measurements?: Measurement[]
}

function quoteFailures(transcript: Transcript, expected: Expected): string[] {
  let fresh: ParsedQuote
  let boot: ParsedQuote
  try {
    fresh = parseQuote(transcript.quote)
    boot = parseQuote(transcript.boot.quote)
  } catch {
    return ["quote_format"]
  }
  const reasons: string[] = []
  // MRTD does not cover the debug attribute, and a debug TD lets its host read guest memory.
  if (fresh.debug || boot.debug) reasons.push("debug_td")
  const image = transcript.registry.imageDigest
  const allowed = expected.measurements ? quotesAllowed(expected.measurements, image, [transcript, transcript.boot]) : transcript.verdict.allowListed
  const sameVm = fresh.mrtd === boot.mrtd && fresh.rtmrs.every((rtmr, index) => rtmr === boot.rtmrs[index])
  if (!allowed || !sameVm) reasons.push("measurement")
  if (fresh.reportData !== bytesToHex(reportDataFor(transcript.bindings, transcript.nonce))) reasons.push("bindings")
  if (boot.reportData !== bytesToHex(reportDataFor(transcript.boot.bindings, ZERO_NONCE))) reasons.push("bindings")
  return reasons
}

function identityFailures(transcript: Transcript, host: string): string[] {
  const { bindings, boot, registry } = transcript
  const owner = host.toLowerCase()
  const sameKey = bindings.hpkePublicKey === boot.bindings.hpkePublicKey && bindings.countsSigner === boot.bindings.countsSigner
  const sameServing = bindings.modelDigest === boot.bindings.modelDigest && bindings.imageDigest === boot.bindings.imageDigest && bindings.configHash === boot.bindings.configHash
  const named = transcript.host === owner && bindings.operator === owner && boot.bindings.operator === owner
  const registered = bindings.imageDigest === registry.imageDigest && registry.modelDigests.includes(bindings.modelDigest)
  return sameKey && sameServing && named && registered ? [] : ["identity"]
}

/**
 * The same rules on both sides of the router. It runs them before it publishes a host, and the SDK
 * runs them again on what was published. An empty list means the host passed.
 */
export function checkTranscript(transcript: Transcript, expected: Expected): string[] {
  const { verdict, bindings, registry } = transcript
  const reasons: string[] = []
  if (!verdict.quoteVerified) reasons.push("quote_verifier")
  if (!ACCEPTED_TCB.includes(verdict.tcbStatus) || !ACCEPTED_TCB.includes(verdict.bootTcbStatus)) reasons.push("tcb_status")
  if (!verdict.gpuResult) reasons.push("gpu")
  if (gpuEvidenceHash(transcript.gpuEvidence) !== bindings.gpuEvidenceHash) reasons.push("gpu_evidence")
  reasons.push(...quoteFailures(transcript, expected), ...identityFailures(transcript, expected.host))
  if (transcript.nonce === ZERO_NONCE) reasons.push("nonce")
  if (registry.attestationRef === ZERO_NONCE || attestationRefOf(transcript.boot.quote) !== registry.attestationRef) reasons.push("attestation_ref")
  const age = expected.now - transcript.verifiedAt
  if (age > (expected.maxAgeS ?? TRANSCRIPT_MAX_AGE_S) || age < -CLOCK_SKEW_S) reasons.push("stale")
  return [...new Set(reasons)]
}

const dcapReply = z.looseObject({ verified: z.boolean(), tcbStatus: z.string() })

const post = (send: typeof fetch, url: string, body: unknown) =>
  send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(VERIFIER_TIMEOUT_MS) })

/** Asks a DCAP verification service about one quote. Silence or a bad answer reads as not verified. */
export async function dcapVerify(send: typeof fetch, url: string, quote: Hex): Promise<{ verified: boolean; tcbStatus: string }> {
  try {
    const res = await post(send, url, { quote })
    if (!res.ok) return { verified: false, tcbStatus: "Unavailable" }
    const reply = dcapReply.parse(await res.json())
    return { verified: reply.verified, tcbStatus: reply.tcbStatus }
  } catch {
    return { verified: false, tcbStatus: "Unavailable" }
  }
}

const gpuReply = z.tuple([z.tuple([z.literal("JWT"), z.string()])]).rest(z.unknown())

function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? ""
  return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
}

/**
 * Asks NVIDIA's remote attestation service about a GPU. The answer is believed because TLS to the
 * configured URL says who sent it: the token's own signature is not checked here.
 */
export async function gpuVerify(send: typeof fetch, url: string, nonce: Hex, evidence: GpuEvidence): Promise<boolean> {
  const bare = nonce.slice(2)
  try {
    const res = await post(send, url, { ...evidence, nonce: bare })
    if (!res.ok) return false
    const claims = jwtClaims(gpuReply.parse(await res.json())[0][1])
    return claims[GPU_OVERALL_CLAIM] === true && claims.eat_nonce === bare
  } catch {
    return false
  }
}
