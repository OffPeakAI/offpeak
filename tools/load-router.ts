#!/usr/bin/env bun
import Redis from "ioredis"
import { RedisHolds } from "../apps/router/src/pay/redis-holds.ts"
import { bootStack } from "../apps/router/test/support/stack.ts"
import { canonicalJson } from "../packages/shared/src/canonical.ts"
import { keepSigners, privateKeyOf, signRouterCanon } from "../packages/shared/src/sigpool.ts"

const n = Number(process.env.OFFPEAK_LOAD_N ?? 500)
keepSigners(3_600_000)
const { app, key, stack } = await bootStack()
await stack.db.query("UPDATE serving.api_keys SET rpm_limit = 100000")
const redis = new Redis(process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379/8", { enableAutoPipelining: true })
await redis.flushdb()
const redisHolds = new RedisHolds(redis)
const holdMs: number[] = []
stack.ledger = {
  admit: async (...args) => {
    const started = performance.now()
    const result = await redisHolds.admit(...args)
    holdMs.push(performance.now() - started)
    return result
  },
  capture: (...args) => redisHolds.capture(...args),
  release: (...args) => redisHolds.release(...args),
  committed: (...args) => redisHolds.committed(...args),
}
const hostPort = 29790
const hostProcess = Bun.spawn(["bun", "run", "tools/load-host.ts"], { env: { ...process.env, OFFPEAK_HOST_PORT: String(hostPort) }, stdout: "pipe", stderr: "inherit" })
await hostProcess.stdout.getReader().read()
stack.hosts = { request: (_host, _endpoint, path, init) => fetch(`http://127.0.0.1:${hostPort}${path}`, init) }
const signingKey = privateKeyOf(stack.router)
const warmCanon = canonicalJson(JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "load" }], max_tokens: 8, stream: true }))
for (let wave = 0; wave < 2; wave++) {
  await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      signRouterCanon(signingKey, {
        canon: warmCanon,
        reqId: `0x${(wave * 1000 + i + 1).toString(16).padStart(64, "0")}`,
        ts: 1762000000,
      }),
    ),
  )
}

async function one() {
  const t0 = performance.now()
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "load" }], max_tokens: 8, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`status ${res.status}`)
  const reader = res.body.getReader()
  await reader.read()
  const ms = performance.now() - t0
  await reader.cancel()
  return ms
}

const sequential: number[] = []
for (let i = 0; i < 40; i++) sequential.push(await one())
sequential.sort((a, b) => a - b)

async function burst() {
  const samples: number[] = []
  stack.serverTtftMs = []
  stack.hostWaitMs = []
  await Promise.all(Array.from({ length: n }, async () => samples.push(await one())))
  samples.sort((a, b) => a - b)
  const server = [...(stack.serverTtftMs ?? [])].sort((a, b) => a - b)
  const host = [...(stack.hostWaitMs ?? [])].sort((a, b) => a - b)
  return {
    client: samples[Math.floor(samples.length * 0.95)] ?? 0,
    server: server[Math.floor(server.length * 0.95)] ?? 0,
    host: host[Math.floor(host.length * 0.95)] ?? 0,
  }
}

const warmup = await burst()
holdMs.length = 0
const measured = await burst()
const holdsP95 = [...holdMs].sort((a, b) => a - b)[Math.floor(holdMs.length * 0.95)] ?? 0
const seqP95 = sequential[Math.floor(sequential.length * 0.95)] ?? 0
console.log(JSON.stringify({
  n,
  per_request_ttfb_p95_ms: Math.round(seqP95 * 10) / 10,
  warmup_burst_ttfb_p95_ms: Math.round(warmup.client * 10) / 10,
  burst_ttfb_p95_ms: Math.round(measured.client * 10) / 10,
  server_ttft_p95_ms: Math.round(measured.server * 10) / 10,
  host_wait_p95_ms: measured.host,
  router_overhead_p95_ms: Math.round((measured.client - measured.host) * 10) / 10,
  holds_admit_p95_ms: Math.round(holdsP95 * 10) / 10,
}))
hostProcess.kill()
await redis.flushdb()
if (seqP95 >= 30 || measured.client - measured.host >= 30) process.exit(1)
process.exit(0)
