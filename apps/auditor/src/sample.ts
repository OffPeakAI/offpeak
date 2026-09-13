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
