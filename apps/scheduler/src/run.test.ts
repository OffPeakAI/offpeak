import { describe, expect, test } from "bun:test"
import { Queue } from "bullmq"
import { startHourCloseWorker, startNightService } from "../src/run.ts"

const redisUrl = process.env.OFFPEAK_REDIS_URL ?? "redis://127.0.0.1:6379"
const routerPort = Number(process.env.OFFPEAK_TEST_ROUTER_PORT ?? 34511)

async function until(check: () => boolean, ms = 4000) {
  const started = performance.now()
  while (!check() && performance.now() - started < ms) await Bun.sleep(20)
}

describe("hour close worker", () => {
  test("a redis job reaches the handler", async () => {
    const seen: number[] = []
    const worker = startHourCloseWorker(async (hour) => {
      seen.push(hour)
    }, redisUrl)
    const queue = new Queue("offpeak-hour-close", { connection: { url: redisUrl } })
    await queue.add("close", { hour: 42 }, { removeOnComplete: true })
    await until(() => seen.length > 0)
    expect(seen).toEqual([42])
    await worker.close()
    await queue.close()
  })
})

describe("the night service", () => {
  test("each tick asks the router what is due, and drains a slot one call at a time", async () => {
    const token = "t".repeat(32)
    const asked: string[] = []
    const runs: unknown[] = []
    let due = [{ jobId: "batch_one", hour: 7 }]
    let left = 2
    const router = Bun.serve({
      port: routerPort,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 403 })
        asked.push(path)
        if (path === "/internal/night-jobs/due") {
          const slots = due
          due = []
          return Response.json({ slots })
        }
        runs.push(await req.json())
        left -= 1
        return Response.json({ ran: 1, moved: 0, left })
      },
    })
    const service = await startNightService({ redisUrl, routerUrl: `http://127.0.0.1:${routerPort}`, token, everyMs: 100 })
    await until(() => runs.length >= 2)
    await service.close()
    router.stop(true)
    expect(runs).toEqual([{ hour: 7 }, { hour: 7 }])
    expect(asked[0]).toBe("/internal/night-jobs/due")
    expect(asked).toContain("/v1/batches/batch_one/run")
    const cleanup = new Queue("offpeak-night-jobs", { connection: { url: redisUrl } })
    await cleanup.removeJobScheduler("night-tick")
    await cleanup.obliterate({ force: true })
    await cleanup.close()
  })

  test("a slot that is stuck stops the drain instead of spinning", async () => {
    const token = "t".repeat(32)
    let calls = 0
    let due = [{ jobId: "batch_stuck", hour: 9 }]
    const router = Bun.serve({
      port: routerPort + 1,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (new URL(req.url).pathname === "/internal/night-jobs/due") {
          const slots = due
          due = []
          return Response.json({ slots })
        }
        calls += 1
        return Response.json({ ran: 0, moved: 0, left: 3 })
      },
    })
    const service = await startNightService({ redisUrl, routerUrl: `http://127.0.0.1:${routerPort + 1}`, token, everyMs: 100 })
    await until(() => calls > 0)
    await Bun.sleep(150)
    await service.close()
    router.stop(true)
    expect(calls).toBe(1)
    const cleanup = new Queue("offpeak-night-jobs", { connection: { url: redisUrl } })
    await cleanup.removeJobScheduler("night-tick")
    await cleanup.obliterate({ force: true })
    await cleanup.close()
  })
})
