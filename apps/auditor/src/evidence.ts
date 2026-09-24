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

type Proved = Pick<EvidenceSample, "reqId" | "hour" | "leaf" | "proof">

/** Merkle proofs against posted roots. A record not settled yet has none, and stays out for now. */
export async function proveSamples(deps: Pick<AuditDeps, "chain">, reqIds: readonly string[]) {
  const proved = new Map<string, Proved>()
  for (const reqId of reqIds) {
    const proof = await deps.chain.proof(reqId)
    if (proof) proved.set(reqId, { reqId: reqId as Hex, hour: proof.hour, leaf: proof.leaf as Hex, proof: proof.proof as Hex[] })
  }
  return proved
}

async function canaryDetails(db: Db, reqIds: readonly string[]) {
  const rows = await db.query<{ req_id: string; prompt_id: string; deterministic: boolean; body: unknown; output: string; expected: string[] }>(
    "SELECT req_id, prompt_id, deterministic, body, output, expected FROM serving.canary_runs WHERE req_id = ANY($1::text[]) ORDER BY req_id",
    [reqIds],
  )
  return rows.rows.map((r): CanaryDetail => ({ reqId: r.req_id, promptId: r.prompt_id, deterministic: r.deterministic, body: r.body, output: r.output, accepted: r.expected }))
}

/**
 * Buyer samples go in as hashes. A body is reachable only while its 72 h last: bundles never copy
 * one, so a challenge cannot stretch the retention promise.
 */
async function buyerDetails(db: Db, reqIds: readonly string[]) {
  const rows = await db.query<{ req_id: string; prompt_hash: string; output_hash: string; held: boolean }>(
    `SELECT u.req_id, u.prompt_hash, u.output_hash, EXISTS (SELECT 1 FROM serving.audit_samples a WHERE a.req_id = u.req_id) AS held
     FROM shared.usage_records u WHERE u.req_id = ANY($1::text[]) ORDER BY u.req_id`,
    [reqIds],
  )
  return rows.rows.map((r): BuyerDetail => ({ reqId: r.req_id, promptHash: r.prompt_hash, outputHash: r.output_hash, encryptedBodyHeld: r.held }))
}

export type SwapCase = {
  host: Hex
  modelDigest: Hex
  /** Responses up to the crossing. */
  first: RunScores[]
  /** Later responses, every one also scored by a second reference host. */
  fresh: RunScores[]
  /** Deterministic canary results over both spans. */
  canaryFails: ReadonlySet<string>
  canaryThreshold: number
}

/**
 * Builds the bundle a ruling recomputes. `z` is always the primary reference host's score. The
 * replication sits in the attachments, and `refAgrees` marks only responses it actually covers.
 */
export async function buildSwapBundle(deps: Pick<AuditDeps, "db" | "chain">, swap: SwapCase): Promise<{ bundle: AuditBundle; missing: number }> {
  const all = [...swap.first, ...swap.fresh]
  const proved = await proveSamples(deps, all.map((row) => row.reqId))
  const kept = (rows: readonly RunScores[]) => rows.filter((row) => proved.has(row.reqId))
  const first = kept(swap.first)
  const fresh = kept(swap.fresh)
  const scores = [...first, ...fresh]
  const primaryRef = swap.first[0]?.refHost ?? ""
  const replicaRef = fresh.find((row) => row.replicaRef !== null)?.replicaRef ?? null
  const replicated = fresh.filter((row) => row.replicaRef === replicaRef && row.replicaZ !== null)
  const replication = replicaRef && replicated.length > 0 ? { primaryRef, refHost: replicaRef, reqIds: replicated.map((r) => r.reqId), zs: replicated.map((r) => r.replicaZ!) } : null
  const baseline = publishedBaseline(swap.modelDigest)
  const signalled = replication && score(replicated.map((r) => ({ z: r.replicaZ!, payer: r.payer })), baseline).flagged ? new Set(replication.reqIds) : new Set<string>()
  const samples: EvidenceSample[] = scores.map((row) => ({
    ...proved.get(row.reqId)!,
    z: row.z,
    payer: row.payer,
    canaryFail: swap.canaryFails.has(row.reqId),
    refAgrees: signalled.has(row.reqId),
    meteringFlag: false,
  }))
  const reqIds = scores.map((row) => row.reqId)
  const bundle: AuditBundle = {
    v: 1,
    host: swap.host,
    modelDigest: swap.modelDigest,
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    baseline: { ...baseline },
    samples,
    attachments: {
      firstRun: first.length,
      scores: scores.map(({ ts: _ts, payer: _payer, ...row }) => row),
      canaries: await canaryDetails(deps.db, reqIds),
      buyerSamples: await buyerDetails(deps.db, scores.filter((row) => row.source === "sample").map((row) => row.reqId)),
      replication,
      canaryThreshold: swap.canaryThreshold,
    },
  }
  return { bundle, missing: all.length - scores.length }
}

/** Stored by content, in the table ruling processes read. */
export async function storeBundle(db: Db, bundle: EvidenceBundle) {
  const root = evidenceRoot(bundle)
  await db.query("INSERT INTO shared.evidence_bundles (samples_root, body) VALUES ($1,$2::jsonb) ON CONFLICT (samples_root) DO NOTHING", [root, JSON.stringify(bundle)])
  return root
}
