import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { Metrics, openDatabase } from "@offpeak/common"
import { createApi } from "./api.ts"

const TOKEN = "t".repeat(32)

async function api() {
  const db = await openDatabase("pglite://memory")
  const reader = { getBlock: async () => ({ number: 1n, timestamp: 1_800_000_000n }) }
  return createApi({ db, reader: reader as never, contracts: {}, internalToken: TOKEN, metrics: new Metrics() })
}

const from = (address: string) => ({ requestIP: () => ({ address }) })

describe("indexer API access", () => {
  afterEach(() => void setSystemTime())

  test("/idx needs the exact token", async () => {
    const app = await api()
    const get = (authorization?: string) => app.request("/idx/v1/hosts", { headers: authorization ? { authorization } : {} })
    expect((await get()).status).toBe(401)
    expect((await get("Bearer wrong")).status).toBe(401)
    expect((await get(`Bearer ${TOKEN}x`)).status).toBe(401)
    expect((await get(`Bearer ${TOKEN}`)).status).toBe(200)
  })

  test("/public answers up to the limit, then refuses that caller only", async () => {
    const app = await api()
    const get = (address: string) => app.request("/public/v1/stats/hosts", {}, from(address))
    for (let i = 0; i < 120; i++) expect((await get("198.51.100.1")).status).toBe(200)
    const refused = await get("198.51.100.1")
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("60")
    expect((await get("198.51.100.2")).status).toBe(200)
  })

  test("the limit lifts in the next minute", async () => {
    const app = await api()
    const start = Date.now()
    setSystemTime(new Date(start))
    const get = () => app.request("/public/v1/stats/hosts", {}, from("198.51.100.3"))
    for (let i = 0; i < 121; i++) await get()
    expect((await get()).status).toBe(429)
    setSystemTime(new Date(start + 60_001))
    expect((await get()).status).toBe(200)
  })

  test("/idx is not limited", async () => {
    const app = await api()
    for (let i = 0; i < 125; i++) await app.request("/idx/v1/hosts", { headers: { authorization: `Bearer ${TOKEN}` } }, from("198.51.100.4"))
    expect((await app.request("/idx/v1/hosts", { headers: { authorization: `Bearer ${TOKEN}` } }, from("198.51.100.4"))).status).toBe(200)
  })
})
