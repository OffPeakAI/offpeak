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

async function drop(stack: Stack, book: AttestBook, host: string) {
  book.hosts.delete(host)
  await stack.db.query("DELETE FROM serving.sealed_attestations WHERE host = $1", [host])
}

async function record(stack: Stack, book: AttestBook, host: RegistryHost, transcript: Transcript) {
  const owner = transcript.host
  const row: VerifiedHost = { host: owner, endpoint: host.endpoint!, attestationRef: transcript.registry.attestationRef, tcbStatus: transcript.verdict.tcbStatus, verifiedAt: transcript.verifiedAt, transcript }
  await stack.db.query(
    `INSERT INTO serving.sealed_attestations (host, attestation_ref, verified_at, tcb_status, transcript) VALUES ($1,$2,to_timestamp($3),$4,$5::jsonb)
     ON CONFLICT (host) DO UPDATE SET attestation_ref = EXCLUDED.attestation_ref, verified_at = EXCLUDED.verified_at, tcb_status = EXCLUDED.tcb_status, transcript = EXCLUDED.transcript`,
    [owner, row.attestationRef, row.verifiedAt, row.tcbStatus, canonicalJson(transcript)],
  )
  book.hosts.set(owner, row)
  book.retryAt.delete(owner)
}

/** The registry moved, or the running boot is no longer the one this router verified. */
async function stillSame(stack: Stack, known: VerifiedHost, host: RegistryHost) {
  const registry = registryOf(host)
  const { bindings } = known.transcript
  if (registry.attestationRef !== known.attestationRef || registry.imageDigest !== bindings.imageDigest || !registry.modelDigests.includes(bindings.modelDigest)) return false
  const status = await stack.hosts
    .request(known.host, host.endpoint!, "/offpeak/v1/attest", { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    .then(async (res) => (res.ok ? statusSchema.parse(await res.json()) : null))
    .catch(() => null)
  return status?.attestationRef.toLowerCase() === known.attestationRef
}

async function sweepHost(stack: Stack, book: AttestBook, host: RegistryHost) {
  const owner = host.operator.toLowerCase()
  const now = stack.clock()
  const known = book.hosts.get(owner)
  const registered = host.attestationRef !== ZERO_BYTES32 && Boolean(host.endpoint)
  if (!registered) {
    if (known) await drop(stack, book, owner)
    return
  }
  if (known && now - known.verifiedAt < REVERIFY_S && (await stillSame(stack, known, host))) return
  // A host that drops out loses its place at once. The next check decides whether it comes back.
  if (known) await drop(stack, book, owner)
  if ((book.retryAt.get(owner) ?? 0) > now && !known) return
  const result = await attestHost(stack, book, host)
  if ("transcript" in result) {
    await record(stack, book, host, result.transcript)
    return
  }
  book.retryAt.set(owner, now + RETRY_AFTER_S)
  await drop(stack, book, owner)
  log("sealed_host_refused", owner, result.reasons)
}

/**
 * One pass over the registry. A host is checked when it is new, when 24 h have passed, or when its
 * boot changed. With no verifier configured nothing passes, and whatever was verified is dropped.
 */
export async function sweepAttestations(stack: Stack) {
  const book = stack.attest
  if (!book) return
  if (!book.config.tdxVerifierUrl || !book.config.gpuAttestationUrl) {
    book.hosts.clear()
    await stack.db.query("DELETE FROM serving.sealed_attestations")
    return
  }
  const hosts = await stack.indexer.hostList()
  await Promise.all(hosts.map((host) => sweepHost(stack, book, host).catch((err) => log("sealed_sweep_failed", host.operator.toLowerCase(), [String(err)]))))
  const listed = hosts.map((host) => host.operator.toLowerCase())
  for (const host of book.hosts.keys()) if (!listed.includes(host)) await drop(stack, book, host)
  await stack.db.query("DELETE FROM serving.sealed_attestations WHERE NOT (host = ANY($1::text[]))", [listed])
}

/** The verified row, unless the sweep has stopped keeping it fresh, which reads as not verified. */
export function verifiedHost(stack: Stack, host: string): VerifiedHost | null {
  const row = stack.attest?.hosts.get(host.toLowerCase())
  if (!row || stack.clock() - row.verifiedAt > TRANSCRIPT_MAX_AGE_S) return null
  return row
}

const attestAsk = z.object({ host: z.string().regex(/^0x[0-9a-fA-F]{40}$/), nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })

/** A client's fresh quote, under its own nonce. Its own checks judge the reply, so this only passes it on, and the host never sees who asked. */
export async function relayAttest(stack: Stack, host: string | null, nonce: string) {
  const ask = attestAsk.safeParse({ host, nonce })
  if (!ask.success) return oai(400, "X-Offpeak-Sealed-Host and X-Offpeak-Attest-Nonce are required", "invalid_request", "bad_sealed_headers")
  const known = verifiedHost(stack, ask.data.host)
  if (!known) return oai(503, "That host is not available for sealed requests", "capacity", "sealed_host_unavailable")
  const reply = await stack.hosts.request(known.host, known.endpoint, `/offpeak/v1/attest?nonce=${ask.data.nonce}`, { signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS) }).catch(() => null)
  if (!reply?.ok) return oai(503, "The host did not attest", "engine", "no_attestation")
  return new Response(await reply.text(), { headers: { "content-type": "application/json" } })
}

/** `GET /v1/sealed/hosts`. Hosts appear here with the evidence behind them, so a client can check every claim. */
export function sealedHostsView(stack: Stack, modelName: string | undefined) {
  const digest = modelName === undefined ? undefined : stack.models.find((row) => row.name === modelName)?.digest
  const rows = [...(stack.attest?.hosts.keys() ?? [])].flatMap((host) => {
    const row = verifiedHost(stack, host)
    const matches = row && (modelName === undefined || row.transcript.bindings.modelDigest === digest)
    if (!matches) return []
    const { bindings } = row.transcript
    return [{ host: row.host, modelDigest: bindings.modelDigest, hpkePublicKey: bindings.hpkePublicKey, attestationRef: row.attestationRef, tcbStatus: row.tcbStatus, verifiedAt: row.verifiedAt, transcript: row.transcript }]
  })
  return { enabled: stack.flags.sealed, ...(stack.flags.sealed ? {} : { note: "The sealed tier is not switched on yet." }), hosts: rows }
}
