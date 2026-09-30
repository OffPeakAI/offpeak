import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import Redis from "ioredis"
import { HoldLedger } from "../src/pay/prepaid.ts"
import { RedisHolds } from "../src/pay/redis-holds.ts"

const script = readFileSync(new URL("../src/pay/holds.lua", import.meta.url), "utf8")

describe("carving a line's hold from its hour's hold", () => {
  const view = { servable: true, hourlyCap: 1000n, dailyCap: 1000n, balance: 1000n, hour: 48, day: 2, lastSettledHour: 47n }

  /** The same steps on both ledgers: the Lua one in production and the one tests and local runs use. */
  async function steps(ledger: { admit: (...args: never[]) => Promise<{ ok: boolean }>; committed: (wallet: string, hour: bigint) => Promise<bigint>; release: (wallet: string, id: string) => Promise<void> }, wallet: string) {
    const admit = (id: string, amount: bigint, from?: string, cap = view) => ledger.admit(wallet as never, amount as never, cap as never, id as never, 1000 as never, 3600 as never, from as never)
    const seen: unknown[] = []
    seen.push((await admit("slot", 800n)).ok)
    seen.push((await admit("outsider", 300n)).ok)
    seen.push((await admit("line1", 300n, "slot")).ok)
    seen.push(await ledger.committed(wallet, 47n))
    seen.push((await admit("line2", 900n, "slot")).ok)
    seen.push((await admit("line3", 300n, "slot", { ...view, hourlyCap: 100n })).ok)
    seen.push(await ledger.committed(wallet, 47n))
    seen.push((await admit("line4", 500n, "slot")).ok)
    seen.push(await ledger.committed(wallet, 47n))
    seen.push((await admit("line5", 100n, "slot")).ok)
    await ledger.release(wallet, "slot")
    seen.push(await ledger.committed(wallet, 47n))
    return seen
  }

  test("the Lua script and the in-process ledger agree, and a refused line leaves the hour's hold whole", async () => {
    const redis = new Redis(process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379")
    const wallet = `0x${Date.now().toString(16)}`
    const inLua = await steps(new RedisHolds(redis) as never, wallet)
    const inProcess = await steps(new HoldLedger() as never, wallet)
    expect(inLua).toEqual([true, false, true, 800n, false, false, 800n, true, 800n, true, 900n])
    expect(inProcess).toEqual(inLua)
    await redis.quit()
  })
})

describe("holds.lua on redis", () => {
  test("a thousand parallel admits stay inside the cap", async () => {
    const redis = new Redis(process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379")
    const prefix = `holdtest:${Date.now()}`
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        redis.eval(script, 1, prefix, "admit", "1", "10", "0", "100", "100", "100", "1", `h${i}`, "1060", "1000", "0"),
      ),
    )
    const ok = results.filter((row) => row === "ok").length
    expect(ok).toBe(100)
    expect(await redis.hlen(`${prefix}:holds`)).toBe(100)
    expect(await redis.hget(`${prefix}:open`, "total")).toBe("100")
    const times: number[] = []
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now()
      await redis.eval(script, 1, `${prefix}:seq`, "admit", "1", "11", "0", "100000", "100000", "100000", "1", `s${i}`, "1060", "1000", "0")
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0
    expect(p95).toBeLessThan(5)
    await redis.quit()
  })

  test("a settled hour stops counting, and an expired hold frees its amount", async () => {
    const redis = new Redis(process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379")
    const prefix = `holdtest:${Date.now()}:life`
    const admit = (id: string, amount: string, now: number, lastSettled: string) =>
      redis.eval(script, 1, prefix, "admit", amount, "48", "2", "1000", "1000", "100", "1", id, String(now + 60), String(now), lastSettled)
    expect(await admit("a", "80", 1_000, "47")).toBe("ok")
    expect(await redis.eval(script, 1, prefix, "capture", "a", "70", "48")).toBe("ok")
    expect(await redis.eval(script, 1, prefix, "capture", "a", "70", "48")).toBe("ok")
    expect(await admit("b", "40", 1_000, "47")).toBe("insufficient_reserve")
    expect(await admit("c", "40", 1_000, "48")).toBe("ok")
    expect(await admit("d", "90", 1_030, "48")).toBe("insufficient_reserve")
    expect(await admit("e", "90", 1_070, "48")).toBe("ok")
    expect(await redis.eval(script, 1, prefix, "capture", "gone", "1", "48")).toBe("ok")
    expect(await redis.hget(`${prefix}:spend`, "48")).toBe("71")
    await redis.quit()
  })
})
