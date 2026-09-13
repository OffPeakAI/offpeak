import { WindowMarketAbi } from "@offpeak/abis"
import { publishedBaseline, scan } from "@offpeak/audit-tests"
import { keccakUtf8, outputHashOf, promptHashOf, weekIndex, type HostChain, type Hex } from "@offpeak/shared"
import type { Address } from "viem"
import { z } from "zod"
import { log } from "../../../services/common/src/log.ts"
import { canaryThreshold, honestCanaryFailRate } from "./canaries.ts"
import type { AuditDeps } from "./deps.ts"
import { buildSwapBundle, loadRunScores, proveSamples, type RunScores } from "./evidence.ts"
import { fileMetering, fileSwap, fileThroughput } from "./file.ts"
import { MAX_SCORE_ATTEMPTS, dueSamples, markScored, noteScoreFailure, openSample } from "./sample.ts"
import { loadBaselines, loadReferences, recordScore, referencesFor, scoreOnReference, standardise, temperatureOf, uncalibratedParam, type Baseline, type ReferenceHost, type ScoreInput } from "./score.ts"

const SERVICE = "auditor"
const WEEK_S = 604_800
const SCORE_BATCH = 200
/** A record this new may not be settled, so a bundle leaves it for the next pass. */
const SETTLE_LAG_S = 7_200
/** After an unconfirmed flag: file nothing, and raise the canary rate for a week. */
const BOOST_S = WEEK_S
/** A second reference host re-reads this many responses per pass, oldest first. */
const REPLICATE_BATCH = 200
/** Past this many failures a pass stops asking, because that reference host is likely down. */
const REPLICATE_FAILURE_LIMIT = 20

const METERING_MIN_FLAGS = 20
const METERING_MIN_HOURS = 6
const METERING_SHARE = 0.05
const METERING_SAMPLE = 400
/** Reasons that point at the host. `over_hold` and `bill_failed` come from the router's own side, and `night_jobs_off` from a job it should not have sent. */
const METERING_REASONS = ["counts", "digest", "sign_refused"]

const WINDOW_FAILURE_SHARE = 0.2
const SAMPLE_S = 60
const THROUGHPUT_LOOKBACK_BLOCKS = 200_000n
const LOG_PAGE = 5_000n

export const weekStartOf = (week: number) => week * WEEK_S + 345_600

async function hostFacts(deps: Pick<AuditDeps, "chain">, cache: Map<string, HostChain | null>, host: string) {
  if (!cache.has(host)) cache.set(host, await deps.chain.host(host))
  return cache.get(host) ?? null
}

type Pending = Omit<ScoreInput, "model"> & { reqId: string; host: string; modelDigest: string; temperature: number; tokensOut: number; ts: number; source: "sample" | "canary" }

type ScorePass = { references: ReferenceHost[]; baselines: Map<string, Baseline>; hosts: Map<string, HostChain | null> }

const modelName = (deps: Pick<AuditDeps, "models">, digest: string) => deps.models.find((row) => row.digest === digest)?.name ?? null

async function scoreOne(deps: AuditDeps, pass: ScorePass, item: Pending) {
  const facts = await hostFacts(deps, pass.hosts, item.host)
  if (!facts) return false
  const gpuClass = facts.gpuClass
  const [reference] = referencesFor(pass.references, { host: item.host, modelDigest: item.modelDigest, gpuClass })
  if (!reference) {
    deps.metrics.inc("auditor_no_reference")
    return false
  }
  const model = modelName(deps, item.modelDigest)
  if (!model) return false
  const ll = await scoreOnReference(deps.fetcher, deps.account as never, reference, { ...item, model })
  await recordScore(deps.db, pass.baselines, { ...item, gpuClass, imageDigest: facts.imageDigest, ll, refHost: reference.host })
  deps.metrics.inc("auditor_scored")
  return true
}

/**
 * One response's turn. A failure stays with that row: it counts an attempt and the pass moves on, so
 * a reference host refusing one prompt cannot cost every other response its score.
 */
async function tryRow(deps: AuditDeps, table: "serving.audit_samples" | "serving.canary_runs", reqId: string, work: () => Promise<boolean>) {
  let finished = false
  try {
    finished = await work()
  } catch (err) {
    log(SERVICE, "score_failed", { reqId, error: err instanceof Error ? err.message : "unknown" })
  }
  if (finished) return true
  if (await noteScoreFailure(deps.db, table, reqId, deps.clock())) {
    deps.metrics.inc("auditor_score_gave_up")
    log(SERVICE, "score_gave_up", { reqId, attempts: MAX_SCORE_ATTEMPTS })
  }
  return false
}

/** A z only means something for parameters calibration covered, and a buyer picks the parameters. */
function scoreable(deps: AuditDeps, reqId: string, body: Record<string, unknown>) {
  const param = uncalibratedParam(body)
  if (param === null) return true
  deps.metrics.inc("auditor_uncalibrated_params")
  log(SERVICE, "score_skipped_uncalibrated", { reqId, param })
  return false
}

/** Scores bodies inside their 72 h. The hashes must match the signed record or the sample is dropped. */
async function scoreSamples(deps: AuditDeps, pass: ScorePass) {
  let done = 0
  for (const row of await dueSamples(deps.db, deps.clock(), SCORE_BATCH)) {
    const finished = await tryRow(deps, "serving.audit_samples", row.req_id, async () => {
      const content = await openSample(deps.db, deps.kek, row)
      const records = await deps.db.query<{ prompt_hash: string; output_hash: string; tokens_out: number }>("SELECT prompt_hash, output_hash, tokens_out FROM shared.usage_records WHERE req_id = $1", [row.req_id])
      const record = records.rows[0]
      if (!content || !record) return false
      const matches = promptHashOf(content.body) === record.prompt_hash && outputHashOf(content.text, content.toolCalls) === record.output_hash
      if (!matches) {
        deps.metrics.inc("auditor_sample_hash_mismatch")
        log(SERVICE, "sample_hash_mismatch", { reqId: row.req_id })
        await markScored(deps.db, row.req_id, deps.clock())
        return true
      }
      if (content.text.length > 0 && scoreable(deps, row.req_id, content.body)) {
        const scored = await scoreOne(deps, pass, {
          reqId: row.req_id,
          host: row.host,
          modelDigest: row.model_digest,
          messages: content.body.messages,
          tools: content.body.tools,
          output: content.text,
          temperature: temperatureOf(content.body),
          tokensOut: record.tokens_out,
          ts: Number(row.ts),
          source: "sample",
        })
        if (!scored) return false
      }
      await markScored(deps.db, row.req_id, deps.clock())
      return true
    })
    if (finished) done++
  }
  return done
}

type CanaryRow = { req_id: string; host: string; model_digest: string; body: Record<string, unknown>; output: string; tokens_out: number; ts: string }

async function scoreCanaries(deps: AuditDeps, pass: ScorePass) {
  const now = deps.clock()
  const rows = await deps.db.query<CanaryRow>("SELECT req_id, host, model_digest, body, output, tokens_out, ts FROM serving.canary_runs WHERE scored_at IS NULL AND req_id IS NOT NULL AND score_attempts < $2 AND retry_at <= $3 ORDER BY score_attempts, ts LIMIT $1", [SCORE_BATCH, MAX_SCORE_ATTEMPTS, now])
  let done = 0
  for (const row of rows.rows) {
    const finished = await tryRow(deps, "serving.canary_runs", row.req_id, async () => {
      if (row.output.length > 0 && scoreable(deps, row.req_id, row.body)) {
        const scored = await scoreOne(deps, pass, {
          reqId: row.req_id,
          host: row.host,
          modelDigest: row.model_digest,
          messages: row.body.messages,
          tools: row.body.tools,
          output: row.output,
          temperature: temperatureOf(row.body),
          tokensOut: row.tokens_out,
          ts: Number(row.ts),
          source: "canary",
        })
        if (!scored) return false
      }
      await deps.db.query("UPDATE serving.canary_runs SET scored_at = to_timestamp($2) WHERE req_id = $1", [row.req_id, deps.clock()])
      return true
    })
    if (finished) done++
  }
  return done
}
