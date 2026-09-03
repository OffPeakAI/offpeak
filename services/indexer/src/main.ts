import { Metrics, encodePush, indexerEnv, log, makeClients, openDatabase, readDeployment } from "@offpeak/common"
import Redis from "ioredis"
import { createApi } from "./api.ts"
import { crossCheckBuyers } from "./crosscheck.ts"
import { newIngestState, tick } from "./ingest.ts"

const CROSS_CHECK_EVERY_MS = 5 * 60_000

const env = indexerEnv.parse(process.env)
const db = await openDatabase(env.OFFPEAK_DATABASE_URL)
const { reader } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID })
const { contracts } = readDeployment(env.OFFPEAK_DEPLOYMENT_FILE)
const metrics = new Metrics()
const redis = env.OFFPEAK_REDIS_URL ? new Redis(env.OFFPEAK_REDIS_URL) : null
const publish = async (msg: Record<string, unknown>) => {
  await redis?.publish("offpeak:chain", encodePush(msg))
}

Bun.serve({
  port: env.OFFPEAK_INDEXER_PORT,
  fetch: createApi({ db, reader, contracts, internalToken: env.OFFPEAK_INTERNAL_TOKEN, metrics }).fetch,
})
log("indexer", "listening", { port: env.OFFPEAK_INDEXER_PORT })

const state = newIngestState()
const deps = { db, reader, contracts, confirmations: env.OFFPEAK_CONFIRMATIONS, publish }
let lastCrossCheck = Date.now()

for (;;) {
  try {
    const reached = await tick(deps, state)
    metrics.set("indexer_head_lag_blocks", Number((await reader.getBlockNumber({ cacheTime: 0 })) - reached))
    if (Date.now() - lastCrossCheck > CROSS_CHECK_EVERY_MS) {
      lastCrossCheck = Date.now()
      await crossCheckBuyers({ db, reader, vault: contracts.OffpeakVault!, metrics })
    }
  } catch (err) {
    log("indexer", "tick_failed", { error: String(err) })
  }
  await Bun.sleep(1_000)
}
