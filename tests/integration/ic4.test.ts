import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import Redis from "ioredis"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex, type HDAccount, type PublicClient } from "viem"
import { closeHour } from "../../apps/router/src/metering/hourclose.ts"
import { bootStack } from "../../apps/router/test/support/stack.ts"
import { ChannelManagerAbi, HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi, X402EscrowAbi } from "../../packages/abis/src/index.ts"
import { PERMIT2, channelAuthHeader, domain, hourEnd, hourIndex, permitWitnessTypes, voucherTypes } from "../../packages/shared/src/index.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { Metrics, applySchemas, encodePush, type Db } from "../../services/common/src/index.ts"
import { facilitatorApp } from "../../services/facilitator/src/app.ts"
import { CaptureQueue } from "../../services/facilitator/src/capture.ts"
import { Denylist } from "../../services/facilitator/src/denylist.ts"
import { RelayBatcher } from "../../services/facilitator/src/settle.ts"
import { createApi } from "../../services/indexer/src/api.ts"
import { newIngestState, tick, type IngestDeps } from "../../services/indexer/src/ingest.ts"
import { runChannelClaim, runChannelExpiry, runCloseWatch } from "../../services/keepers/src/jobs/channels.ts"
import type { KeeperDeps } from "../../services/keepers/src/jobs/types.ts"
import { runX402Expire } from "../../services/keepers/src/jobs/x402-expire.ts"
import { settlementTick, type WorkerDeps } from "../../services/settlement/src/worker.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29554
const API_PORT = PORT + 100
const FAC_PORT = PORT + 101
const PROXY_PORT = 29555
const TOKEN = "local-test-token-0123456789abcdef"
const CLOSE_GRACE = 600
const CALLS = 1_000
const RACES = 100
const TTFT_SLO_MS = 1_500
const MAX_AUTHORIZATION = 1_000_000n
// Its own database, flushed first, so queue jobs left by an earlier run cannot leak in.
const REDIS = "redis://127.0.0.1:6379/10"

const router = roleAccount("router")
const host = roleAccount("host").address.toLowerCase() as Address
const agent = anvilAccount(19)
const relay = anvilAccount(11)
const capturer = anvilAccount(12)
const keeperAccount = anvilAccount(13)
const signerAccounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]

let chain: LocalChain
let booted: Awaited<ReturnType<typeof bootStack>>
let db: Db
let reader: PublicClient
let api: ReturnType<typeof createApi>
let apiServer: ReturnType<typeof Bun.serve>
let facServer: ReturnType<typeof Bun.serve>
let ingest: IngestDeps
let workers: WorkerDeps[]
let keeper: KeeperDeps
let batcher: RelayBatcher
let captures: CaptureQueue
let fac: ReturnType<typeof facilitatorApp>
const ingestState = newIngestState()
const metrics = new Metrics()
const pushes: Record<string, unknown>[] = []
const facilitatorPushes: Record<string, unknown>[] = []
let salts = 0

const contract = (name: string) => chain.contracts[name]!

async function rpc(method: string, params: unknown[] = []) {
  await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

async function chainTime() {
  return Number((await reader.getBlock({ blockTag: "latest" })).timestamp)
}

async function mineAt(ts: number) {
  await rpc("evm_setNextBlockTimestamp", [ts])
  await rpc("evm_mine")
  booted.stack.setClock(ts)
}

async function send(account: HDAccount | Address, address: Address, abi: unknown, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe("success")
  return receipt
}

const readVault = <T>(functionName: string, args: unknown[] = []) =>
  reader.readContract({ address: contract("OffpeakVault"), abi: OffpeakVaultAbi, functionName, args } as never) as Promise<T>
const channelOf = (id: Hex) => reader.readContract({ address: contract("ChannelManager"), abi: ChannelManagerAbi, functionName: "channelView", args: [id] })
const escrowOf = (reqId: Hex) => reader.readContract({ address: contract("X402Escrow"), abi: X402EscrowAbi, functionName: "escrowView", args: [reqId] })
const usdgOf = (who: Address) => reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [who] })

async function idx<T>(path: string) {
  const res = await api.request(path, { headers: { authorization: `Bearer ${TOKEN}` } })
  return ((await res.json()) as { data: T }).data
}

async function settle(hour: number) {
  for (let pass = 0; pass < 4; pass++) {
    await tick(ingest, ingestState)
    if (Number(await readVault<bigint>("lastSettledHour")) >= hour) break
    for (const worker of workers) await settlementTick(worker)
  }
  await tick(ingest, ingestState)
  expect(Number(await readVault<bigint>("lastSettledHour"))).toBe(hour)
}

async function settleThrough(hour: number) {
  for (let h = Number(await readVault<bigint>("lastSettledHour")) + 1; h <= hour; h++) {
    const closeAt = hourEnd(h) + CLOSE_GRACE
    if ((await chainTime()) < closeAt) await mineAt(closeAt)
    await closeHour(booted.stack.db, h, router as never, contract("UsageLedger"))
    await settle(h)
  }
}

async function openChannel(deposit: bigint, lifetime = 3 * 86_400) {
  const salt = keccak256(toBytes(`channel-${salts++}`))
  await send(agent, contract("ChannelManager"), ChannelManagerAbi, "open", [deposit, BigInt((await chainTime()) + lifetime), salt])
  const logs = await reader.getContractEvents({ address: contract("ChannelManager"), abi: ChannelManagerAbi, eventName: "ChannelOpened", fromBlock: "earliest" })
  const id = logs.at(-1)!.args.channelId!
  await tick(ingest, ingestState)
  return id
}

function signVoucher(id: Hex, seq: bigint, cumulative: bigint) {
  return agent.signTypedData({
    domain: domain("OffpeakChannel", contract("ChannelManager")),
    types: voucherTypes,
    primaryType: "Voucher",
    message: { channelId: id, seq, cumulative },
  } as never)
}

async function channelCall(id: Hex, voucher?: { seq: bigint; cumulative: bigint; sig: Hex }) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-offpeak-channel": id }
  if (voucher) {
    headers["x-offpeak-voucher"] = Buffer.from(
      JSON.stringify({ seq: voucher.seq.toString(), cumulative: voucher.cumulative.toString(), sig: voucher.sig }),
    ).toString("base64url")
  }
  const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "hello" }], max_tokens: 16 })
  headers["x-offpeak-channel-auth"] = await channelAuthHeader(agent, { channelId: id, ts: booted.stack.clock(), body })
  const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers, body })
  expect(res.status).toBe(200)
  await res.text()
  return BigInt(res.headers.get("x-offpeak-channel-owed")!)
}

async function runCalls(id: Hex, count: number, onEach?: (done: number) => Promise<void>) {
  let seq = 0n
  let voucher: { seq: bigint; cumulative: bigint; sig: Hex } | undefined
  for (let done = 1; done <= count; done++) {
    const owed = await channelCall(id, voucher)
    seq += 1n
    voucher = { seq, cumulative: owed, sig: await signVoucher(id, seq, owed) }
    await onEach?.(done)
  }
}

async function signExact(reqId: Hex, nonce: bigint, amount: bigint) {
  const validBefore = BigInt((await chainTime()) + 600)
  const witness = { reqId, payee: contract("OffpeakVault"), amount, validBefore, resourceHash: keccak256(toBytes("resource")) }
  const message = {
    permitted: { token: contract("MockUSDG"), amount },
    spender: contract("X402Escrow"),
    nonce,
    deadline: BigInt((await chainTime()) + 900),
    witness,
  }
  const signature = await agent.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Address },
    types: permitWitnessTypes("ExactWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  } as never)
  return {
    x402Version: 2,
    scheme: "exact",
    payload: {
      signature,
      witness: { ...witness, amount: amount.toString(), validBefore: validBefore.toString() },
      permitted: { token: contract("MockUSDG"), amount: amount.toString() },
      spender: contract("X402Escrow"),
      nonce: nonce.toString(),
      deadline: message.deadline.toString(),
    },
  }
}

async function signPayment(reqId: Hex, nonce: bigint, signer: HDAccount = agent, max = MAX_AUTHORIZATION) {
  const validBefore = BigInt((await chainTime()) + 600)
  const witness = { reqId, payee: contract("OffpeakVault"), maxAmount: max, validBefore, resourceHash: keccak256(toBytes("resource")) }
  const message = {
    permitted: { token: contract("MockUSDG"), amount: max },
    spender: contract("X402Escrow"),
    nonce,
    deadline: BigInt((await chainTime()) + 900),
    witness,
  }
  const signature = await signer.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Address },
    types: permitWitnessTypes("UptoWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  } as never)
  return {
    x402Version: 2,
    scheme: "upto",
    payload: {
      signature,
      witness: { ...witness, maxAmount: max.toString(), validBefore: validBefore.toString() },
      permitted: { token: contract("MockUSDG"), amount: max.toString() },
      spender: contract("X402Escrow"),
      nonce: nonce.toString(),
      deadline: message.deadline.toString(),
    },
  }
}

const facilitatorCall = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fac.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  return (await res.json()) as Record<string, unknown>
}

const requirements = () => ({ payTo: contract("OffpeakVault"), asset: contract("MockUSDG"), maxAmountRequired: "100000" })

async function until(check: () => Promise<boolean>, what: string, ms = 15_000) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A slow, flaky link. Half of its failures lose the response after the node has already acted on the call. */
function flakyRpc(target: string) {
  return Bun.serve({
    port: PROXY_PORT,
    async fetch(req) {
      const body = await req.text()
      await Bun.sleep(Math.random() * 40)
      const roll = Math.random()
      if (roll < 0.05) return new Response("overloaded", { status: 503 })
      const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body })
      return roll < 0.1 ? new Response("lost", { status: 503 }) : response
    },
  })
}

beforeAll(async () => {
  const redis = new Redis(REDIS)
  await redis.flushdb()
  redis.disconnect()
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 20 }) as PublicClient
  booted = await bootStack({ live: { indexerUrl: `http://127.0.0.1:${API_PORT}`, facilitatorUrl: `http://127.0.0.1:${FAC_PORT}`, token: TOKEN } })
  db = booted.stack.db
  await applySchemas(db, { shared: false })
  process.env.OFFPEAK_INTERNAL_TOKEN = TOKEN

  const bond = 2_000_000_000n
  await send(host, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), bond])
  await send(host, contract("HostRegistry"), HostRegistryAbi, "register", [
    {
      modelDigests: [booted.modelDigest],
      maxTps: [100],
      imageDigest: booted.imageDigest,
      gpuClass: keccak256(toBytes("h100-80g-sxm")),
      endpointHash: keccak256(toBytes("http://host.local")),
      attestationRef: `0x${"00".repeat(32)}`,
      bondUsdg: bond,
      bondOfpk: 0n,
    },
  ])
  await send(agent, contract("MockUSDG"), MockUSDGAbi, "mint", [agent.address, 1_000_000_000n])
  await send(agent, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("ChannelManager"), 1_000_000_000n])
  await send(agent, contract("MockUSDG"), MockUSDGAbi, "approve", [PERMIT2, 1_000_000_000n])

  ingest = {
    db,
    reader,
    contracts: chain.contracts,
    confirmations: 1,
    publish: (msg) => {
      pushes.push(msg)
      booted.chain!.push(JSON.parse(encodePush(msg)))
    },
  }
  await tick(ingest, ingestState)
  api = createApi({ db, reader, contracts: chain.contracts, internalToken: TOKEN, metrics })
  apiServer = Bun.serve({ port: API_PORT, fetch: api.fetch })
  workers = signerAccounts.map((account) => ({
    db,
    reader,
    writer: createWalletClient({ account, transport: http(chain.rpcUrl), chain: null }) as never,
    account: account as never,
    chainId: 4663,
    contracts: chain.contracts,
    routerAddress: router.address,
    settlers: signerAccounts.map((s) => s.address),
    metrics,
  }))
  keeper = {
    db,
    reader,
    writer: createWalletClient({ account: keeperAccount, transport: http(chain.rpcUrl), chain: null }) as never,
    account: keeperAccount as never,
    contracts: chain.contracts,
    metrics,
  }

  const publish = (msg: Record<string, unknown>) => {
    facilitatorPushes.push(msg)
    booted.chain!.push(JSON.parse(encodePush(msg)))
  }
  batcher = new RelayBatcher({
    db,
    reader,
    writer: createWalletClient({ account: relay, transport: http(chain.rpcUrl), chain: null }) as never,
    account: relay,
    escrow: contract("X402Escrow"),
    metrics,
    publish,
    nativeUsd: 3_000,
    flushMs: 20,
  })
  captures = new CaptureQueue({
    reader,
    writer: createWalletClient({ account: capturer, transport: http(chain.rpcUrl), chain: null }) as never,
    account: capturer,
    escrow: contract("X402Escrow"),
    metrics,
    redisUrl: REDIS,
    nativeUsd: 3_000,
    flushMs: 50,
  })
  batcher.start()
  captures.start()
  fac = facilitatorApp({
    verify: {
      db,
      reader,
      usdg: contract("MockUSDG"),
      vault: contract("OffpeakVault"),
      escrow: contract("X402Escrow"),
      relay: relay.address,
      relayFloorWei: 1n,
      denylist: new Denylist(),
    },
    db,
    batcher,
    captures,
    internalToken: TOKEN,
    metrics,
  })
  facServer = Bun.serve({ port: FAC_PORT, fetch: fac.fetch })
}, 180_000)

afterAll(async () => {
  apiServer?.stop(true)
  facServer?.stop(true)
  batcher?.stop()
  await captures?.stop()
  chain?.stop()
})

describe("IC4", () => {
  let hour = 0
  let channel: Hex
  let claimedOnChain = 0n

  test("an agent opens a channel, makes 1,000 calls, and the keeper claims as it goes", async () => {
    const start = hourEnd(hourIndex(await chainTime())) + 5
    hour = hourIndex(start)
    await mineAt(start)
    channel = await openChannel(50_000_000n)

    const checkpoints = new Set([250, 500, 750])
    await runCalls(channel, CALLS, async (done) => {
      if (!checkpoints.has(done)) return
      await mineAt((await chainTime()) + 301)
      expect(await runChannelClaim(keeper)).toEqual([channel])
      await tick(ingest, ingestState)
      const onChain = await channelOf(channel)
      expect(onChain.claimed).toBeGreaterThan(claimedOnChain)
      claimedOnChain = onChain.claimed
    })
