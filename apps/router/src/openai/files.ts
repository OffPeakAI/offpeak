import { createHash, randomBytes } from "node:crypto"
import type { Db } from "@offpeak/common"
import { z } from "zod"
import { auth, type Stack } from "../pipeline.ts"
import { oai } from "../http.ts"

/** Long enough to upload a file and then start a job. A job extends it to its deadline. */
const FILE_TTL_S = 7 * 86_400
const MAX_FILE_BYTES = 64 * 1024 * 1024
/** Files stay for a week with or without a job, and a key costs nothing, so each account gets a limited shelf. */
const ACCOUNT_FILE_BYTES = 512 * 1024 * 1024
const ACCOUNT_FILES = 200
const LINE_CHUNK = 500

const uploadBody = z.object({ purpose: z.string().default("batch"), content: z.string() })

export const newFileId = () => `file_${randomBytes(12).toString("hex")}`

export type StoredFile = { id: string; account_id: string; purpose: string; bytes: string; sha256: string; storage_key: string }

export async function insertFile(db: Db, row: { id: string; accountId: string; purpose: string; bytes: number; sha256: string; expiresAt: number }) {
  await db.query("INSERT INTO serving.files (id, account_id, purpose, bytes, sha256, storage_key, expires_at) VALUES ($1,$2,$3,$4,$5,$1,to_timestamp($6))", [row.id, row.accountId, row.purpose, row.bytes, row.sha256, row.expiresAt])
}

export async function storeLines(db: Db, fileId: string, lines: string[]) {
  await db.query("DELETE FROM serving.file_chunks WHERE storage_key = $1", [fileId])
  for (let start = 0; start < lines.length; start += LINE_CHUNK) {
    const part = lines.slice(start, start + LINE_CHUNK)
    await db.query("INSERT INTO serving.file_chunks (storage_key, seq, content) SELECT $1, seq, convert_to(line, 'UTF8') FROM unnest($2::int[], $3::text[]) AS t(seq, line)", [
      fileId,
      part.map((_, i) => start + i),
      part.map((line) => `${line}\n`),
    ])
  }
}

export async function readFileRow(stack: Stack, id: string) {
  const rows = await stack.db.query<StoredFile>("SELECT id, account_id, purpose, bytes, sha256, storage_key FROM serving.files WHERE id = $1 AND (expires_at IS NULL OR expires_at > to_timestamp($2))", [id, stack.clock()])
  return rows.rows[0]
}

export async function readFileBytes(db: Db, storageKey: string) {
  const chunks = await db.query<{ content: Uint8Array }>("SELECT content FROM serving.file_chunks WHERE storage_key = $1 ORDER BY seq", [storageKey])
  return Buffer.concat(chunks.rows.map((row) => row.content))
}

export async function serveUploadFile(stack: Stack, req: Request): Promise<Response> {
  const payer = await auth(stack, req)
  if (payer instanceof Response) return payer
  if (payer.mode !== 0) return oai(400, "Night jobs are prepaid", "invalid_request", "prepaid_only")
  let purpose = "batch"
  let bytes: Buffer
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null)
    purpose = String(form?.get("purpose") ?? "batch")
    const file = form?.get("file")
    if (!(file instanceof File)) return oai(400, "Missing file", "invalid_request", "bad_file")
    bytes = Buffer.from(await file.arrayBuffer())
  } else {
    const body = uploadBody.safeParse(await req.json().catch(() => null))
    if (!body.success) return oai(400, "Missing file", "invalid_request", "bad_file")
    purpose = body.data.purpose
    bytes = Buffer.from(body.data.content)
  }
  if (purpose !== "batch") return oai(400, "Only batch files are accepted", "invalid_request", "bad_purpose")
  if (bytes.length > MAX_FILE_BYTES) return oai(413, "File is too large", "invalid_request", "file_too_large")
  const id = newFileId()
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const stored = await stack.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [payer.accountId])
    const held = await tx.query<{ files: string; bytes: string | null }>("SELECT COUNT(*) AS files, SUM(bytes) AS bytes FROM serving.files WHERE account_id = $1 AND purpose = 'batch' AND (expires_at IS NULL OR expires_at > to_timestamp($2))", [payer.accountId, stack.clock()])
    if (Number(held.rows[0]?.files ?? 0) >= ACCOUNT_FILES || Number(held.rows[0]?.bytes ?? 0) + bytes.length > ACCOUNT_FILE_BYTES) return false
    await insertFile(tx, { id, accountId: payer.accountId, purpose, bytes: bytes.length, sha256, expiresAt: stack.clock() + FILE_TTL_S })
    await tx.query("INSERT INTO serving.file_chunks (storage_key, seq, content) VALUES ($1,0,$2)", [id, bytes])
    return true
  })
  if (!stored) return oai(429, "This account's file storage is full", "rate_limit", "file_quota")
  return Response.json({ id, object: "file", purpose, bytes: bytes.length, sha256 })
}

export async function serveFileContent(stack: Stack, req: Request, id: string): Promise<Response> {
  const payer = await auth(stack, req)
  if (payer instanceof Response) return payer
  const file = await readFileRow(stack, id)
  if (!file || payer.mode !== 0 || file.account_id !== payer.accountId) return oai(404, "Not found", "invalid_request", "not_found")
  return new Response(new Uint8Array(await readFileBytes(stack.db, file.storage_key)), { headers: { "content-type": "application/jsonl" } })
}

/** Files go when they expire. A job in progress has moved its input's expiry past its own deadline. */
export async function sweepFiles(stack: Stack) {
  const gone = await stack.db.query<{ storage_key: string }>("DELETE FROM serving.files WHERE expires_at <= to_timestamp($1) RETURNING storage_key", [stack.clock()])
  for (const row of gone.rows) await stack.db.query("DELETE FROM serving.file_chunks WHERE storage_key = $1", [row.storage_key])
}
