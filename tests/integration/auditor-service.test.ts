import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Redis from "ioredis"
import { auditQueue } from "../../apps/router/src/audit/queue.ts"
import { openDb } from "../../apps/router/src/store.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import type { Db } from "../../services/common/src/db.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

/** `main.ts` as a real process, on real Postgres, Redis and BullMQ, from its environment. */
const PG_PORT = 32432
const REDIS_PORT = 32379
const CHAIN_PORT = 32547
const INDEXER_PORT = 32548
const AUDITOR_PORT = 32549
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}/11`
const DATABASE = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`
const PG_BIN = "/opt/homebrew/opt/postgresql@16/bin/"
const pgEnv = { ...process.env, LC_ALL: "C" }
const root = new URL("../../", import.meta.url).pathname
const hasServices = Boolean(Bun.which(`${PG_BIN}initdb`)) && Boolean(Bun.which("redis-server"))

const auditorKey = `0x${Buffer.from(anvilAccount(19).getHdKey().privateKey!).toString("hex")}`
const routerKey = `0x${Buffer.from(roleAccount("router").getHdKey().privateKey!).toString("hex")}`

let dataDir: string
let db: Db
let chain: LocalChain
let redisServer: Bun.Subprocess
let indexer: ReturnType<typeof Bun.serve>
let service: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
let lines = ""

function environment(extra: Record<string, string | undefined> = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OFFPEAK_ENV: "local",
    OFFPEAK_CHAIN_ID: "4663",
    OFFPEAK_RPC_URL: chain.rpcUrl,
    OFFPEAK_DEPLOYMENT_FILE: `${root}packages/abis/deployments/local.json`,
    OFFPEAK_DATABASE_URL: DATABASE,
    OFFPEAK_REDIS_URL: REDIS_URL,
    OFFPEAK_INTERNAL_TOKEN: "local-test-token-0123456789abcdef",
    OFFPEAK_INDEXER_URL: `http://127.0.0.1:${INDEXER_PORT}`,
    OFFPEAK_PUBLIC_BASE_URL: `http://127.0.0.1:${INDEXER_PORT}`,
    OFFPEAK_AUDITOR_KEY: auditorKey,
    OFFPEAK_AUDIT_SAMPLE_KEK: "ab".repeat(32),
    OFFPEAK_CANARY_ACCOUNTS_FILE: join(dataDir, "canary-accounts.json"),
    OFFPEAK_MODELS_FILE: join(dataDir, "models.json"),
    OFFPEAK_AUDITOR_PORT: String(AUDITOR_PORT),
    ...extra,
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 20_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check().catch(() => false)) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}\n${lines}`)
}

beforeAll(async () => {
  if (!hasServices) return
  dataDir = mkdtempSync(join(tmpdir(), "offpeak-auditor-"))
  writeFileSync(join(dataDir, "models.json"), JSON.stringify([{ name: "ofm-8b", digest: `0x${"ab".repeat(32)}`, contextLength: 8192, kind: "chat" }]))
  writeFileSync(join(dataDir, "canary-accounts.json"), JSON.stringify([{ wallet: `0xabab${"00".repeat(18)}`, label: "demo-account", apiKey: "op_live_sample", openedAt: 1, activeFrom: 0, activeTo: 23, weight: 1, dailyLimit: 50 }]))
  Bun.spawnSync([`${PG_BIN}initdb`, "-D", join(dataDir, "pg"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdout: "ignore", stderr: "ignore", env: pgEnv })
  Bun.spawnSync([`${PG_BIN}pg_ctl`, "-D", join(dataDir, "pg"), "-o", `-p ${PG_PORT} -c unix_socket_directories= -c listen_addresses=127.0.0.1`, "-l", join(dataDir, "pg.log"), "-w", "start"], { stdout: "ignore", stderr: "ignore", env: pgEnv })
  redisServer = Bun.spawn(["redis-server", "--port", String(REDIS_PORT), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdout: "ignore", stderr: "ignore" })
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 })
  redis.on("error", () => undefined)
  await waitFor(async () => (await redis.ping()) === "PONG", "redis")
  await redis.flushdb()
  redis.disconnect()
  chain = await startLocalChain(CHAIN_PORT)
  indexer = Bun.serve({ port: INDEXER_PORT, fetch: () => Response.json({ head: { block: 1, blockTs: 1, finalizedBlock: 1 }, data: [] }) })

  db = await openDb(DATABASE)
  const now = Math.floor(Date.now() / 1000)
  await db.query("INSERT INTO serving.audit_day_keys (id, day, wrapped, retire_at) VALUES ('day-1', 1, 'wrapped-key', to_timestamp($1))", [now - 60])
  await db.query("INSERT INTO serving.audit_samples (req_id, host, model_digest, enc_body, day_key_id, ts, created_at, expires_at) VALUES ('0xold','0xh','0xm','sealed','day-1',0,to_timestamp($1),to_timestamp($2))", [now - 200_000, now - 60])
  await db.query("INSERT INTO serving.audit_samples (req_id, host, model_digest, enc_body, day_key_id, ts, created_at, expires_at) VALUES ('0xnew','0xh','0xm','sealed','day-2',0,to_timestamp($1),to_timestamp($2))", [now, now + 3_600])
}, 240_000)

afterAll(async () => {
  service?.kill()
  await service?.exited
  indexer?.stop(true)
  chain?.stop()
  redisServer?.kill()
  await redisServer?.exited
  if (dataDir) {
    Bun.spawnSync([`${PG_BIN}pg_ctl`, "-D", join(dataDir, "pg"), "-m", "immediate", "stop"], { stdout: "ignore", stderr: "ignore", env: pgEnv })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

describe.skipIf(!hasServices)("the auditor as a real process", () => {
  test("refuses to start without its encryption key", async () => {
    const child = Bun.spawn(["bun", "run", "apps/auditor/src/main.ts"], { cwd: root, env: environment({ OFFPEAK_AUDIT_SAMPLE_KEK: undefined }), stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("OFFPEAK_AUDIT_SAMPLE_KEK")
  }, 30_000)

  test("refuses to start holding another role's key", async () => {
    const child = Bun.spawn(["bun", "run", "apps/auditor/src/main.ts"], { cwd: root, env: environment({ OFFPEAK_ROUTER_SIGNER_KEY: routerKey }), stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("OFFPEAK_ROUTER_SIGNER_KEY")
  }, 30_000)

  test("boots from its environment and serves health", async () => {
    service = Bun.spawn(["bun", "run", "apps/auditor/src/main.ts"], { cwd: root, env: environment(), stdout: "pipe", stderr: "pipe" })
    void (async () => {
      for await (const chunk of service!.stdout) lines += new TextDecoder().decode(chunk)
    })()
    await waitFor(async () => (await fetch(`http://127.0.0.1:${AUDITOR_PORT}/health`)).ok, "health")
    expect(lines).toContain('"event":"started"')
    expect(lines).not.toContain("op_live_sample")
    expect(lines).not.toContain("abababab")
  }, 30_000)

  test("every job is scheduled in BullMQ, on the configured Redis database", async () => {
    const queue = auditQueue(REDIS_URL)
    const schedulers = await queue.getJobSchedulers(0, 50)
    expect(schedulers.map((row) => row.key).sort()).toEqual(["bond", "coverage", "metering", "outcomes", "plan-canaries", "recalibrate", "refresh-accepted", "retention", "score", "sequential", "throughput"])
    await queue.close()
    const own = new Redis(REDIS_URL)
    const other = new Redis(`redis://127.0.0.1:${REDIS_PORT}/0`)
    expect((await own.keys("bull:offpeak-audit:*")).length).toBeGreaterThan(0)
    expect(await other.keys("bull:*")).toEqual([])
    own.disconnect()
    other.disconnect()
  }, 15_000)

  test("the retention job deletes expired bodies and destroys their key, and leaves live ones", async () => {
    await waitFor(async () => (await db.query("SELECT 1 FROM serving.audit_samples WHERE req_id = '0xold'")).rows.length === 0, "retention")
    expect((await db.query("SELECT 1 FROM serving.audit_samples WHERE req_id = '0xnew'")).rows).toHaveLength(1)
    expect((await db.query("SELECT 1 FROM serving.audit_day_keys WHERE id = 'day-1'")).rows).toHaveLength(0)
  }, 30_000)

  test("canary accounts reach the database without their keys", async () => {
    const rows = await db.query<{ wallet: string; label: string }>("SELECT * FROM serving.canary_accounts")
    expect(rows.rows).toHaveLength(1)
    expect(JSON.stringify(rows.rows)).not.toContain("op_live")
  })

  test("the low-bond alert shows on metrics and in the log", async () => {
    await waitFor(async () => (await (await fetch(`http://127.0.0.1:${AUDITOR_PORT}/metrics`)).text()).includes("auditor_bond_low 1"), "bond metric")
    await waitFor(async () => lines.includes('"event":"auditor_bond_low"'), "bond log")
  }, 30_000)

  test("a failing job is logged and the process keeps running", async () => {
    const queue = auditQueue(REDIS_URL)
    await queue.add("canary", { host: "0xnot-a-model", modelDigest: "0xnone", delayS: 0 })
    await queue.close()
    await Bun.sleep(300)
    expect((await fetch(`http://127.0.0.1:${AUDITOR_PORT}/health`)).ok).toBe(true)
  }, 15_000)

  test("SIGTERM closes it cleanly", async () => {
    service!.kill("SIGTERM")
    expect(await service!.exited).toBe(0)
    service = undefined
  }, 20_000)

  test("a restart picks the same schedules up again", async () => {
    service = Bun.spawn(["bun", "run", "apps/auditor/src/main.ts"], { cwd: root, env: environment(), stdout: "pipe", stderr: "pipe" })
    await waitFor(async () => (await fetch(`http://127.0.0.1:${AUDITOR_PORT}/health`)).ok, "health after restart")
    const queue = auditQueue(REDIS_URL)
    expect(await queue.getJobSchedulers(0, 50)).toHaveLength(11)
    await queue.close()
  }, 30_000)
})
