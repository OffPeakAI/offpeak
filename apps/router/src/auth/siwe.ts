import { randomBytes } from "node:crypto"
import { verifyMessage } from "viem"
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe"
import type { Stack } from "../context.ts"

const NONCE_TTL_S = 600
const SESSION_TTL_S = 86_400

export async function createNonce(stack: Stack, wallet: string) {
  const nonce = generateSiweNonce()
  const expires = stack.clock() + NONCE_TTL_S
  await stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ($1,$2,$3,to_timestamp($4))", [`nonce_${nonce}`, wallet.toLowerCase(), nonce, expires])
  return { nonce, expires }
}

/** Spends the nonce, so a signed login cannot be replayed. */
export async function verifyLogin(stack: Stack, message: string, signature: `0x${string}`) {
  const parsed = parseSiweMessage(message)
  if (!parsed.address || !parsed.nonce) return { ok: false as const }
  const spent = await stack.db.query<{ wallet: string }>("DELETE FROM serving.siwe_sessions WHERE id = $1 AND expires_at > to_timestamp($2) RETURNING wallet", [`nonce_${parsed.nonce}`, stack.clock()])
  const wallet = spent.rows[0]?.wallet
  if (!wallet || wallet !== parsed.address.toLowerCase()) return { ok: false as const }
  if (!validateSiweMessage({ message: parsed, domain: stack.siweDomain, nonce: parsed.nonce, time: new Date(stack.clock() * 1000) })) return { ok: false as const }
  if (!(await verifyMessage({ address: parsed.address, message, signature }).catch(() => false))) return { ok: false as const }
  const session = `sess_${randomBytes(24).toString("base64url")}`
  await stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ($1,$2,'',to_timestamp($3))", [session, wallet, stack.clock() + SESSION_TTL_S])
  return { ok: true as const, session, wallet }
}

export async function sessionWallet(stack: Stack, authorization: string | undefined) {
  const session = authorization?.startsWith("Bearer sess_") ? authorization.slice("Bearer ".length) : null
  if (!session) return null
  const rows = await stack.db.query<{ wallet: string }>("SELECT wallet FROM serving.siwe_sessions WHERE id = $1 AND expires_at > to_timestamp($2)", [session, stack.clock()])
  return rows.rows[0]?.wallet ?? null
}
