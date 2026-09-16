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
