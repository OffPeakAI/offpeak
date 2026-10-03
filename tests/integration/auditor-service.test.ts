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
