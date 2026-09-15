import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { PAYER_SAMPLE_QUOTA, publishedBaseline } from "@offpeak/audit-tests"
import { hourOfWeek, keccakUtf8, weekIndex, type ChatMessage, type Hex } from "@offpeak/shared"
import { z } from "zod"
import type { Corpus, CorpusEntry } from "./corpus.ts"
import type { AuditDeps } from "./deps.ts"
import type { TrafficShape } from "./sample.ts"

/** About 0.5% of each host's requests, 5x that for a week after an unconfirmed flag. */
export const CANARY_SHARE = 0.005
export const CANARY_BOOST = 5
export const MIN_AUDITED_PER_WEEK = 200
/** Share of canaries that are deterministic prompts at temperature 0. */
const DETERMINISTIC_SHARE = 0.2
/** A deterministic answer must end on its own inside this, so a longer limit cannot change it. */
const ANSWER_LIMIT = 64
const WEEK_S = 604_800
const HOUR_S = 3_600
/** Settling takes up to two hours, and the job reading the result runs every 15 minutes. */
const FRESH_LEAD_S = 3 * HOUR_S
const FRESH_MARGIN = 1.1

export type Rng = () => number

export type CanaryAccount = {
  wallet: Hex
  label: string
  apiKey: string
  openedAt: number
  /** UTC hours the account is active in, so accounts keep their own daily rhythm. */
  activeFrom: number
  activeTo: number
  weight: number
  dailyLimit: number
}

const accountSchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  label: z.string().min(1),
  apiKey: z.string().regex(/^op_live_/),
  openedAt: z.number().int().nonnegative(),
  activeFrom: z.number().int().min(0).max(23),
  activeTo: z.number().int().min(0).max(23),
  weight: z.number().positive(),
  dailyLimit: z.number().int().positive(),
})

/** Keys for auditor-funded wallets stay in an operator-held file, never in the database. */
export function loadAccounts(path: string): CanaryAccount[] {
  return z.array(accountSchema).min(1).parse(JSON.parse(readFileSync(path, "utf8"))) as CanaryAccount[]
}

export async function syncAccounts(deps: Pick<AuditDeps, "db">, accounts: readonly CanaryAccount[]) {
  for (const account of accounts) {
    await deps.db.query(
      "INSERT INTO serving.canary_accounts (wallet, label, opened_at) VALUES ($1,$2,$3) ON CONFLICT (wallet) DO UPDATE SET label = EXCLUDED.label",
      [account.wallet, account.label, account.openedAt],
    )
  }
}

const pick = <T>(items: readonly T[], rng: Rng) => items[Math.floor(rng() * items.length)]!

function fill(entry: CorpusEntry, rng: Rng) {
  return entry.template.replace(/\{(\w+)\}/g, (_match, name: string) => pick(entry.vars[name] ?? [""], rng))
}

function framing(corpus: Corpus, shape: Pick<TrafficShape, "system" | "turns">, rng: Rng): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (shape.system) messages.push({ role: "system", content: pick(corpus.systems, rng) })
  for (let turn = 1; turn < shape.turns; turn++) {
    const [user, assistant] = pick(corpus.history, rng)
    messages.push({ role: "user", content: user }, { role: "assistant", content: assistant })
  }
  return messages
}

export type CanaryRequest = { promptId: string; deterministic: boolean; accepted: string[]; body: Record<string, unknown> }

const DEFAULT_SHAPE: TrafficShape = { temperature: 0.7, topP: null, maxTokens: 512, tools: 0, stream: false, system: false, turns: 1, format: null, seed: false, stop: false }

/** Only what the shape carries goes in, because a parameter's absence is as visible as its value. */
function paramsFrom(corpus: Corpus, shape: TrafficShape, rng: Rng) {
  const params: Record<string, unknown> = {}
  if (shape.temperature !== null) params.temperature = shape.temperature
  if (shape.topP !== null) params.top_p = shape.topP
  if (shape.maxTokens !== null) params.max_tokens = Math.max(1, Math.ceil(shape.maxTokens * (0.55 + 0.45 * rng())))
  if (shape.stream) params.stream = true
  if (shape.tools > 0) params.tools = corpus.tools.slice(0, shape.tools)
  if (shape.format) params.response_format = { type: shape.format }
  if (shape.seed) params.seed = Math.floor(rng() * 2 ** 31)
  if (shape.stop) params.stop = ["\n\n\n"]
  return params
}

/** An ordinary request: a corpus prompt inside parameters drawn from live traffic. */
export function openCanary(corpus: Corpus, modelName: string, shape: TrafficShape, rng: Rng): CanaryRequest {
  const entry = pick(corpus.open, rng)
  const content = `${pick(corpus.leads, rng)}${fill(entry, rng)}${pick(corpus.tails, rng)}`
  const messages = [...framing(corpus, shape, rng), { role: "user", content }]
  const body = { model: modelName, messages, ...paramsFrom(corpus, shape, rng) }
  return { promptId: `${entry.id}:${keccakUtf8(content).slice(2, 14)}`, deterministic: false, accepted: [], body }
}

/** Every deterministic prompt the corpus can make, framed once so its answer set stays valid. */
export function deterministicPool(corpus: Corpus, rng: Rng, perEntry = 6) {
  const pool: { promptId: string; messages: ChatMessage[] }[] = []
  for (const entry of corpus.deterministic) {
    for (let i = 0; i < perEntry; i++) {
      const content = fill(entry, rng)
      const messages: ChatMessage[] = [...framing(corpus, { system: rng() < 0.5, turns: 1 + Math.floor(rng() * 2) }, rng), { role: "user", content }]
      pool.push({ promptId: `${entry.id}:${keccakUtf8(JSON.stringify(messages)).slice(2, 14)}`, messages })
    }
  }
  return [...new Map(pool.map((row) => [row.promptId, row])).values()]
}

/** A prompt from the answer-set pool at temperature 0, its other parameters drawn from live traffic. */
export function deterministicCanary(corpus: Corpus, modelName: string, expected: { promptId: string; messages: unknown; accepted: string[] }, shape: TrafficShape, rng: Rng): CanaryRequest {
  const params = paramsFrom(corpus, shape, rng)
  const body: Record<string, unknown> = { model: modelName, messages: expected.messages, ...params, temperature: 0 }
  if (params.max_tokens !== undefined) body.max_tokens = Math.max(Number(params.max_tokens), ANSWER_LIMIT)
  delete body.tools
  delete body.response_format
  delete body.stop
  return { promptId: expected.promptId, deterministic: true, accepted: expected.accepted, body }
}

export function drawShape(rows: readonly { shape: string; n: number }[], rng: Rng): TrafficShape {
  const total = rows.reduce((sum, row) => sum + row.n, 0)
  if (total === 0) return DEFAULT_SHAPE
  let left = rng() * total
  for (const row of rows) {
    left -= row.n
    if (left < 0) return JSON.parse(row.shape) as TrafficShape
  }
  return JSON.parse(rows[rows.length - 1]!.shape) as TrafficShape
}

export type RateInput = {
  /** Real requests expected this hour, from the same hour of the week before. */
  hourlyRequests: number
  /** This hour's share of the traffic still to come in the audit period. */
  shareOfRemaining: number
  audited: number
  /** Audited responses expected anyway before the period ends. */
  projected: number
  probation: boolean
  boosted: boolean
  /** After a flag: fresh scores still needed, and this hour's share of what is left of the boost. */
  freshShortfall?: number
  shareOfBoost?: number
}

/**
 * Expected canaries this hour. Probation hosts carry no real traffic, so they get whatever reaches
 * the weekly minimum. A quiet host gets its shortfall on top of the base rate. A flagged host needs
 * enough scores after the crossing to replicate, and a multiple of near-zero traffic never gets there.
 */
export function canaryRate(input: RateInput) {
  const base = input.probation ? 0 : CANARY_SHARE * input.hourlyRequests * (input.boosted ? CANARY_BOOST : 1)
  const shortfall = Math.max(0, MIN_AUDITED_PER_WEEK - input.audited - input.projected)
  return base + Math.max(shortfall * input.shareOfRemaining, (input.freshShortfall ?? 0) * (input.shareOfBoost ?? 0))
}

/** Poisson arrivals: no schedule to read, only a rate matching the host's own traffic. */
export function arrivals(rate: number, rng: Rng, windowS = HOUR_S) {
  const out: number[] = []
  let at = 0
  for (;;) {
    at += (-Math.log(1 - rng()) / rate) * windowS
    if (!Number.isFinite(at) || at >= windowS) return out
    out.push(Math.floor(at))
  }
}

export type CanaryPlan = { host: string; modelDigest: string; delayS: number }

async function hourlyTraffic(deps: Pick<AuditDeps, "db">, host: string, modelDigest: string, now: number) {
  const since = now - 2 * WEEK_S
  const rows = await deps.db.query<{ hour: string; n: string }>(
    `SELECT hour, count(*) AS n FROM shared.usage_records u
     WHERE host = $1 AND model_digest = $2 AND ts >= $3 AND status = 'final'
       AND NOT EXISTS (SELECT 1 FROM serving.canary_runs c WHERE c.req_id = u.req_id)
     GROUP BY hour`,
    [host, modelDigest, since],
  )
  const perHourOfWeek = new Array<number>(168).fill(0)
  for (const row of rows.rows) perHourOfWeek[hourOfWeek(Number(row.hour) * HOUR_S)]! += Number(row.n) / 2
  return perHourOfWeek
}

function shareOf(traffic: readonly number[], now: number, end: number) {
  const hours: number[] = []
  for (let at = now; at < end; at += HOUR_S) hours.push(hourOfWeek(at))
  if (hours.length === 0) return 1
  const total = hours.reduce((sum, how) => sum + traffic[how]!, 0)
  return total > 0 ? traffic[hours[0]!]! / total : 1 / hours.length
}

/**
 * Scores the test can read: a score with no z yet counts for nothing. One buyer's samples count up to
 * their quota, because the per-payer cap stops the rest moving the statistic.
 */
async function auditedThisWeek(deps: Pick<AuditDeps, "db">, host: string, modelDigest: string, weekStart: number) {
  const rows = await deps.db.query<{ n: string }>(
    `SELECT COALESCE(SUM(LEAST(g.n, CASE WHEN g.payer IS NULL THEN g.n ELSE $4 END)), 0) AS n FROM (
       SELECT u.payer, count(*) AS n FROM serving.audit_scores s
       LEFT JOIN shared.usage_records u ON s.source = 'sample' AND u.req_id = s.req_id
       WHERE s.host = $1 AND s.model_digest = $2 AND s.ts >= $3 AND s.z IS NOT NULL
       GROUP BY u.payer
     ) g`,
    [host, modelDigest, weekStart, PAYER_SAMPLE_QUOTA],
  )
  return Number(rows.rows[0]!.n)
}

type Boost = { stoppedTs: number; until: number }

/** The newest run still flagged and waiting on a second signal, if the host has one. */
async function openFlag(deps: Pick<AuditDeps, "db">, host: string, modelDigest: string, now: number): Promise<Boost | null> {
  const rows = await deps.db.query<{ stopped_ts: string; boost_until: string }>("SELECT stopped_ts, boost_until FROM serving.audit_runs WHERE host = $1 AND model_digest = $2 AND state = 'flagged' AND boost_until > $3 ORDER BY week DESC LIMIT 1", [host, modelDigest, now])
  const row = rows.rows[0]
  return row ? { stoppedTs: Number(row.stopped_ts), until: Number(row.boost_until) } : null
}

async function boosted(deps: Pick<AuditDeps, "db">, host: string, modelDigest: string, now: number) {
  const rows = await deps.db.query("SELECT 1 FROM serving.audit_runs WHERE host = $1 AND model_digest = $2 AND boost_until > $3 LIMIT 1", [host, modelDigest, now])
  return rows.rows.length > 0
}

/** Scores after the crossing, which are what a second reference host replicates. */
async function freshScores(deps: Pick<AuditDeps, "db">, host: string, modelDigest: string, stoppedTs: number) {
  const rows = await deps.db.query<{ n: string }>("SELECT count(*) AS n FROM serving.audit_scores WHERE host = $1 AND model_digest = $2 AND ts > $3 AND z IS NOT NULL", [host, modelDigest, stoppedTs])
  return Number(rows.rows[0]!.n)
}

const HOST_PROBATION = 1
const HOST_ACTIVE = 2

/** One hour's canaries for every host and model, spread as Poisson arrivals across the hour. */
export async function planCanaries(deps: Pick<AuditDeps, "db" | "chain" | "rng" | "corpus">, now: number): Promise<CanaryPlan[]> {
  if (!deps.corpus) return []
  const weekStart = weekIndex(now) * WEEK_S + 345_600
  const weekEnd = weekStart + WEEK_S
  const plans: CanaryPlan[] = []
  for (const host of await deps.chain.hostList()) {
    if (host.status !== HOST_ACTIVE && host.status !== HOST_PROBATION) continue
    const probation = host.status === HOST_PROBATION
    const address = host.operator.toLowerCase()
    for (const model of host.models) {
      const traffic = await hourlyTraffic(deps, address, model.digest, now)
      const end = probation ? Math.min(Number(host.probationEnds), weekEnd) : weekEnd
      const flag = await openFlag(deps, address, model.digest, now)
      const rate = canaryRate({
        hourlyRequests: traffic[hourOfWeek(now)]!,
        shareOfRemaining: shareOf(traffic, now, Math.max(end, now + HOUR_S)),
        audited: await auditedThisWeek(deps, address, model.digest, weekStart),
        projected: probation ? 0 : expectedAudited(traffic, now, weekEnd),
        probation,
        boosted: await boosted(deps, address, model.digest, now),
        ...(flag ? boostNeeds(traffic, now, flag, publishedBaseline(model.digest).minN, await freshScores(deps, address, model.digest, flag.stoppedTs)) : {}),
      })
      for (const delayS of arrivals(rate, deps.rng)) plans.push({ host: address, modelDigest: model.digest, delayS })
    }
  }
  return plans
}

/**
 * A replication reads only settled, freshly scored responses, so the last ones must land well before
 * the boost ends. The target sits above minN because Poisson arrivals and failed scores fall short.
 */
function boostNeeds(traffic: readonly number[], now: number, flag: Boost, minN: number, fresh: number) {
  const end = Math.max(flag.until - FRESH_LEAD_S, now + HOUR_S)
  return { freshShortfall: Math.max(0, Math.ceil(minN * FRESH_MARGIN) - fresh), shareOfBoost: shareOf(traffic, now, end) }
}

/** Counts only canaries: buyer samples depend on who opted in, so they cannot be planned on. */
function expectedAudited(traffic: readonly number[], now: number, end: number) {
  let total = 0
  for (let at = now; at < end; at += HOUR_S) total += traffic[hourOfWeek(at)]!
  return total * CANARY_SHARE
}

function chooseAccount(accounts: readonly CanaryAccount[], used: Map<string, number>, hourOfDay: number, rng: Rng) {
  const open = accounts.filter((account) => {
    const inHours = account.activeFrom <= account.activeTo ? hourOfDay >= account.activeFrom && hourOfDay <= account.activeTo : hourOfDay >= account.activeFrom || hourOfDay <= account.activeTo
    return inHours && (used.get(account.wallet) ?? 0) < account.dailyLimit
  })
  const total = open.reduce((sum, account) => sum + account.weight, 0)
  let left = rng() * total
  for (const account of open) {
    left -= account.weight
    if (left < 0) return account
  }
  return open[open.length - 1] ?? null
}
