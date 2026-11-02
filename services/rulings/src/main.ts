import { assertKeySeparation, log, makeClients, openDatabase, readDeployment, rulingEnv } from "@offpeak/common"
import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { rulingTick } from "./review.ts"

const TICK_MS = 30_000

const flag = process.argv.indexOf("--index")
if (flag > -1) process.env.OFFPEAK_RULING_INDEX = process.argv[flag + 1]

const env = rulingEnv.parse(process.env)
assertKeySeparation(process.env, "OFFPEAK_RULING_KEY")

const account = privateKeyToAccount(env.OFFPEAK_RULING_KEY as Hex)
const { reader, writer } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID, account })
const deps = {
  db: await openDatabase(env.OFFPEAK_DATABASE_URL),
  reader,
  writer: writer!,
  account,
  contracts: readDeployment(env.OFFPEAK_DEPLOYMENT_FILE).contracts,
  rulers: env.OFFPEAK_RULER_ADDRESSES as Address[],
  auditor: env.OFFPEAK_AUDITOR_ADDRESS as Address,
  chainId: env.OFFPEAK_CHAIN_ID,
}
log("rulings", "started", { index: env.OFFPEAK_RULING_INDEX, signer: account.address })

for (;;) {
  try {
    log("rulings", "tick", { results: await rulingTick(deps) })
  } catch (err) {
    log("rulings", "tick_failed", { error: String(err).slice(0, 300) })
  }
  await Bun.sleep(TICK_MS)
}
