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

export async function scorePending(deps: AuditDeps) {
  const pass: ScorePass = { references: await loadReferences(deps.db), baselines: await loadBaselines(deps.db), hosts: new Map() }
  return { samples: await scoreSamples(deps, pass), canaries: await scoreCanaries(deps, pass) }
}

type RunRow = { host: string; model_digest: string; week: number; stopped_ts: string; boost_until: string; state: string }

/** Reads each host-model's week in arrival order. A crossing stays recorded once it happens. */
export async function runSequential(deps: AuditDeps) {
  const now = deps.clock()
  const week = weekIndex(now)
  const start = weekStartOf(week)
  const pairs = await deps.db.query<{ host: string; model_digest: string }>("SELECT DISTINCT host, model_digest FROM serving.audit_scores WHERE ts >= $1 AND z IS NOT NULL", [start])
  let flagged = 0
  for (const { host, model_digest: modelDigest } of pairs.rows) {
    const scores = await loadRunScores(deps.db, host, modelDigest, start, start + WEEK_S)
    const baseline = publishedBaseline(modelDigest)
    const read = scan(scores, baseline)
    await deps.db.query(
      `INSERT INTO serving.audit_runs (host, model_digest, week, n, llr, threshold, flagged, stopped_at, stopped_ts, boost_until, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (host, model_digest, week) DO UPDATE SET n = EXCLUDED.n,
         llr = CASE WHEN serving.audit_runs.flagged THEN serving.audit_runs.llr ELSE EXCLUDED.llr END,
         threshold = EXCLUDED.threshold,
         flagged = serving.audit_runs.flagged OR EXCLUDED.flagged,
         stopped_at = COALESCE(serving.audit_runs.stopped_at, EXCLUDED.stopped_at),
         stopped_ts = COALESCE(serving.audit_runs.stopped_ts, EXCLUDED.stopped_ts),
         boost_until = COALESCE(serving.audit_runs.boost_until, EXCLUDED.boost_until),
         state = CASE WHEN serving.audit_runs.state = 'open' THEN EXCLUDED.state ELSE serving.audit_runs.state END`,
      [host, modelDigest, week, scores.length, read.statistic, read.threshold, read.flagged, read.flagged ? read.n : null, read.flagged ? scores[read.n - 1]!.ts : null, read.flagged ? now + BOOST_S : null, read.flagged ? "flagged" : "open"],
    )
    if (read.flagged) {
      flagged++
      deps.metrics.inc("auditor_flags")
      log(SERVICE, "sequential_flag", { host, modelDigest, week, n: read.n, statistic: read.statistic })
    }
  }
  return { pairs: pairs.rows.length, flagged }
}

/** A second reference host scores responses after the crossing, so it reads data the flag never saw. */
async function replicate(deps: AuditDeps, run: RunRow, fresh: readonly RunScores[], primary: string) {
  const facts = await deps.chain.host(run.host)
  if (!facts) return
  const second = referencesFor(await loadReferences(deps.db), { host: run.host, modelDigest: run.model_digest, gpuClass: facts.gpuClass }).find((reference) => reference.host !== primary)
  if (!second) {
    deps.metrics.inc("auditor_no_second_reference")
    return
  }
  const baselines = await loadBaselines(deps.db, run.model_digest)
  let done = 0
  let failed = 0
  for (const row of fresh.filter((score) => score.replicaZ === null)) {
    if (done >= REPLICATE_BATCH || failed >= REPLICATE_FAILURE_LIMIT) return
    try {
      const input = await bodyFor(deps, row)
      // The baseline behind the first score, so a refit in between cannot split the pair.
      const baseline = row.mu !== null && row.sigma !== null ? { mu: row.mu, sigma: row.sigma } : baselines.get(row.bucket)
      const model = modelName(deps, run.model_digest)
      if (!input || !baseline || !model) continue
      const ll = await scoreOnReference(deps.fetcher, deps.account as never, second, { ...input, model })
      await deps.db.query("INSERT INTO serving.audit_replications (req_id, ref_host, ll_mean, z) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [row.reqId, second.host, ll, standardise(ll, baseline)])
      done++
    } catch (err) {
      failed++
      log(SERVICE, "replicate_failed", { reqId: row.reqId, error: err instanceof Error ? err.message : "unknown" })
    }
  }
}

async function bodyFor(deps: AuditDeps, row: RunScores): Promise<Omit<ScoreInput, "model"> | null> {
  if (row.source === "canary") {
    const rows = await deps.db.query<{ body: Record<string, unknown>; output: string }>("SELECT body, output FROM serving.canary_runs WHERE req_id = $1", [row.reqId])
    const found = rows.rows[0]
    return found ? { messages: found.body.messages, tools: found.body.tools, output: found.output } : null
  }
  const samples = await deps.db.query<{ req_id: string; host: string; model_digest: string; enc_body: string; day_key_id: string; ts: string }>("SELECT req_id, host, model_digest, enc_body, day_key_id, ts FROM serving.audit_samples WHERE req_id = $1", [row.reqId])
  const sample = samples.rows[0]
  const content = sample ? await openSample(deps.db, deps.kek, sample) : null
  return content ? { messages: content.body.messages, tools: content.body.tools, output: content.text } : null
}

async function deterministicFails(deps: Pick<AuditDeps, "db">, reqIds: readonly string[]) {
  const rows = await deps.db.query<{ req_id: string; passed: boolean }>("SELECT req_id, passed FROM serving.canary_runs WHERE deterministic AND req_id = ANY($1::text[])", [reqIds])
  return { judged: rows.rows.length, fails: new Set(rows.rows.filter((row) => !row.passed).map((row) => row.req_id)) }
}

async function openSwapChallenge(deps: Pick<AuditDeps, "db">, run: RunRow) {
  const rows = await deps.db.query("SELECT 1 FROM serving.audit_filings WHERE host = $1 AND model_digest = $2 AND kind = 0 AND outcome IS NULL AND status <> 'failed' LIMIT 1", [run.host, run.model_digest])
  return rows.rows.length > 0
}

/**
 * Takes a flagged run towards a filing. It needs more data than the flag: fresh responses replicated
 * on a second reference host, or canary failures past their threshold. If neither arrives while the
 * canary rate is up, the run closes and nothing is filed.
 */
export async function advanceFlagged(deps: AuditDeps) {
  const now = deps.clock()
  const runs = await deps.db.query<RunRow>("SELECT host, model_digest, week, stopped_ts, boost_until, state FROM serving.audit_runs WHERE state = 'flagged' ORDER BY week")
  const outcomes: { host: string; result: string }[] = []
  for (const run of runs.rows) {
    try {
      const result = await advanceRun(deps, run, now)
      if (result) outcomes.push({ host: run.host, result })
    } catch (err) {
      deps.metrics.inc("auditor_filing_errors")
      log(SERVICE, "advance_failed", { host: run.host, modelDigest: run.model_digest, week: run.week, error: err instanceof Error ? err.message : "unknown" })
    }
  }
  return outcomes
}

async function advanceRun(deps: AuditDeps, run: RunRow, now: number) {
  if (Number(run.boost_until) <= now) {
    await deps.db.query("UPDATE serving.audit_runs SET state = 'cleared' WHERE host = $1 AND model_digest = $2 AND week = $3", [run.host, run.model_digest, run.week])
    log(SERVICE, "flag_closed_unconfirmed", { host: run.host, modelDigest: run.model_digest, week: run.week })
    return "no_second_signal"
  }
  if (await openSwapChallenge(deps, run)) return null
  if (Number(run.stopped_ts) > now - SETTLE_LAG_S) return null
  // Split by time: a score landing late cannot move a response the flag read into the fresh side.
  const seen = (rows: readonly RunScores[]) => rows.filter((row) => row.ts <= Number(run.stopped_ts))
  const unseen = (rows: readonly RunScores[]) => rows.filter((row) => row.ts > Number(run.stopped_ts))
  const window = await loadRunScores(deps.db, run.host, run.model_digest, weekStartOf(run.week), now - SETTLE_LAG_S)
  await replicate(deps, run, unseen(window), seen(window)[0]!.refHost)
  const scored = await loadRunScores(deps.db, run.host, run.model_digest, weekStartOf(run.week), now - SETTLE_LAG_S)
  const reqIds = scored.map((row) => row.reqId)
  const { judged, fails } = await deterministicFails(deps, reqIds)
  const threshold = judged > 0 ? canaryThreshold(judged, await honestCanaryFailRate(deps, run.model_digest)) : 0
  const { bundle } = await buildSwapBundle(deps, {
    host: run.host as Hex,
    modelDigest: run.model_digest as Hex,
    first: seen(scored),
    fresh: unseen(scored),
    canaryFails: fails,
    canaryThreshold: threshold,
  })
  const result = await fileSwap(deps, bundle, run.week)
  if (result.filed) {
    await deps.db.query("UPDATE serving.audit_runs SET state = 'filed', filed_challenge_id = $4 WHERE host = $1 AND model_digest = $2 AND week = $3", [run.host, run.model_digest, run.week, result.challengeId])
  }
  return result.filed ? "filed" : result.reason
}
