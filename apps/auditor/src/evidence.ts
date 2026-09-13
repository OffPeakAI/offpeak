import { TEST_ID, TEST_VERSION, publishedBaseline, score } from "@offpeak/audit-tests"
import { evidenceRoot, keccakUtf8, type EvidenceBundle, type EvidenceSample, type Hex } from "@offpeak/shared"
import type { Db } from "../../../services/common/src/db.ts"
import type { AuditDeps } from "./deps.ts"

/**
 * `z = (ll − mu) / sigma`, with both the values and the baseline version that made it, so a host can
 * recheck every score. `replicaLl` is the second reference host's ℓ, read against the same baseline.
 */
export type ScoreDetail = { reqId: string; source: string; refHost: string; ll: number; z: number; mu: number | null; sigma: number | null; baselineVersion: string | null; bucket: string; replicaRef: string | null; replicaLl: number | null; replicaZ: number | null }
export type CanaryDetail = { reqId: string; promptId: string; deterministic: boolean; body: unknown; output: string; accepted: string[] }
export type BuyerDetail = { reqId: string; promptHash: string; outputHash: string; encryptedBodyHeld: boolean }

/** What the replication rests on: scores by a second reference host, on responses the first run never read. */
export type Replication = { primaryRef: string; refHost: string; reqIds: string[]; zs: number[] }

export type Attachments = {
  firstRun: number
  scores: ScoreDetail[]
  canaries: CanaryDetail[]
  buyerSamples: BuyerDetail[]
  replication: Replication | null
  canaryThreshold: number
}

/** `Evidence.samplesRoot` commits to all of it, attachments included, because the root covers the whole body. */
export type AuditBundle = EvidenceBundle & { attachments: Attachments }

export const evidenceUri = (root: string) => `offpeak://evidence/${root}`

type ScoreRow = {
  req_id: string
  source: string
  ref_host: string
  ll_mean: number
  z: number
  mu: number | null
  sigma: number | null
  baseline_version: string | null
  bucket: string
  ts: string
  replica_ref: string | null
  replica_ll: number | null
  replica_z: number | null
  payer: string | null
}

export type RunScores = ScoreDetail & { ts: number; payer: string | null }

const orNull = (value: number | null) => (value === null ? null : Number(value))

/** Stands in for a buyer's wallet in a bundle a host may read. It groups one host-model's samples and links nothing wider. */
export const payerTag = (payer: string, host: string, modelDigest: string) => keccakUtf8(`offpeak-audit-payer:${payer.toLowerCase()}:${host}:${modelDigest}`)

/** A host-model's scored responses, oldest first, with any second reference host's score. */
export async function loadRunScores(db: Db, host: string, modelDigest: string, fromTs: number, toTs: number): Promise<RunScores[]> {
  const rows = await db.query<ScoreRow>(
    `SELECT s.req_id, s.source, s.ref_host, s.ll_mean, s.z, b.mu, b.sigma, s.baseline_version, s.bucket, s.ts, r.ref_host AS replica_ref, r.ll_mean AS replica_ll, r.z AS replica_z, u.payer
     FROM serving.audit_scores s
     LEFT JOIN serving.audit_replications r ON r.req_id = s.req_id AND r.ref_host <> s.ref_host
     LEFT JOIN serving.audit_baselines b ON b.model_digest = s.model_digest AND b.gpu_class = s.gpu_class AND b.image_digest = s.image_digest AND b.temp_bucket = s.temp_bucket AND b.len_bucket = s.len_bucket AND b.version = s.baseline_version
     LEFT JOIN shared.usage_records u ON s.source = 'sample' AND u.req_id = s.req_id
     WHERE s.host = $1 AND s.model_digest = $2 AND s.ts >= $3 AND s.ts < $4 AND s.z IS NOT NULL
     ORDER BY s.ts, s.req_id`,
    [host, modelDigest, fromTs, toTs],
  )
  return rows.rows.map((r) => ({
    reqId: r.req_id,
    source: r.source,
    refHost: r.ref_host,
    ll: Number(r.ll_mean),
    z: Number(r.z),
    mu: orNull(r.mu),
    sigma: orNull(r.sigma),
    baselineVersion: r.baseline_version,
    bucket: r.bucket,
    ts: Number(r.ts),
    replicaRef: r.replica_ref,
    replicaLl: orNull(r.replica_ll),
    replicaZ: orNull(r.replica_z),
    payer: r.payer ? payerTag(r.payer, host, modelDigest) : null,
  }))
}
