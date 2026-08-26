import Redis from "ioredis"
import type { ChainPush } from "@offpeak/shared"
import type { Stack } from "../context.ts"
import type { LiveChain } from "./live.ts"

const CHAIN_CHANNEL = "offpeak:chain"
const MAX_AUTH_RESULTS = 20_000

/** Remembered, because the answer can arrive before the stream reaches its gate. */
export function settleAuthorization(stack: Stack, reqId: string, result: "ok" | "fail") {
  if (stack.authResults.size >= MAX_AUTH_RESULTS) stack.authResults.delete(stack.authResults.keys().next().value!)
  stack.authResults.set(reqId, result)
  for (const fn of stack.authWaiters.get(reqId) ?? []) fn(result)
  stack.authWaiters.delete(reqId)
}

/** Serving's reactions to chain events. Admission stops within the turn the push arrives. */
export function watchChain(stack: Stack) {
  return stack.indexer.subscribe((msg: ChainPush) => {
    stack.candidateCache.clear()
    if (msg.type === "Authorized" || msg.type === "AuthorizeFailed" || msg.type === "ExactSettled") {
      settleAuthorization(stack, String(msg.reqId).toLowerCase(), msg.type === "AuthorizeFailed" ? "fail" : "ok")
    }
  })
}

/** Subscribes the live view to `offpeak:chain`. Keeps its own connection, as Redis requires. */
export function subscribePushes(url: string, chain: LiveChain) {
  const redis = new Redis(url, { maxRetriesPerRequest: null })
  let connected = false
  redis.on("ready", () => {
    if (connected) chain.resync()
    connected = true
    void redis.subscribe(CHAIN_CHANNEL)
  })
  redis.on("message", (_channel, raw) => {
    try {
      chain.push(JSON.parse(raw) as ChainPush)
    } catch (err) {
      console.error(JSON.stringify({ service: "router", event: "bad_push", error: String(err) }))
    }
  })
  return redis
}
