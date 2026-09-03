import { readFileSync } from "node:fs"
import Redis from "ioredis"
import { indexerApp } from "./http.ts"
import { MockIndexer } from "./state.ts"

const idx = new MockIndexer()
const buyers = JSON.parse(readFileSync(new URL("../../../packages/shared/fixtures/indexer/buyers.json", import.meta.url), "utf8"))
for (const [addr, view] of Object.entries(buyers)) idx.setBuyer(addr, view as Record<string, unknown>)

if (process.env.OFFPEAK_REDIS_URL) {
  const redis = new Redis(process.env.OFFPEAK_REDIS_URL)
  idx.subscribe((msg) => void redis.publish("offpeak:chain", JSON.stringify(msg)))
}

const port = Number(process.env.OFFPEAK_INDEXER_PORT ?? 8788)
Bun.serve({ port, fetch: indexerApp(idx).fetch })
console.log(`mock indexer on ${port}`)
