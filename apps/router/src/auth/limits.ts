import type { Payer, Stack } from "../context.ts"
import { oai } from "../http.ts"
import { proveChannel } from "../pay/authorize.ts"

const LIMIT_WINDOW_S = 60
/** What an unproven caller can have counted. A long body holds the event loop for hundreds of milliseconds. */
const UNPROVEN_BYTES_PER_MINUTE = 8n * 1024n * 1024n

/** Adds `cost` to an address's minute. A `Response` means it is over `limit`. */
export async function ipLimit(stack: Stack, ip: string, scope: string, limit: bigint, cost = 1n) {
  const minute = Math.floor(stack.clock() / LIMIT_WINDOW_S)
  const used = await stack.counters.add(`offpeak:ip:${scope}:${ip}:${minute}`, cost, LIMIT_WINDOW_S * 2)
  return used > limit ? oai(429, "Too many requests from this address", "rate_limit", "ip_limit") : null
}

/**
 * Runs before the tokenizer. An API key has been checked by now, and a channel's proof is checked here. An x402
 * payment can only be checked at its price, which needs the count, so it draws on its address like a quote does.
 */
export async function beforeCounting(stack: Stack, payer: Payer | null, rawBody: string, ip: string) {
  if (payer?.mode === 3) return proveChannel(stack, payer, rawBody)
  if (payer?.mode === 0 || payer?.mode === 4) return null
  return ipLimit(stack, ip, "count", UNPROVEN_BYTES_PER_MINUTE, BigInt(Buffer.byteLength(rawBody)))
}
