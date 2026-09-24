import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto"
import { AUDIT_BODY_RETENTION_S, canonicalJson, dayIndex } from "@offpeak/shared"
import type { Db } from "../../../services/common/src/db.ts"

/** 2% of an opted-in buyer's requests, in parts per million. */
export const SAMPLE_PPM = 20_000
/** The retention job can run up to an hour late and a body still goes inside 72 h. */
export const SAMPLE_TTL_S = AUDIT_BODY_RETENTION_S - 3_600

const IV_BYTES = 12
const TAG_BYTES = 16

export type SampleContent = { body: Record<string, unknown>; text: string; toolCalls: unknown[] }

export type SampleInput = SampleContent & {
  reqId: string
  host: string
  modelDigest: string
  accountId: string | null
  ts: number
}

export type SampleRow = { req_id: string; host: string; model_digest: string; enc_body: string; day_key_id: string; ts: string }

/**
 * A KEK wraps each day's key, so a copy of the database alone reads nothing. A copy plus the KEK does:
 * wrapped keys survive in backups and the KEK does not rotate, so `docs/runbooks/deploy-mainnet.md`
 * sets how long backups may keep these tables.
 */
export function parseKek(raw: string | undefined): Buffer | null {
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return null
  return Buffer.from(raw.replace(/^0x/, ""), "hex")
}

export function drawsSample() {
  return randomInt(1_000_000) < SAMPLE_PPM
}

function seal(key: Buffer, plain: Buffer, aad: string) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

function unseal(key: Buffer, sealed: string, aad: string) {
  const bytes = Buffer.from(sealed, "base64url")
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
}

const keyAad = (id: string) => `offpeak-audit-day-key/${id}`

/** Every router process lands on the same key: the first insert wins and the rest read it back. */
async function dayKey(db: Db, kek: Buffer, day: number) {
  const id = `day-${day}`
  const retireAt = (day + 1) * 86_400 + SAMPLE_TTL_S
  await db.query(
    "INSERT INTO serving.audit_day_keys (id, day, wrapped, retire_at) VALUES ($1,$2,$3,to_timestamp($4)) ON CONFLICT (day) DO NOTHING",
    [id, day, seal(kek, randomBytes(32), keyAad(id)), retireAt],
  )
  const rows = await db.query<{ wrapped: string }>("SELECT wrapped FROM serving.audit_day_keys WHERE id = $1", [id])
  return { id, key: unseal(kek, rows.rows[0]!.wrapped, keyAad(id)) }
}

async function optedIn(db: Db, accountId: string | null) {
  if (!accountId) return false
  const rows = await db.query<{ audit_opt_in: boolean }>("SELECT audit_opt_in FROM serving.accounts WHERE id = $1", [accountId])
  return rows.rows[0]?.audit_opt_in === true
}

/** Stores one response for an opted-in buyer. Everyone else leaves only hashes and metering checks. */
export async function storeSample(db: Db, kek: Buffer, input: SampleInput) {
  if (!(await optedIn(db, input.accountId))) return false
  const { id, key } = await dayKey(db, kek, dayIndex(input.ts))
  const content: SampleContent = { body: input.body, text: input.text, toolCalls: input.toolCalls }
  await db.query(
    `INSERT INTO serving.audit_samples (req_id, host, model_digest, enc_body, day_key_id, ts, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::bigint,to_timestamp($7::double precision),to_timestamp($8::double precision)) ON CONFLICT (req_id) DO NOTHING`,
    [input.reqId, input.host, input.modelDigest, seal(key, Buffer.from(canonicalJson(content)), input.reqId), id, input.ts, input.ts, input.ts + SAMPLE_TTL_S],
  )
  return true
}

/** A row that keeps failing stops here, and waits longer each time, so it cannot hold up newer rows. */
export const MAX_SCORE_ATTEMPTS = 10
const RETRY_BASE_S = 60

/** Records a failed try. Returns true when that was the last one. */
export async function noteScoreFailure(db: Db, table: "serving.audit_samples" | "serving.canary_runs", reqId: string, nowS: number) {
  const rows = await db.query<{ score_attempts: number }>(`UPDATE ${table} SET score_attempts = score_attempts + 1, retry_at = $2::bigint + ($3::bigint << score_attempts) WHERE req_id = $1 RETURNING score_attempts`, [reqId, nowS, RETRY_BASE_S])
  return Number(rows.rows[0]?.score_attempts ?? 0) >= MAX_SCORE_ATTEMPTS
}

/** Bodies waiting for a score, oldest first. */
export async function dueSamples(db: Db, nowS: number, limit: number) {
  const rows = await db.query<SampleRow>(
    `SELECT req_id, host, model_digest, enc_body, day_key_id, ts FROM serving.audit_samples
     WHERE scored_at IS NULL AND expires_at > to_timestamp($1) AND score_attempts < $3 AND retry_at <= $4 ORDER BY score_attempts, ts LIMIT $2`,
    [nowS, limit, MAX_SCORE_ATTEMPTS, nowS],
  )
  return rows.rows
}

/** Null once the key is gone: destroyed data stays unreadable however the row survived. */
export async function openSample(db: Db, kek: Buffer, row: SampleRow): Promise<SampleContent | null> {
  const keys = await db.query<{ wrapped: string }>("SELECT wrapped FROM serving.audit_day_keys WHERE id = $1", [row.day_key_id])
  const wrapped = keys.rows[0]?.wrapped
  if (!wrapped) return null
  const key = unseal(kek, wrapped, keyAad(row.day_key_id))
  return JSON.parse(unseal(key, row.enc_body, row.req_id).toString("utf8")) as SampleContent
}

export async function markScored(db: Db, reqId: string, nowS: number) {
  await db.query("UPDATE serving.audit_samples SET scored_at = to_timestamp($2) WHERE req_id = $1", [reqId, nowS])
}

/** Deletes expired bodies, then destroys every key whose last body has gone. */
export async function runRetention(db: Db, nowS: number) {
  return db.transaction(async (tx) => {
    const bodies = await tx.query<{ req_id: string }>("DELETE FROM serving.audit_samples WHERE expires_at <= to_timestamp($1) RETURNING req_id", [nowS])
    const keys = await tx.query<{ id: string }>("DELETE FROM serving.audit_day_keys WHERE retire_at <= to_timestamp($1) RETURNING id", [nowS])
    return { bodies: bodies.rows.length, keys: keys.rows.length }
  })
}

const round = (value: unknown, step: number) => (typeof value === "number" && Number.isFinite(value) ? Number((Math.round(value / step) * step).toFixed(2)) : null)

function tokenBand(value: unknown) {
  if (typeof value !== "number" || value < 1) return null
  return 2 ** Math.ceil(Math.log2(value))
}

/** A request's shape, with no content in it. Canary parameters are drawn from counts of these. */
export function trafficShape(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string }[]) : []
  return canonicalJson({
    temperature: round(body.temperature, 0.1),
    topP: round(body.top_p, 0.05),
    maxTokens: tokenBand(body.max_tokens ?? body.max_completion_tokens),
    tools: Array.isArray(body.tools) ? Math.min(body.tools.length, 4) : 0,
    stream: body.stream === true,
    system: messages[0]?.role === "system",
    turns: Math.min(messages.filter((m) => m.role === "user").length, 6),
    format: (body.response_format as { type?: string } | undefined)?.type ?? null,
    seed: typeof body.seed === "number",
    stop: body.stop !== undefined && body.stop !== null,
  })
}

export type TrafficShape = {
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  tools: number
  stream: boolean
  system: boolean
  turns: number
  format: string | null
  seed: boolean
  stop: boolean
}
