import { createHash, randomBytes } from "node:crypto"
import { feeBpsFor, type Hex, type PaymentPayload } from "@offpeak/shared"
import type { Payer, Stack } from "../context.ts"
import { featureOff, oai } from "../http.ts"
import { channelProof, voucherBody } from "../pay/schemas.ts"

type KeyRow = { accountId: string; wallet: string; rpm: number; audit: boolean }

const KEY_CACHE_MS = 5_000
const KEY_CACHE_MAX = 10_000
const CHANNEL_ID = /^0x[0-9a-fA-F]{64}$/
const keyCache = new WeakMap<Stack, Map<string, { row: KeyRow | null; at: number }>>()

function keyHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

/** A new key leaves the account's audit choice alone. A new account starts opted out. */
export async function issueKey(stack: Stack, wallet: string, label = "default") {
  const token = `op_live_${randomBytes(24).toString("base64url")}`
  const owner = wallet.toLowerCase()
  const created = await stack.db.query<{ id: string }>(
    `INSERT INTO serving.accounts (id, wallet, audit_opt_in) VALUES ($1,$2,false)
     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet RETURNING id`,
    [`acct_${owner.slice(2, 18)}`, owner],
  )
  const accountId = created.rows[0]!.id
  await stack.db.query("INSERT INTO serving.api_keys (key_hash, account_id, label) VALUES ($1,$2,$3)", [keyHash(token), accountId, label])
  return { token, accountId }
}

async function lookup(stack: Stack, hash: string) {
  const cache = keyCache.get(stack) ?? new Map<string, { row: KeyRow | null; at: number }>()
  keyCache.set(stack, cache)
  const hit = cache.get(hash)
  if (hit && performance.now() - hit.at < KEY_CACHE_MS) return hit.row
  const rows = await stack.db.query<{ account_id: string; rpm_limit: number; wallet: string; audit_opt_in: boolean }>(
    `SELECT k.account_id, k.rpm_limit, a.wallet, a.audit_opt_in
     FROM serving.api_keys k JOIN serving.accounts a ON a.id = k.account_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hash],
  )
  const row = rows.rows[0]
  const found = row ? { accountId: row.account_id, wallet: row.wallet, rpm: row.rpm_limit, audit: row.audit_opt_in } : null
  if (cache.size >= KEY_CACHE_MAX) cache.clear()
  cache.set(hash, { row: found, at: performance.now() })
  return found
}

/** A night job runs as its account, long after any key that started it. The job fixed its fee when it was accepted. */
export async function accountPayer(stack: Stack, accountId: string, feeBps: number): Promise<Extract<Payer, { mode: 0 }> | null> {
  const rows = await stack.db.query<{ wallet: string }>("SELECT wallet FROM serving.accounts WHERE id = $1", [accountId])
  const wallet = rows.rows[0]?.wallet
  return wallet ? { mode: 0, accountId, wallet: wallet as Hex, feeBps } : null
}

function parseVoucher(raw: string) {
  try {
    const parsed = voucherBody.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parseProof(raw: string | null) {
  if (!raw) return undefined
  try {
    return channelProof.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))).data
  } catch {
    return undefined
  }
}

function parsePayment(raw: string) {
  try {
    const parsed = JSON.parse(raw) as PaymentPayload
    return parsed.scheme && parsed.payload ? parsed : null
  } catch {
    return null
  }
}

export async function auth(stack: Stack, req: Request): Promise<Payer | Response> {
  const header = req.headers.get("authorization")
  const channel = req.headers.get("x-offpeak-channel")
  const payment = req.headers.get("payment-signature") ?? req.headers.get("x-payment")
  const windowId = req.headers.get("x-offpeak-window")
  let prepaid: { accountId: string; wallet: Hex; audit: boolean } | null = null
  if (header?.startsWith("Bearer op_live_")) {
    const hash = keyHash(header.slice("Bearer ".length))
    const row = await lookup(stack, hash)
    if (!row) return oai(401, "Unknown API key", "auth", "bad_key")
    const minute = Math.floor(stack.clock() / 60)
    const used = await stack.counters.add(`offpeak:rpm:${hash}:${minute}`, 1n, 120)
    if (used > BigInt(row.rpm)) return oai(429, "Rate limit", "rate_limit", "rpm")
    prepaid = { accountId: row.accountId, wallet: row.wallet as Hex, audit: row.audit }
  }
  const prepaidFee = async (buyer: NonNullable<typeof prepaid>) => {
    const discount = stack.flags.token_hooks ? ((await stack.indexer.ofpkOf(buyer.wallet))?.feeDiscountBps ?? 0) : 0
    return feeBpsFor({ auditOptIn: buyer.audit, ofpkDiscountBps: discount })
  }
  if (windowId && !stack.flags.windows) return featureOff("Windows")
  if (windowId && prepaid) {
    if (!/^\d+$/.test(windowId)) return oai(400, "Bad Window id", "invalid_request", "bad_window")
    return { mode: 4, wallet: prepaid.wallet, windowId: BigInt(windowId), accountId: prepaid.accountId, prepaidFeeBps: await prepaidFee(prepaid) }
  }
  if (channel) {
    if (!stack.flags.channels) return featureOff("Channels")
    const raw = req.headers.get("x-offpeak-voucher")
    const voucher = raw ? parseVoucher(raw) : undefined
    if (voucher === null) return oai(402, "Voucher cannot be read", "payment", "bad_voucher")
    if (!CHANNEL_ID.test(channel)) return oai(400, "Bad channel id", "invalid_request", "bad_channel")
    return {
      mode: 3,
      wallet: (prepaid?.wallet ?? "0x0000000000000000000000000000000000000000") as Hex,
      channelId: channel.toLowerCase() as Hex,
      feeBps: feeBpsFor({}),
      voucher,
      proof: parseProof(req.headers.get("x-offpeak-channel-auth")),
    }
  }
  if (payment) {
    if (!stack.flags.upto) return featureOff("x402")
    const parsed = parsePayment(payment)
    if (!parsed) return oai(402, "Payment cannot be read", "payment", "payment_required")
    return { mode: parsed.scheme === "exact" ? 2 : 1, wallet: "0x0000000000000000000000000000000000000000" as Hex, payment: parsed, feeBps: feeBpsFor({}) }
  }
  if (!prepaid) return oai(402, "Payment required", "payment", "payment_required")
  return { mode: 0, accountId: prepaid.accountId, wallet: prepaid.wallet, feeBps: await prepaidFee(prepaid) }
}

export const authenticate = auth
