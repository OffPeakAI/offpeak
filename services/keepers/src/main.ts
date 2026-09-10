import { Metrics, assertKeySeparation, keeperEnv, log, makeClients, openDatabase, readDeployment } from "@offpeak/common"
import { Queue, Worker } from "bullmq"
import Redis from "ioredis"
import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { runChallengeFinalize, runForfeitSweep, runRefundClaims } from "./jobs/challenges.ts"
import { runChannelClaim, runChannelExpiry, runCloseWatch } from "./jobs/channels.ts"
import { runBurn, runFeeDistribute } from "./jobs/fee-distribute.ts"
import { GasBurn, runGasWatch } from "./jobs/gas-watch.ts"
import { runHostActivate } from "./jobs/host-activate.ts"
import { runWithdrawAll } from "./jobs/withdraw-all.ts"
import { runX402Expire } from "./jobs/x402-expire.ts"

const QUEUE = "offpeak-keepers"
const MINUTE = 60_000

const env = keeperEnv.parse(process.env)
assertKeySeparation(process.env, "OFFPEAK_KEEPER_KEY")

const account = privateKeyToAccount(env.OFFPEAK_KEEPER_KEY as Hex)
const { reader, writer } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID, account })
const deps = {
  db: await openDatabase(env.OFFPEAK_DATABASE_URL),
  reader,
  writer: writer!,
  account,
  contracts: readDeployment(env.OFFPEAK_DEPLOYMENT_FILE).contracts,
  metrics: new Metrics(),
}
const watched: Record<string, Address> = { keeper: account.address }
if (env.OFFPEAK_RELAY_ADDRESS) watched.relay = env.OFFPEAK_RELAY_ADDRESS as Address
if (env.OFFPEAK_CAPTURER_ADDRESS) watched.capturer = env.OFFPEAK_CAPTURER_ADDRESS as Address
const redis = { url: env.OFFPEAK_REDIS_URL }

const CLOSE_WATCH = "channel-close-watch"
const burn = new GasBurn()
const jobs: Record<string, { every?: number; pattern?: string; run: (data?: { channelId?: Hex }) => Promise<unknown> }> = {
  "withdraw-all": { every: MINUTE, run: () => runWithdrawAll(deps) },
  "host-activate": { every: 10 * MINUTE, run: () => runHostActivate(deps) },
  "gas-watch": { every: 5 * MINUTE, run: () => runGasWatch(deps, watched, burn) },
  "fee-distribute": {
    pattern: "0 1 * * *",
    run: async () => ({ fees: await runFeeDistribute(deps), burn: await runBurn(deps, env.OFFPEAK_BURN_MIN_OFPK_PER_USDG) }),
  },
  "challenge-finalize": { every: 5 * MINUTE, run: () => runChallengeFinalize(deps) },
  "refund-claims": { every: 10 * MINUTE, run: () => runRefundClaims(deps) },
  "forfeit-sweep": { every: 10 * MINUTE, run: () => runForfeitSweep(deps) },
  "channel-claim": { every: MINUTE, run: () => runChannelClaim(deps) },
  [CLOSE_WATCH]: { every: MINUTE, run: (data) => runCloseWatch(deps, data?.channelId) },
  "channel-expiry": { every: 10 * MINUTE, run: () => runChannelExpiry(deps) },
  "x402-expire": { every: 5 * MINUTE, run: () => runX402Expire(deps) },
}

const queue = new Queue(QUEUE, { connection: redis })
for (const [name, job] of Object.entries(jobs)) {
  await queue.upsertJobScheduler(name, job.pattern ? { pattern: job.pattern, tz: "UTC" } : { every: job.every! }, { name })
}

new Worker(
  QUEUE,
  async (job) => {
    const result = await jobs[job.name]?.run(job.data)
    log("keepers", "job_done", { job: job.name, result })
  },
  { connection: redis },
)

// Every chain write goes through the one worker, so a push cannot race a scheduled job for a nonce.
const pushes = new Redis(env.OFFPEAK_REDIS_URL)
await pushes.subscribe("offpeak:chain")
pushes.on("message", (_channel, raw) => {
  const message = JSON.parse(raw) as { type: string; channelId?: Hex }
  if (message.type === "CloseRequested") void queue.add(CLOSE_WATCH, { channelId: message.channelId }, { priority: 1 })
})
log("keepers", "started", { jobs: Object.keys(jobs) })
