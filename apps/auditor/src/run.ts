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
/** A share of a few demanded minutes says nothing about a host, and one holder can make those. */
const WINDOW_MIN_MEASURED_S = 600
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

const challengeList = z.object({ data: z.array(z.object({ id: z.union([z.string(), z.number()]), state: z.string(), outcome: z.union([z.string(), z.number()]).nullable(), slash_bps: z.union([z.string(), z.number()]).nullable() })) })

/** Records how filed challenges ended, which feeds the live false-flag proxy. */
export async function syncOutcomes(deps: Pick<AuditDeps, "db" | "fetcher" | "indexerUrl" | "internalToken">) {
  const res = await deps.fetcher(`${deps.indexerUrl}/idx/v1/challenges`, { headers: { authorization: `Bearer ${deps.internalToken}` } })
  if (!res.ok) return 0
  let updated = 0
  for (const row of challengeList.parse(await res.json()).data) {
    if (row.state !== "finalized") continue
    const outcome = Number(row.slash_bps ?? 0) > 0 ? "upheld" : "cleared"
    const done = await deps.db.query("UPDATE serving.audit_filings SET outcome = $2 WHERE challenge_id = $1 AND outcome IS NULL RETURNING id", [String(row.id), outcome])
    updated += done.rows.length
  }
  return updated
}

type FlagRow = { req_id: string; reason: string; router_counts: unknown; host_counts: unknown; hour: string | null; model_digest: string | null }

const shuffled = <T>(items: readonly T[], seed: string) => [...items].map((item, i) => ({ item, key: keccakUtf8(`${seed}:${i}`) })).sort((a, b) => (a.key < b.key ? -1 : 1)).map((row) => row.item)

/**
 * Sustained count disagreements on one host. The bundle is a random draw of the host's records,
 * not a pick of the flagged ones, so its share reads as the host's own. A refused signature leaves
 * no record, so it cannot be proven against a root; those raise an alert for a person instead.
 */
export async function runMetering(deps: AuditDeps, week = weekIndex(deps.clock()) - 1) {
  const start = weekStartOf(week)
  const hosts = await deps.db.query<{ host: string }>("SELECT DISTINCT host FROM serving.metering_flags WHERE created_at >= to_timestamp($1) AND created_at < to_timestamp($2)", [start, start + WEEK_S])
  const results: { host: string; result: string }[] = []
  for (const { host } of hosts.rows) {
    const flags = await deps.db.query<FlagRow>(
      `SELECT f.req_id, f.reason, f.router_counts, f.host_counts, u.hour, u.model_digest
       FROM serving.metering_flags f LEFT JOIN shared.usage_records u ON u.req_id = f.req_id
       WHERE f.host = $1 AND f.reason = ANY($2::text[]) AND f.created_at >= to_timestamp($3) AND f.created_at < to_timestamp($4)`,
      [host, METERING_REASONS, start, start + WEEK_S],
    )
    const provable = flags.rows.filter((flag) => flag.hour !== null)
    const unprovable = flags.rows.length - provable.length
    if (unprovable >= METERING_MIN_FLAGS) {
      deps.metrics.inc("auditor_metering_unprovable", unprovable)
      log(SERVICE, "metering_unprovable", { host, week, flags: unprovable })
    }
    for (const modelDigest of new Set(provable.map((flag) => flag.model_digest!))) {
      const forModel = provable.filter((flag) => flag.model_digest === modelDigest)
      const records = await deps.db.query<{ req_id: string }>("SELECT req_id FROM shared.usage_records WHERE host = $1 AND model_digest = $2 AND ts >= $3 AND ts < $4 AND status = 'final' ORDER BY req_id", [host, modelDigest, start, start + WEEK_S])
      const share = forModel.length / Math.max(1, records.rows.length)
      const sustained = forModel.length >= METERING_MIN_FLAGS && new Set(forModel.map((flag) => flag.hour)).size >= METERING_MIN_HOURS && share >= METERING_SHARE
      if (!sustained) continue
      const drawn = shuffled(records.rows.map((row) => row.req_id), `${host}:${modelDigest}:${week}`).slice(0, METERING_SAMPLE)
      const proved = await proveSamples(deps, drawn)
      const flagged = new Set(forModel.map((flag) => flag.req_id))
      const samples = [...proved.values()].map((row) => ({ ...row, z: 0, canaryFail: false, refAgrees: false, meteringFlag: flagged.has(row.reqId) }))
      const bundle = {
        v: 1 as const,
        host: host as Hex,
        modelDigest: modelDigest as Hex,
        testId: "metering-v1",
        testVersion: "1",
        baseline: { ...publishedBaseline(modelDigest) },
        samples,
        attachments: { flags: forModel.filter((flag) => proved.has(flag.req_id)).map((flag) => ({ reqId: flag.req_id, reason: flag.reason, routerCounts: flag.router_counts, hostCounts: flag.host_counts })), records: records.rows.length, refusedSignatures: unprovable },
      }
      const result = await fileMetering(deps, bundle, week)
      results.push({ host, result: result.filed ? "filed" : result.reason })
    }
  }
  return results
}

/**
 * Throughput filings answer a host's dispute of a performance post, and only when the auditor's own
 * measure agrees the Window failed. Off by default: rulings dismiss every throughput challenge until
 * their Windows branch exists, and each dismissal costs half a bond.
 */
export async function runThroughput(deps: AuditDeps) {
  if (!deps.fileThroughput || !deps.contracts.WindowMarket) return []
  const market = deps.contracts.WindowMarket as Address
  const head = await deps.reader.getBlockNumber()
  const results: { windowId: string; result: string }[] = []
  for (let from = head > THROUGHPUT_LOOKBACK_BLOCKS ? head - THROUGHPUT_LOOKBACK_BLOCKS : 0n; from <= head; from += LOG_PAGE) {
    const to = from + LOG_PAGE - 1n > head ? head : from + LOG_PAGE - 1n
    const disputes = await deps.reader.getContractEvents({ address: market, abi: WindowMarketAbi, eventName: "PerformanceDisputed", fromBlock: from, toBlock: to })
    for (const dispute of disputes) {
      const id = (dispute.args as { id: bigint }).id
      const view = await deps.reader.readContract({ address: market, abi: WindowMarketAbi, functionName: "windowView", args: [id] })
      const perf = await deps.db.query<{ below: string; measured: string }>(
        "SELECT count(*) FILTER (WHERE demanded AND tokens_per_s < $2) AS below, count(*) FILTER (WHERE demanded) AS measured FROM shared.window_perf WHERE window_id = $1",
        [id.toString(), view.minTps],
      )
      const belowSeconds = Number(perf.rows[0]!.below) * SAMPLE_S
      const measuredSeconds = Number(perf.rows[0]!.measured) * SAMPLE_S
      const thresholdSeconds = WINDOW_FAILURE_SHARE * measuredSeconds
      if (measuredSeconds < WINDOW_MIN_MEASURED_S || belowSeconds <= thresholdSeconds) continue
      const draws = await deps.db.query<{ req_id: string }>("SELECT req_id FROM shared.usage_records WHERE window_id = $1 AND status = 'final' ORDER BY req_id", [id.toString()])
      const proved = await proveSamples(deps, draws.rows.map((row) => row.req_id))
      const bundle = {
        v: 1 as const,
        host: view.host.toLowerCase() as Hex,
        modelDigest: view.modelDigest,
        testId: "window-throughput-v1",
        testVersion: "1",
        baseline: { ...publishedBaseline(view.modelDigest) },
        samples: [...proved.values()].map((row) => ({ ...row, z: 0, canaryFail: false, refAgrees: false, meteringFlag: false })),
        attachments: { windowId: id.toString(), minTps: Number(view.minTps), belowSeconds, measuredSeconds },
      }
      const result = await fileThroughput(deps, bundle, weekIndex(Number(view.t1)), { belowSeconds, thresholdSeconds })
      results.push({ windowId: id.toString(), result: result.filed ? "filed" : result.reason })
    }
  }
  return results
}

/** A model, GPU class or image with no baseline scores nothing until calibration covers it. */
export async function uncalibratedHosts(deps: Pick<AuditDeps, "db" | "chain" | "metrics">) {
  const baselines = await loadBaselines(deps.db)
  const covered = new Set([...baselines.values()].map((b) => [b.modelDigest, b.gpuClass, b.imageDigest].join("|")))
  const missing = new Set<string>()
  for (const host of await deps.chain.hostList()) {
    for (const model of host.models) {
      const key = [model.digest, host.gpuClass, host.imageDigest].join("|")
      if (!covered.has(key)) missing.add(key)
    }
  }
  deps.metrics.set("auditor_uncalibrated_combinations", missing.size)
  if (missing.size > 0) log(SERVICE, "calibration_needed", { combinations: [...missing] })
  return [...missing]
}

