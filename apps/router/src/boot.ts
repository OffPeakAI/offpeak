import { readFileSync } from "node:fs"
import { readDeployment, routerEnv } from "@offpeak/common"
import { HOUR_CLOSE_GRACE_S, PERMIT2, hourIndex, keepSigners, type Hex } from "@offpeak/shared"
import Redis from "ioredis"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import { createApp } from "./app.ts"
import { LiveChain } from "./chainview/live.ts"
import { subscribePushes, watchChain } from "./chainview/push.ts"
import { deployedFlags, type ModelEntry, type Stack } from "./context.ts"
import { assertKeySeparation } from "./env.ts"
import { closeHour } from "./metering/hourclose.ts"
import { loadTokenizers } from "./metering/tokenize.ts"
import { recordLoad, trimLoad } from "./offpeak/forecast.ts"
import { sweepFiles } from "./openai/files.ts"
import { sweepCaptures, sweepExact } from "./pay/captures.ts"
import { sweepCloses } from "./pay/channel-store.ts"
import { LiveFacilitator } from "./pay/facilitator.ts"
import { RedisCounters, RedisHolds, rebuildSpend } from "./pay/redis-holds.ts"
import { rpcWallets } from "./pay/signatures.ts"
import { WindowPerf, sweepWindows } from "./pay/window-perf.ts"
import { LoadMeter } from "./pricing/load.ts"
import { loadSheets } from "./pricing/sheets.ts"
import { writeHostStats } from "./pricing/stats.ts"
import { AttestBook, readAttestConfig, sweepAttestations } from "./routing/attest.ts"
import { loadEndpoints, probeHosts } from "./routing/probes.ts"
import { openDb } from "./store.ts"

const PROBE_EVERY_MS = 10_000
const REFRESH_EVERY_MS = 5_000
const HOUR_CLOSE_EVERY_MS = 60_000
const SIGNER_IDLE_MS = 3_600_000
const SWEEP_EVERY_MS = 5_000
const WINDOW_EVERY_MS = 15_000
const LOAD_EVERY_MS = 15_000
const ATTEST_EVERY_MS = 30_000
const RETENTION_EVERY_MS = 3_600_000
const STATS_EVERY_MS = 3_600_000

const modelsFile = z.array(
  z.object({
    name: z.string().min(1),
    digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex),
    contextLength: z.int().positive(),
    kind: z.enum(["chat", "embeddings"]),
    tokenizer: z.object({ manifest: z.string().min(1), dir: z.string().min(1) }).optional(),
    sealedBytesPerToken: z.object({ low: z.number().positive(), high: z.number().positive() }).refine((range) => range.low <= range.high).optional(),
  }),
)

/** The contract only takes a close signed by its payee, so a key for any other address could only revert. */
export function payeeAccount(key: string | undefined, payee: string) {
  if (!key) return undefined
  const account = { ...privateKeyToAccount(key as Hex), localKey: key as Hex }
  if (account.address.toLowerCase() !== payee.toLowerCase()) throw new Error("OFFPEAK_CHANNEL_PAYEE_KEY is not the key of OFFPEAK_CHANNEL_PAYEE")
  return account
}

export async function bootRouter(source: NodeJS.ProcessEnv = process.env) {
  assertKeySeparation(source, ["OFFPEAK_ROUTER_SIGNER_KEY", "OFFPEAK_CHANNEL_PAYEE_KEY"])
  const env = routerEnv.parse(source)
  const payee = payeeAccount(env.OFFPEAK_CHANNEL_PAYEE_KEY, env.OFFPEAK_CHANNEL_PAYEE)
  keepSigners(SIGNER_IDLE_MS)
  const models: ModelEntry[] = modelsFile.parse(JSON.parse(readFileSync(env.OFFPEAK_MODELS_FILE, "utf8")))
  loadTokenizers(models, env.OFFPEAK_ENV === "mainnet")
  const db = await openDb(env.OFFPEAK_DATABASE_URL)
  const redis = new Redis(env.OFFPEAK_REDIS_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true })
  const { contracts } = readDeployment(env.OFFPEAK_DEPLOYMENT_FILE)
  const endpoints = await loadEndpoints(db)
  const chain = new LiveChain({ url: env.OFFPEAK_INDEXER_URL, token: env.OFFPEAK_INTERNAL_TOKEN, endpointOf: (host) => endpoints.get(host.toLowerCase()) })
  const contract = (name: string) => {
    const address = contracts[name]
    if (!address) throw new Error(`deployment has no ${name}`)
    return address
  }
  const clock = () => Math.floor(Date.now() / 1000)
  const stack: Stack = {
    clock,
    setClock: () => undefined,
    ledger: new RedisHolds(redis),
    counters: new RedisCounters(redis),
    indexer: chain,
    facilitator: new LiveFacilitator({ url: env.OFFPEAK_FACILITATOR_URL, token: env.OFFPEAK_INTERNAL_TOKEN }),
    hosts: {
      request: (_host, endpoint, path, init) => {
        if (!endpoint) throw new Error("host has no endpoint")
        return fetch(`${endpoint}${path}`, init)
      },
    },
    models,
    sheets: await loadSheets(db),
    load: new LoadMeter(),
    router: { ...privateKeyToAccount(env.OFFPEAK_ROUTER_SIGNER_KEY as Hex), localKey: env.OFFPEAK_ROUTER_SIGNER_KEY as Hex },
    payee,
    db,
    probesOk: new Set(),
    nightModels: new Map(),
    ttftFailoverMs: 3_000,
    preconfirmTimeoutMs: 15_000,
    usageLedger: contract("UsageLedger"),
    registry: contract("HostRegistry"),
    vault: contract("OffpeakVault"),
    channelManager: contracts.ChannelManager ?? "",
    channelPayee: env.OFFPEAK_CHANNEL_PAYEE,
    escrow: contracts.X402Escrow ?? "",
    windowMarket: contracts.WindowMarket ?? "",
    auditCourt: contracts.AuditCourt ?? "",
    usdg: contracts.MockUSDG ?? env.OFFPEAK_USDG_ADDRESS ?? contract("USDG"),
    permit2: (contracts.Permit2 ?? PERMIT2) as Hex,
    log: [],
    preHostMs: [],
    authWaiters: new Map(),
    authResults: new Map(),
    candidateCache: new Map(),
    wallets: env.OFFPEAK_RPC_URL ? rpcWallets(env.OFFPEAK_RPC_URL) : undefined,
    windowPerf: new WindowPerf(clock),
    windowShares: new Map(),
    flags: deployedFlags(contracts),
    attest: new AttestBook(readAttestConfig(env, env.OFFPEAK_ENV === "mainnet")),
    internalToken: env.OFFPEAK_INTERNAL_TOKEN,
    production: env.OFFPEAK_ENV === "mainnet",
    siweDomain: new URL(env.OFFPEAK_PUBLIC_BASE_URL).host,
  }
  await rebuildSpend(db, redis, hourIndex(stack.clock()) - 48)
  watchChain(stack)
  const pushes = subscribePushes(env.OFFPEAK_REDIS_URL, chain)
  const app = createApp(stack)
