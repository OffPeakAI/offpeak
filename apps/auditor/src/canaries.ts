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
