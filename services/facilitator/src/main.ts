import { X402EscrowAbi } from "@offpeak/abis"
import { Metrics, assertKeySeparation, facilitatorEnv, log, makeClients, openDatabase, readDeployment, encodePush } from "@offpeak/common"
import IORedis from "ioredis"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { startMockFacilitator } from "../../mock-facilitator/src/main.ts"
import { facilitatorApp } from "./app.ts"
import { CaptureQueue } from "./capture.ts"
import { Denylist } from "./denylist.ts"
import { RelayBatcher } from "./settle.ts"

const CHAIN_CHANNEL = "offpeak:chain"

if (process.argv.includes("--mock")) {
  await startMockFacilitator()
} else {
  const env = facilitatorEnv.parse(process.env)
  assertKeySeparation(process.env, ["OFFPEAK_FACILITATOR_RELAY_KEY", "OFFPEAK_CAPTURER_KEY"])

  const relay = privateKeyToAccount(env.OFFPEAK_FACILITATOR_RELAY_KEY as Hex)
  const capturer = privateKeyToAccount(env.OFFPEAK_CAPTURER_KEY as Hex)
  const { reader, writer: relayWriter } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID, account: relay })
  const { writer: captureWriter } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID, account: capturer })
  const { contracts } = readDeployment(env.OFFPEAK_DEPLOYMENT_FILE)
  if (!contracts.X402Escrow || !contracts.OffpeakVault) throw new Error("this deployment has no agent payment contracts yet")
  const usdg = await reader.readContract({ address: contracts.X402Escrow, abi: X402EscrowAbi, functionName: "usdg" })

  const db = await openDatabase(env.OFFPEAK_DATABASE_URL)
  const metrics = new Metrics()
  const redis = new IORedis(env.OFFPEAK_REDIS_URL, { maxRetriesPerRequest: null })
  const denylist = new Denylist(env.OFFPEAK_DENYLIST_URL)
  await denylist.start()

  const publish = async (msg: Record<string, unknown>) => {
    await redis.publish(CHAIN_CHANNEL, encodePush(msg))
  }
  const batcher = new RelayBatcher({
    db,
    reader,
    writer: relayWriter!,
    account: relay,
    escrow: contracts.X402Escrow,
    metrics,
    publish,
    nativeUsd: env.OFFPEAK_NATIVE_USD,
    flushMs: env.OFFPEAK_AUTHORIZE_FLUSH_MS,
  })
  const captures = new CaptureQueue({
    reader,
    writer: captureWriter!,
    account: capturer,
    escrow: contracts.X402Escrow,
    metrics,
    redisUrl: env.OFFPEAK_REDIS_URL,
    nativeUsd: env.OFFPEAK_NATIVE_USD,
    flushMs: env.OFFPEAK_CAPTURE_FLUSH_MS,
  })
  batcher.start()
  captures.start()

  const app = facilitatorApp({
    verify: {
      db,
      reader,
      usdg,
      vault: contracts.OffpeakVault,
      escrow: contracts.X402Escrow,
      relay: relay.address,
      relayFloorWei: env.OFFPEAK_RELAY_FLOOR_WEI,
      denylist,
    },
    db,
    batcher,
    captures,
    internalToken: env.OFFPEAK_INTERNAL_TOKEN,
    metrics,
  })
  Bun.serve({ port: env.OFFPEAK_FACILITATOR_PORT, fetch: app.fetch })
  log("facilitator", "started", { port: env.OFFPEAK_FACILITATOR_PORT, relay: relay.address, capturer: capturer.address })
}
