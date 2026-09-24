import { randomBytes } from "node:crypto"
import type { Hex } from "viem"
import { z } from "zod"
import type { Db } from "../../../services/common/src/db.ts"
import { signRouterBody } from "../../host-agent/src/proxy.ts"

export type TempBucket = "0" | "(0,0.5]" | "(0.5,1]" | ">1"
export type LenBucket = "<=64" | "<=256" | "<=1024" | ">1024"

export function tempBucket(temperature: number): TempBucket {
  if (temperature <= 0) return "0"
  if (temperature <= 0.5) return "(0,0.5]"
  if (temperature <= 1) return "(0.5,1]"
  return ">1"
}

export function lenBucket(tokens: number): LenBucket {
  if (tokens <= 64) return "<=64"
  if (tokens <= 256) return "<=256"
  if (tokens <= 1024) return "<=1024"
  return ">1024"
}

/** OpenAI-style requests default to 1 when temperature is left out. */
export const temperatureOf = (body: Record<string, unknown>) => (typeof body.temperature === "number" ? body.temperature : 1)

/** The hottest request `collect.ts` calibrates. Past it, the same bucket holds a different distribution. */
export const MAX_CALIBRATED_TEMPERATURE = 1.2

/** Fields that change nothing about which tokens a model is likely to emit. */
const NEUTRAL_PARAMS = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "seed", "stop", "logprobs", "top_logprobs", "n", "user"])

/** At these values a parameter does nothing, so a body may carry it. */
const INERT_VALUES: Record<string, (value: unknown) => boolean> = {
  top_p: (value) => value === 1,
  presence_penalty: (value) => value === 0,
  frequency_penalty: (value) => value === 0,
  tools: (value) => Array.isArray(value) && value.length === 0,
  tool_choice: (value) => value === "none",
  response_format: (value) => (value as { type?: unknown }).type === "text",
}

/**
 * The first parameter calibration never saw, or null. Baselines are fitted on plain requests, so a
 * penalty, a forced format or a very high temperature lowers ℓ on an honest host, and whoever opts in
 * to sampling picks these. Anything unknown counts as uncalibrated, so a new field cannot slip through.
 */
export function uncalibratedParam(body: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(body)) {
    if (value === null || value === undefined || NEUTRAL_PARAMS.has(name)) continue
    if (!INERT_VALUES[name]?.(value)) return name
  }
  return temperatureOf(body) > MAX_CALIBRATED_TEMPERATURE ? "temperature" : null
}

export type BaselineKey = { modelDigest: string; gpuClass: string; imageDigest: string; tempBucket: string; lenBucket: string }
export type Baseline = BaselineKey & { mu: number; sigma: number; n: number; version: string }

export const baselineId = (key: BaselineKey) => [key.modelDigest, key.gpuClass, key.imageDigest, key.tempBucket, key.lenBucket].join("|")

/** One side only: a swap or quantisation lowers ℓ, so z runs negative. */
export function standardise(ll: number, baseline: Pick<Baseline, "mu" | "sigma">) {
  return (ll - baseline.mu) / baseline.sigma
}

export function llMean(logprobs: readonly number[]) {
  let sum = 0
  for (const value of logprobs) sum += value
  return sum / logprobs.length
}

export type ReferenceHost = { host: string; modelDigest: string; endpoint: string; gpuClass: string; imageDigest: string; attested: boolean }

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export type ScoreSigner = Parameters<typeof signRouterBody>[0]

/** Only the per-token values are read: a mean a reference reports is not the auditor's to trust. */
const scoreReply = z.object({ logprobs: z.array(z.object({ logprob: z.number().finite().max(0) })).min(1) })

export type ScoreInput = { model: string; messages: unknown; tools?: unknown; output: string }

/** Teacher-forced scoring on a reference host. Throws on anything but a usable answer. */
export async function scoreOnReference(fetcher: Fetcher, signer: ScoreSigner, reference: Pick<ReferenceHost, "endpoint" | "host">, input: ScoreInput, nowS = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify({ model: input.model, messages: input.messages, tools: input.tools, output: input.output })
  const header = await signRouterBody(signer, { reqId: `0x${randomBytes(32).toString("hex")}` as Hex, ts: nowS, payload: body })
  const res = await fetcher(`${reference.endpoint}/offpeak/v1/score`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-offpeak-audit": header },
    body,
  })
  if (!res.ok) throw new Error(`reference ${reference.host} answered ${res.status}`)
  return llMean(scoreReply.parse(await res.json()).logprobs.map((row) => row.logprob))
}

/** Reference hosts able to score a response: never the host under audit, same model, same GPU class. */
export function referencesFor(references: readonly ReferenceHost[], target: { host: string; modelDigest: string; gpuClass: string }) {
  return references
    .filter((r) => r.host !== target.host && r.modelDigest === target.modelDigest && r.gpuClass === target.gpuClass)
    .sort((a, b) => Number(b.attested) - Number(a.attested) || (a.host < b.host ? -1 : 1))
}

export async function loadReferences(db: Db): Promise<ReferenceHost[]> {
  const rows = await db.query<{ host: string; model_digest: string; endpoint: string; gpu_class: string; image_digest: string; attested: boolean }>("SELECT * FROM serving.audit_reference_hosts")
  return rows.rows.map((r) => ({ host: r.host, modelDigest: r.model_digest, endpoint: r.endpoint, gpuClass: r.gpu_class, imageDigest: r.image_digest, attested: r.attested }))
}

type BaselineRow = { model_digest: string; gpu_class: string; image_digest: string; temp_bucket: string; len_bucket: string; mu: number; sigma: number; n: number; version: string }

const asBaseline = (r: BaselineRow): Baseline => ({
  modelDigest: r.model_digest,
  gpuClass: r.gpu_class,
  imageDigest: r.image_digest,
  tempBucket: r.temp_bucket,
  lenBucket: r.len_bucket,
  mu: Number(r.mu),
  sigma: Number(r.sigma),
  n: Number(r.n),
  version: r.version,
})

/** The newest version for each bucket key. */
export async function loadBaselines(db: Db, modelDigest?: string) {
  const rows = await db.query<BaselineRow>(
    `SELECT DISTINCT ON (model_digest, gpu_class, image_digest, temp_bucket, len_bucket) *
     FROM serving.audit_baselines WHERE ($1::text IS NULL OR model_digest = $1)
     ORDER BY model_digest, gpu_class, image_digest, temp_bucket, len_bucket, version DESC`,
    [modelDigest ?? null],
  )
  return new Map(rows.rows.map((row) => [baselineId(asBaseline(row)), asBaseline(row)]))
}

export type ScoredResponse = {
  reqId: string
  host: string
  modelDigest: string
  gpuClass: string
  imageDigest: string
  source: "sample" | "canary"
  temperature: number
  tokensOut: number
  ts: number
  ll: number
  refHost: string
}

/** A score with no baseline yet keeps its ℓ and waits; `fillMissingZ` completes it later. */
export async function recordScore(db: Db, baselines: Map<string, Baseline>, row: ScoredResponse) {
  const key = { modelDigest: row.modelDigest, gpuClass: row.gpuClass, imageDigest: row.imageDigest, tempBucket: tempBucket(row.temperature), lenBucket: lenBucket(row.tokensOut) }
  const baseline = baselines.get(baselineId(key))
  await db.query(
    `INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, source, ts, gpu_class, image_digest, temp_bucket, len_bucket, baseline_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (req_id) DO NOTHING`,
    [
      row.reqId,
      row.host,
      row.modelDigest,
      baselineId(key),
      row.ll,
      baseline ? standardise(row.ll, baseline) : null,
      row.refHost,
      row.source,
      row.ts,
      row.gpuClass,
      row.imageDigest,
      key.tempBucket,
      key.lenBucket,
      baseline?.version ?? null,
    ],
  )
  return baseline !== undefined
}

export async function fillMissingZ(db: Db) {
  const baselines = await loadBaselines(db)
  const rows = await db.query<{ req_id: string; bucket: string; ll_mean: number }>("SELECT req_id, bucket, ll_mean FROM serving.audit_scores WHERE z IS NULL")
  let filled = 0
  for (const row of rows.rows) {
    const baseline = baselines.get(row.bucket)
    if (!baseline) continue
    await db.query("UPDATE serving.audit_scores SET z = $2, baseline_version = $3 WHERE req_id = $1", [row.req_id, standardise(Number(row.ll_mean), baseline), baseline.version])
    filled++
  }
  return filled
}
