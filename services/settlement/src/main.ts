import {
  Metrics,
  assertKeySeparation,
  log,
  makeClients,
  openDatabase,
  readDeployment,
  serveMetrics,
  settlementEnv,
} from "@offpeak/common"
import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { perfPass, refundPass, rewardPass, settlementTick } from "./worker.ts"

const TICK_MS = 5_000

const flag = process.argv.indexOf("--index")
if (flag > -1) process.env.OFFPEAK_SETTLER_INDEX = process.argv[flag + 1]

const env = settlementEnv.parse(process.env)
assertKeySeparation(process.env, "OFFPEAK_SETTLER_KEY")

const account = privateKeyToAccount(env.OFFPEAK_SETTLER_KEY as Hex)
const { reader, writer } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID, account })
const deps = {
  db: await openDatabase(env.OFFPEAK_DATABASE_URL),
  reader,
  writer: writer!,
  account,
  chainId: env.OFFPEAK_CHAIN_ID,
  contracts: readDeployment(env.OFFPEAK_DEPLOYMENT_FILE).contracts,
  routerAddress: env.OFFPEAK_ROUTER_ADDRESS as Address,
  settlers: env.OFFPEAK_SETTLER_ADDRESSES as Address[],
  metrics: new Metrics(),
}
if (env.OFFPEAK_METRICS_PORT) serveMetrics(deps.metrics, env.OFFPEAK_METRICS_PORT)
log("settlement", "started", { index: env.OFFPEAK_SETTLER_INDEX, signer: account.address })

for (;;) {
  try {
    const result = await settlementTick(deps)
    await refundPass(deps)
    await perfPass(deps)
    await rewardPass(deps)
    log("settlement", "tick", result)
  } catch (err) {
    log("settlement", "tick_failed", { error: String(err).slice(0, 300) })
  }
  await Bun.sleep(TICK_MS)
}
