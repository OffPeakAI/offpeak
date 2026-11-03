import { feeBpsFor, type Hex } from "@offpeak/shared"
import { sessionWallet } from "../auth/siwe.ts"
import { serveChat } from "../openai/chat.ts"
import { oai } from "../http.ts"
import type { Stack, Payer } from "../context.ts"

/** The wallet session authorizes spending its existing vault balance; no API key is issued. */
export async function sessionChat(stack: Stack, req: Request, ip: string) {
  const wallet = await sessionWallet(stack, req.headers.get("authorization") ?? undefined)
  if (!wallet) return oai(401, "Connect and sign in with your wallet", "auth", "no_session")
  if (!req.headers.has("x-offpeak-max-charge"))
    return oai(400, "Set a maximum charge per message", "invalid_request", "max_charge_required")
  const rate = await stack.counters.add(`offpeak:chat:${wallet}:${Math.floor(stack.clock() / 60)}`, 1n, 120)
  if (rate > 30n) return oai(429, "Too many messages", "rate_limit", "rpm")
  const row = await stack.db.query<{ id: string; audit_opt_in: boolean }>(
    `INSERT INTO serving.accounts (id,wallet,audit_opt_in) VALUES ($1,$2,false)
    ON CONFLICT (wallet) DO UPDATE SET wallet=EXCLUDED.wallet RETURNING id,audit_opt_in`,
    [`acct_${wallet.slice(2, 18)}`, wallet],
  )
  const discount = stack.flags.token_hooks ? ((await stack.indexer.ofpkOf(wallet))?.feeDiscountBps ?? 0) : 0
  const base = {
    mode: 0,
    accountId: row.rows[0]!.id,
    wallet: wallet as Hex,
    feeBps: feeBpsFor({ auditOptIn: row.rows[0]!.audit_opt_in, ofpkDiscountBps: discount }),
  } as const
  const window = req.headers.get("x-offpeak-window")
  if (window && (!stack.flags.windows || !/^\d{1,78}$/.test(window) || BigInt(window) >= 2n ** 256n))
    return oai(400, "Window is unavailable or invalid", "invalid_request", "bad_window")
  const payer: Payer = window
    ? { mode: 4, accountId: base.accountId, wallet: base.wallet, windowId: BigInt(window), prepaidFeeBps: base.feeBps }
    : base
  // Session chat intentionally does not accept delayed jobs or sealed bytes.
  if (req.headers.has("x-offpeak-flex") || !req.headers.get("content-type")?.startsWith("application/json"))
    return oai(400, "Use the SDK for this request type", "invalid_request", "unsupported_chat_mode")
  return serveChat(stack, req, undefined, ip, payer)
}
