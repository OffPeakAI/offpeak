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

const facilitatorCall = async (path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => {
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

    await mineAt((await chainTime()) + 301)
    await runChannelClaim(keeper)
    await tick(ingest, ingestState)
    const view = await channelOf(channel)
    claimedOnChain = view.claimed
    expect(view.lastSeq).toBe(BigInt(CALLS - 1))

    const state = await db.query<{ claimed: string; cumulative: string }>("SELECT claimed, cumulative FROM shared.channel_state WHERE channel_id = $1", [channel])
    expect(BigInt(state.rows[0]!.claimed)).toBe(claimedOnChain)
    expect(BigInt(state.rows[0]!.cumulative)).toBe(claimedOnChain)

    const payments = await db.query<{ n: string; sum: string; uncollected: string }>(
      "SELECT count(*) AS n, sum(amount_micro) AS sum, count(*) FILTER (WHERE collected_tx IS NULL) AS uncollected FROM shared.agent_payments WHERE channel_id = $1",
      [channel],
    )
    expect(Number(payments.rows[0]!.n)).toBe(CALLS - 1)
    expect(BigInt(payments.rows[0]!.sum)).toBe(claimedOnChain)
    expect(Number(payments.rows[0]!.uncollected)).toBe(0)
    expect(await readVault<bigint>("agentPool")).toBe(claimedOnChain)
  }, 300_000)

  test("settlement draws every collected unit and pays the host", async () => {
    await settleThrough(hour)
    expect(await readVault<bigint>("agentPool")).toBe(0n)
    const undrawn = await db.query("SELECT 1 FROM shared.agent_payments WHERE channel_id = $1 AND drawn_hour IS NULL", [channel])
    expect(undrawn.rows).toHaveLength(0)
    const settled = await db.query<{ credited: string; fees: string }>("SELECT credited, fees FROM chain.settlements WHERE hour = $1", [hour])
    expect(BigInt(settled.rows[0]!.credited) + BigInt(settled.rows[0]!.fees)).toBe(claimedOnChain)
    expect(metrics.get("settlement_signer_disagreement_total")).toBe(0)
  }, 120_000)

  test("upto reaches the first token inside the SLO, then authorizes and captures on chain", async () => {
    const start = hourEnd(hour) + CLOSE_GRACE + 60
    const next = hourIndex(start)
    await mineAt(Math.max(start, (await chainTime()) + 1))
    const before = await usdgOf(agent.address)
    const ttft: number[] = []
    const reqIds: Hex[] = []
    for (let i = 0; i < 20; i++) {
      const reqId = keccak256(toBytes(`upto-${i}`))
      reqIds.push(reqId)
      const payment = await signPayment(reqId, BigInt(1_000 + i))
      const started = performance.now()
      const res = await booted.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": JSON.stringify(payment) },
        body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream: true }),
      })
      expect(res.status).toBe(200)
      const reader_ = res.body!.getReader()
      await reader_.read()
      ttft.push(performance.now() - started)
      while (!(await reader_.read()).done);
    }
    ttft.sort((a, b) => a - b)
    expect(ttft[18]!).toBeLessThan(TTFT_SLO_MS)

    await until(async () => (await Promise.all(reqIds.map(escrowOf))).every((e) => e.status === 2), "captures")
    const escrows = await Promise.all(reqIds.map(escrowOf))
    const captured = escrows.reduce((sum, e) => sum + e.captured, 0n)
    expect(captured).toBeGreaterThan(0n)
    expect(await readVault<bigint>("agentPool")).toBe(captured)
    expect(await usdgOf(contract("X402Escrow"))).toBe(0n)
    expect(await usdgOf(agent.address)).toBe(before - captured)
    expect(facilitatorPushes.filter((m) => m.type === "Authorized")).toHaveLength(20)

    const status = await (await fac.request(`/x402/status/${reqIds[0]}`)).json()
    expect(status.status).toBe("confirmed")
    await tick(ingest, ingestState)
    const view = await idx<{ status: string; captured: string }>(`/idx/v1/escrows/${reqIds[0]}`)
    expect(view).toMatchObject({ status: "captured", captured: escrows[0]!.captured.toString() })

    await settleThrough(next)
    expect(await readVault<bigint>("agentPool")).toBe(0n)
    hour = next
  }, 120_000)

  test("one bad payment does not sink a batch, and the router hears about it", async () => {
    const good = keccak256(toBytes("batch-good"))
    const bad = keccak256(toBytes("batch-bad"))
    const goodPayment = await signPayment(good, 2_000n)
    // Both pass verify on the same Permit2 nonce, the way a racing wallet would, so the second burns in the batch.
    const badPayment = await signPayment(bad, 2_000n)
    expect(await facilitatorCall("/x402/verify", { paymentPayload: goodPayment, paymentRequirements: requirements() })).toMatchObject({ isValid: true })
    expect(await facilitatorCall("/x402/verify", { paymentPayload: badPayment, paymentRequirements: requirements() })).toMatchObject({ isValid: true })
    await facilitatorCall("/x402/settle", { paymentPayload: goodPayment, mode: "authorize" })
    await facilitatorCall("/x402/settle", { paymentPayload: badPayment, mode: "authorize" })
    await until(async () => (await escrowOf(good)).status === 1, "the good escrow")
    await until(async () => facilitatorPushes.some((m) => m.type === "AuthorizeFailed" && m.reqId === bad), "the failure push")
    expect((await escrowOf(bad)).status).toBe(0)
    const replay = await facilitatorCall("/x402/settle", { paymentPayload: goodPayment, mode: "authorize" })
    expect(replay).toMatchObject({ success: false, errorReason: "already_settled" })
    expect(await facilitatorCall("/x402/verify", { paymentPayload: goodPayment, paymentRequirements: requirements() })).toMatchObject({ isValid: false })

    await facilitatorCall("/x402/capture", { reqId: good, actual: "1000" }, { authorization: `Bearer ${TOKEN}` })
    await until(async () => (await escrowOf(good)).status === 2, "the capture")
  }, 60_000)

  test("a capture that already landed does not sink the live one beside it", async () => {
    const live = keccak256(toBytes("batch-live"))
    const payment = await signPayment(live, 2_100n)
    await facilitatorCall("/x402/verify", { paymentPayload: payment, paymentRequirements: requirements() })
    await facilitatorCall("/x402/settle", { paymentPayload: payment, mode: "authorize" })
    await until(async () => (await escrowOf(live)).status === 1, "the escrow")
    const auth = { authorization: `Bearer ${TOKEN}` }
    await facilitatorCall("/x402/capture", { reqId: keccak256(toBytes("batch-good")), actual: "1000" }, auth)
    await facilitatorCall("/x402/capture", { reqId: live, actual: "2000" }, auth)
    await until(async () => (await escrowOf(live)).status === 2, "the live capture")
    expect((await escrowOf(live)).captured).toBe(2_000n)
  }, 60_000)

  test("exact settles straight into the pool, and a stray capture for it stays quiet", async () => {
    const reqId = keccak256(toBytes("exact-call"))
    const payment = await signExact(reqId, 2_200n, 40_000n)
    const pool = await readVault<bigint>("agentPool")
    const required = { ...requirements(), maxAmountRequired: "40000" }
    expect(await facilitatorCall("/x402/verify", { paymentPayload: payment, paymentRequirements: required })).toMatchObject({ isValid: true })
    expect(await facilitatorCall("/x402/settle", { paymentPayload: payment, mode: "exact" })).toMatchObject({ success: true, status: "submitted" })
    await until(async () => (await escrowOf(reqId)).status === 4, "the exact payment")
    expect(await readVault<bigint>("agentPool")).toBe(pool + 40_000n)
    await until(async () => facilitatorPushes.some((m) => m.type === "ExactSettled" && m.reqId === reqId), "the push")

    await facilitatorCall("/x402/capture", { reqId, actual: "40000" }, { authorization: `Bearer ${TOKEN}` })
    await Bun.sleep(200)
    expect(metrics.get("x402_capture_lost_total")).toBe(0)
    await tick(ingest, ingestState)
    expect(await idx<{ status: string }>(`/idx/v1/escrows/${reqId}`)).toMatchObject({ status: "captured", maxAmount: "40000", captured: "40000" })
  }, 60_000)

  test("a settle in the wrong mode is refused", async () => {
    const reqId = keccak256(toBytes("wrong-mode"))
    const payment = await signPayment(reqId, 2_300n)
    await facilitatorCall("/x402/verify", { paymentPayload: payment, paymentRequirements: requirements() })
    expect(await facilitatorCall("/x402/settle", { paymentPayload: payment, mode: "exact" })).toMatchObject({ success: false, errorReason: "wrong_mode" })
    const unverified = await signPayment(keccak256(toBytes("never-verified")), 2_301n)
    expect(await facilitatorCall("/x402/settle", { paymentPayload: unverified, mode: "authorize" })).toMatchObject({ success: false, errorReason: "not_verified" })
  }, 30_000)

  test("capture is internal", async () => {
    const res = await fac.request("/x402/capture", { method: "POST", body: JSON.stringify({ reqId: `0x${"00".repeat(32)}`, actual: "1" }) })
    expect(res.status).toBe(401)
  })

  test("the keeper refunds an escrow nobody captured", async () => {
    const reqId = keccak256(toBytes("forgotten"))
    const payment = await signPayment(reqId, 3_000n)
    await facilitatorCall("/x402/verify", { paymentPayload: payment, paymentRequirements: requirements() })
    await facilitatorCall("/x402/settle", { paymentPayload: payment, mode: "authorize" })
    await until(async () => (await escrowOf(reqId)).status === 1, "the escrow")
    await tick(ingest, ingestState)
    expect(await runX402Expire(keeper)).toEqual([])

    const view = await escrowOf(reqId)
    await mineAt(Number(view.validBefore) + 901)
    await tick(ingest, ingestState)
    const before = await usdgOf(agent.address)
    expect(await runX402Expire(keeper)).toEqual([reqId])
    expect(await usdgOf(agent.address)).toBe(before + MAX_AUTHORIZATION)
    await tick(ingest, ingestState)
    expect(await idx<{ status: string }>(`/idx/v1/escrows/${reqId}`)).toMatchObject({ status: "expired" })

    await facilitatorCall("/x402/capture", { reqId, actual: "1" }, { authorization: `Bearer ${TOKEN}` })
    await until(async () => metrics.get("x402_capture_lost_total") === 1, "the lost capture alert")
  }, 60_000)

  test("records nobody paid for reach their hosts, and money that arrives late is not stranded", async () => {
    await send(agent, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("OffpeakVault"), 1_000_000_000n])
    await send(agent, contract("OffpeakVault"), OffpeakVaultAbi, "fundReserve", [100_000_000n])

    await settleThrough(hourIndex(await chainTime()) - 1)
    const start = hourEnd(hourIndex(await chainTime())) + 5
    const unpaidHour = hourIndex(start)
    await settleThrough(unpaidHour - 1)
    const stranded = await readVault<bigint>("agentPool")
    expect(stranded).toBe(43_000n)
    await mineAt(start)
    const unpaid = await openChannel(5_000_000n)
    await runCalls(unpaid, 4)
    const owed = await db.query<{ sum: string }>("SELECT sum(amount_micro) AS sum FROM shared.agent_payments WHERE channel_id = $1", [unpaid])
    const vouchered = BigInt(owed.rows[0]!.sum)
    const orphanFromFirstChannel = await db.query<{ req_id: string }>(
      `SELECT r.req_id FROM shared.usage_records r
       WHERE r.pay_mode = 3 AND NOT EXISTS (SELECT 1 FROM shared.agent_payments p WHERE r.req_id = ANY(p.req_ids))`,
    )
    expect(orphanFromFirstChannel.rows).toHaveLength(2)

    const reserveBefore = await readVault<bigint>("protocolReserve")
    await settleThrough(unpaidHour + 24)

    const orphans = await db.query<{ req_id: string }>("SELECT req_id FROM chain.orphan_writeoffs")
    expect(orphans.rows.map((r) => r.req_id).sort()).toEqual(orphanFromFirstChannel.rows.map((r) => r.req_id).sort())
    const written = await db.query("SELECT 1 FROM shared.agent_payments WHERE channel_id = $1 AND written_off_hour IS NOT NULL", [unpaid])
    expect(written.rows).toHaveLength(3)
    const reserveAfter = await readVault<bigint>("protocolReserve")
    expect(reserveBefore - reserveAfter).toBeGreaterThanOrEqual(vouchered)
    const swept = await db.query<{ amount: string }>("SELECT amount FROM chain.swept_payments")
    expect(swept.rows.reduce((sum, r) => sum + BigInt(r.amount), 0n)).toBe(stranded)
    expect(await readVault<bigint>("agentPool")).toBe(0n)

    // The agent's voucher lands after all, so the pool holds money nothing else would draw.
    await mineAt((await chainTime()) + 301)
    expect(await runChannelClaim(keeper)).toEqual([unpaid])
    await tick(ingest, ingestState)
    expect(await readVault<bigint>("agentPool")).toBe(vouchered)
    await settleThrough(hourIndex(await chainTime()))
    expect(await readVault<bigint>("agentPool")).toBe(0n)
    const left = await db.query("SELECT 1 FROM shared.agent_payments WHERE channel_id = $1 AND drawn_hour IS NULL", [unpaid])
    expect(left.rows).toHaveLength(0)
  }, 180_000)

  test("the keeper closes a channel past its expiry, landing the voucher first", async () => {
    const id = await openChannel(1_000_000n, 6 * 3600)
    const sig = await signVoucher(id, 1n, 400_000n)
    await db.query("INSERT INTO shared.channel_state (channel_id, payer, latest_seq, cumulative, voucher_sig) VALUES ($1,$2,1,400000,$3)", [
      id,
      agent.address.toLowerCase(),
      sig,
    ])
    const { expiry } = await channelOf(id)
    await mineAt(Number(expiry))
    await tick(ingest, ingestState)
    expect(await runChannelExpiry(keeper)).toEqual([id])
    const view = await channelOf(id)
    expect(view.status).toBe(2)
    expect(view.claimed).toBe(400_000n)
  }, 60_000)

  test("the keeper wins the challenge-period race in 100 of 100 runs on a flaky RPC", async () => {
    const proxy = flakyRpc(chain.rpcUrl)
    const slowReader = createPublicClient({ transport: http(`http://127.0.0.1:${PROXY_PORT}`), pollingInterval: 20 }) as PublicClient
    const slowKeeper: KeeperDeps = {
      ...keeper,
      reader: slowReader,
      writer: createWalletClient({ account: keeperAccount, transport: http(`http://127.0.0.1:${PROXY_PORT}`), chain: null }) as never,
    }
    let wins = 0
    try {
      for (let run = 0; run < RACES; run++) {
        const deposit = 1_000_000n
        const cumulative = BigInt(1 + Math.floor(Math.random() * 999_999))
        const id = await openChannel(deposit, 7 * 86_400)
        const sig = await signVoucher(id, 1n, cumulative)
        await db.query("INSERT INTO shared.channel_state (channel_id, payer, latest_seq, cumulative, voucher_sig) VALUES ($1,$2,1,$3,$4)", [
          id,
          agent.address.toLowerCase(),
          cumulative.toString(),
          sig,
        ])

        await mineAt((await chainTime()) + 1 + Math.floor(Math.random() * 3600))
        await send(agent, contract("ChannelManager"), ChannelManagerAbi, "requestClose", [id])
        await tick(ingest, ingestState)
        const push = pushes.findLast((m) => m.type === "CloseRequested" && String(m.channelId).toLowerCase() === id)
        expect(push).toBeDefined()

        // The keeper's pickup lands anywhere in the challenge, right up to its last stretch.
        const { challengeEndsAt } = await channelOf(id)
        const pickup = (await chainTime()) + Math.floor(Math.random() * 7_000)
        if (pickup < Number(challengeEndsAt) - 30) await mineAt(pickup)
        await runCloseWatch(slowKeeper, push!.channelId as Hex)

        const landed = await channelOf(id)
        if (landed.claimed === cumulative && (await chainTime()) < Number(challengeEndsAt)) wins++
        await mineAt(Number(challengeEndsAt))
        const before = await usdgOf(agent.address)
        await runCloseWatch(keeper, id)
        expect((await channelOf(id)).status).toBe(3)
        expect((await usdgOf(agent.address)) - before).toBe(deposit - cumulative)
      }
    } finally {
      proxy.stop(true)
    }
    expect(wins).toBe(RACES)
    await tick(ingest, ingestState)
    const closed = await db.query<{ n: string }>("SELECT count(*) AS n FROM chain.channels WHERE status = 3")
    expect(Number(closed.rows[0]!.n)).toBe(RACES)
    expect(metrics.get("channel_close_margin_seconds")).toBe(7200)
  }, 300_000)
})
