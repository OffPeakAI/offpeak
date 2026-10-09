import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Redis from "ioredis"
import { bytesToHex, createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type HDAccount, type Hex, type PublicClient } from "viem"
import { createHostApp } from "../../apps/host-agent/src/mock-engine.ts"
import { issueKey } from "../../apps/router/src/auth/keys.ts"
import { sheetHashOf, type PriceSheet } from "../../apps/router/src/pricing/pricebook.ts"
import { saveSheet } from "../../apps/router/src/pricing/sheets.ts"
import { saveEndpoint } from "../../apps/router/src/routing/probes.ts"
import { ChannelManagerAbi, HostRegistryAbi, MockUSDGAbi, OffpeakVaultAbi } from "../../packages/abis/src/index.ts"
import { PERMIT2, channelAuthHeader, domain, parseEnvelope, permitWitnessTypes, priceSheetTypes, voucherTypes } from "../../packages/shared/src/index.ts"
import { anvilAccount, roleAccount } from "../../packages/shared/src/test-keys.ts"
import { connectDatabase, type Db } from "../../services/common/src/index.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const root = new URL("../../", import.meta.url).pathname
const PG_BIN = Bun.which("initdb") ? "" : "/opt/homebrew/opt/postgresql@16/bin/"
const hasPostgres = Boolean(Bun.which(`${PG_BIN}initdb`))
// Postgres refuses to start on macOS when the inherited locale is unset or invalid.
const pgEnv = { ...process.env, LC_ALL: "C" }
const RPC_PORT = 29760
const PG_PORT = 29761
const HOST_PORT = 29762
const ROUTER_PORT = 29763
const INDEXER_PORT = 29764
const FAC_PORT = 29765
const TOKEN = "local-test-token-0123456789abcdef"
const REDIS_DB = "redis://127.0.0.1:6379/9"
const DATABASE = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`
const ROUTER_URL = `http://127.0.0.1:${ROUTER_PORT}`
const MODEL_DIGEST = keccak256(toBytes("ofm-8b"))
const IMAGE_DIGEST = keccak256(toBytes("offpeak-image-v1"))
const DEPOSIT = 50_000_000n
const HOURLY_CAP = 20_000_000n

const routerKey = roleAccount("router")
const hostKey = roleAccount("host")
const buyerKey = roleAccount("buyer")
const agent = anvilAccount(19)
const hexKey = (account: HDAccount) => bytesToHex(account.getHdKey().privateKey!)

let chain: LocalChain
let reader: PublicClient
let db: Db
let redis: Redis
let dataDir: string
let hostServer: ReturnType<typeof Bun.serve>
let router: Bun.Subprocess
let services: Bun.Subprocess[] = []
let buyerToken: string

const contract = (name: string) => chain.contracts[name]! as Address

const baseEnv = () => ({
  ...process.env,
  OFFPEAK_ENV: "local",
  OFFPEAK_CHAIN_ID: "4663",
  OFFPEAK_RPC_URL: chain.rpcUrl,
  OFFPEAK_CONFIRMATIONS: "1",
  OFFPEAK_DEPLOYMENT_FILE: join(root, "packages/abis/deployments/local.json"),
  OFFPEAK_DATABASE_URL: DATABASE,
  OFFPEAK_REDIS_URL: REDIS_DB,
  OFFPEAK_INTERNAL_TOKEN: TOKEN,
})

function spawnRouter() {
  return Bun.spawn(["bun", "run", "apps/router/src/main.ts"], {
    cwd: root,
    stdout: "ignore",
    stderr: "inherit",
    env: {
      ...baseEnv(),
      OFFPEAK_MODELS_FILE: join(dataDir, "models.json"),
      OFFPEAK_INDEXER_URL: `http://127.0.0.1:${INDEXER_PORT}`,
      OFFPEAK_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
      OFFPEAK_ROUTER_SIGNER_KEY: hexKey(routerKey),
      OFFPEAK_CHANNEL_PAYEE: routerKey.address,
      OFFPEAK_PUBLIC_BASE_URL: ROUTER_URL,
      OFFPEAK_ROUTER_PORT: String(ROUTER_PORT),
    },
  })
}

async function until(what: string, check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function send(account: HDAccount, address: Address, abi: unknown, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas: 3_000_000n } as never)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe("success")
  return receipt
}

async function rpc(method: string, params: unknown[]) {
  await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

const chat = (headers: Record<string, string>, content: string, extra: object = {}) =>
  fetch(`${ROUTER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 16, ...extra }),
  })

async function channelChat(id: Hex, content: string, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 16 })
  const proof = await channelAuthHeader(agent, { channelId: id, ts: Math.floor(Date.now() / 1000), body })
  return fetch(`${ROUTER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": proof, ...headers },
    body,
  })
}

function voucherHeader(seq: bigint, cumulative: bigint, sig: Hex) {
  return Buffer.from(JSON.stringify({ seq: seq.toString(), cumulative: cumulative.toString(), sig })).toString("base64url")
}

beforeAll(async () => {
  if (!hasPostgres) return
  dataDir = mkdtempSync(join(tmpdir(), "offpeak-live-"))
  writeFileSync(join(dataDir, "models.json"), JSON.stringify([{ name: "ofm-8b", digest: MODEL_DIGEST, contextLength: 8192, kind: "chat" }]))
  Bun.spawnSync([`${PG_BIN}initdb`, "-D", join(dataDir, "pg"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdout: "ignore", stderr: "ignore", env: pgEnv })
  Bun.spawnSync([`${PG_BIN}pg_ctl`, "-D", join(dataDir, "pg"), "-o", `-p ${PG_PORT} -c unix_socket_directories= -c listen_addresses=127.0.0.1`, "-l", join(dataDir, "pg.log"), "-w", "start"], {
    stdout: "ignore",
    stderr: "ignore",
    env: pgEnv,
  })
  redis = new Redis(REDIS_DB)
  await redis.flushdb()
  db = connectDatabase(DATABASE)

  const now = Math.floor(Date.now() / 1000)
  chain = await startLocalChain(RPC_PORT, { timestamp: now - 80 * 3600 })
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 20 }) as PublicClient

  // The host registers while the chain is in the past, so its probation is over once the chain reaches today.
  const bond = 2_000_000_000n
  await send(hostKey, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("HostRegistry"), bond])
  await send(hostKey, contract("HostRegistry"), HostRegistryAbi, "register", [
    {
      modelDigests: [MODEL_DIGEST],
      maxTps: [100],
      imageDigest: IMAGE_DIGEST,
      gpuClass: keccak256(toBytes("h100-80g-sxm")),
      endpointHash: keccak256(toBytes(`http://127.0.0.1:${HOST_PORT}`)),
      attestationRef: `0x${"00".repeat(32)}`,
      bondUsdg: bond,
      bondOfpk: 0n,
    },
  ])
  await rpc("evm_setNextBlockTimestamp", [now])
  await rpc("evm_mine", [])
  await send(hostKey, contract("HostRegistry"), HostRegistryAbi, "activate", [hostKey.address])
  await send(buyerKey, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("OffpeakVault"), DEPOSIT])
  await send(buyerKey, contract("OffpeakVault"), OffpeakVaultAbi, "deposit", [DEPOSIT])
  await send(buyerKey, contract("OffpeakVault"), OffpeakVaultAbi, "setCaps", [HOURLY_CAP, 0n])
  await send(agent, contract("MockUSDG"), MockUSDGAbi, "mint", [agent.address, 100_000_000n])
  await send(agent, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("ChannelManager"), 100_000_000n])
  await send(agent, contract("MockUSDG"), MockUSDGAbi, "approve", [PERMIT2, 100_000_000n])

  const engine = createHostApp({
    operator: hostKey as never,
    routerAddress: routerKey.address,
    usageLedger: contract("UsageLedger"),
    modelDigest: MODEL_DIGEST,
    modelName: "ofm-8b",
    imageDigest: IMAGE_DIGEST,
    gpuClass: "h100-80g-sxm",
    swap: false,
    sealed: false,
  })
  hostServer = Bun.serve({ port: HOST_PORT, fetch: engine.app.fetch })

  router = spawnRouter()
  await until("the router", async () => (await fetch(`${ROUTER_URL}/health`)).ok)
  services = [
    Bun.spawn(["bun", "run", "services/indexer/src/main.ts"], { cwd: root, stdout: "ignore", stderr: "inherit", env: { ...baseEnv(), OFFPEAK_INDEXER_PORT: String(INDEXER_PORT) } }),
    Bun.spawn(["bun", "run", "services/facilitator/src/main.ts"], {
      cwd: root,
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...baseEnv(),
        OFFPEAK_FACILITATOR_PORT: String(FAC_PORT),
        OFFPEAK_FACILITATOR_RELAY_KEY: hexKey(anvilAccount(11)),
        OFFPEAK_CAPTURER_KEY: hexKey(anvilAccount(12)),
        OFFPEAK_AUTHORIZE_FLUSH_MS: "20",
        OFFPEAK_CAPTURE_FLUSH_MS: "50",
      },
    }),
  ]
  await until("the indexer", async () => {
    const res = await fetch(`http://127.0.0.1:${INDEXER_PORT}/idx/v1/hosts`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const body = (await res.json()) as { data: { status: number }[] }
    return body.data[0]?.status === 2
  })
  await until("the facilitator", async () => (await fetch(`http://127.0.0.1:${FAC_PORT}/x402/supported`)).ok)

  await saveEndpoint(db, hostKey.address, `http://127.0.0.1:${HOST_PORT}`)
  const sheet: PriceSheet = {
    host: hostKey.address.toLowerCase() as Hex,
    modelDigest: MODEL_DIGEST,
    baseIn: Array.from({ length: 168 }, () => 200_000n),
    baseOut: Array.from({ length: 168 }, () => 800_000n),
    floorIn: 100_000n,
    floorOut: 400_000n,
    validFrom: 0,
    nonce: 1n,
  }
  const sig = await hostKey.signTypedData({
    domain: domain("OffpeakPriceSheet", contract("HostRegistry")),
    types: priceSheetTypes,
    primaryType: "PriceSheet",
    message: { ...sheet, validFrom: 0n },
  })
  await saveSheet(db, { ...sheet, sig, sheetHash: sheetHashOf(sheet, contract("HostRegistry")) })
  buyerToken = (await issueKey({ db } as never, buyerKey.address)).token
  await until("a routable host", async () => {
    const res = await chat({ authorization: `Bearer ${buyerToken}` }, "warmup")
    await res.text()
    return res.status === 200
  }, 30_000)
}, 240_000)

afterAll(async () => {
  if (!hasPostgres) return
  hostServer?.stop(true)
  for (const service of [...services, router]) {
    service?.kill()
    await service?.exited
  }
  // Redis being down must not leave this Postgres running on its port, where the next run would reuse its rows.
  await redis?.flushdb().catch(() => undefined)
  redis?.disconnect()
  chain?.stop()
  Bun.spawnSync([`${PG_BIN}pg_ctl`, "-D", join(dataDir, "pg"), "-m", "immediate", "stop"], { stdout: "ignore", stderr: "ignore" })
  rmSync(dataDir, { recursive: true, force: true })
})

describe.skipIf(!hasPostgres)("the router as a real process", () => {
  test("a prepaid stream arrives in pieces, billed in Postgres with a verifiable envelope", async () => {
    const res = await chat({ authorization: `Bearer ${buyerToken}` }, "longform", { stream: true, max_tokens: 400 })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect((text.match(/chat\.completion\.chunk/g) ?? []).length).toBeGreaterThan(2)
    const match = /event: offpeak\.usage\ndata: (.+)\n/.exec(text)
    const envelope = parseEnvelope(JSON.parse(match![1]!))
    const rows = await db.query<{ payer: string; leaf: string }>("SELECT payer, leaf FROM shared.usage_records WHERE req_id = $1", [envelope.record.reqId])
    expect(rows.rows[0]?.payer).toBe(buyerKey.address.toLowerCase())
    expect(rows.rows[0]?.leaf).toBe(envelope.leaf)
    const redisSpend = await redis.hvals(`offpeak:hold:{${buyerKey.address.toLowerCase()}}:spend`)
    expect(redisSpend.length).toBeGreaterThan(0)
  })

  test("a request past the hourly cap is refused", async () => {
    await send(buyerKey, contract("OffpeakVault"), OffpeakVaultAbi, "setCaps", [1n, 0n])
    await until("the lower cap", async () => {
      const res = await chat({ authorization: `Bearer ${buyerToken}` }, "cap")
      await res.text()
      return res.status === 402
    })
    await send(buyerKey, contract("OffpeakVault"), OffpeakVaultAbi, "setCaps", [HOURLY_CAP, 0n])
  })

  test("a channel keeps working across a router restart, voucher boundaries included", async () => {
    const salt = keccak256(toBytes("live-channel"))
    await send(agent, contract("ChannelManager"), ChannelManagerAbi, "open", [10_000_000n, BigInt(Math.floor(Date.now() / 1000) + 3 * 86_400), salt])
    const logs = await reader.getContractEvents({ address: contract("ChannelManager"), abi: ChannelManagerAbi, eventName: "ChannelOpened", fromBlock: 0n })
    const id = logs.at(-1)!.args.channelId! as Hex
    await until("the channel", async () => {
      const res = await channelChat(id, "first")
      await res.text()
      return res.status === 200 && Boolean(res.headers.get("x-offpeak-channel-owed"))
    })
    const owed = BigInt((await (await fetch(`${ROUTER_URL}/v1/channels/${id}`)).json() as { owed: string }).owed)
    expect(owed).toBeGreaterThan(0n)

    router.kill()
    await router.exited
    router = spawnRouter()
    await until("the restarted router", async () => (await fetch(`${ROUTER_URL}/health`)).ok)
    await until("hosts after restart", async () => {
      const res = await chat({ authorization: `Bearer ${buyerToken}` }, "back")
      await res.text()
      return res.status === 200
    })

    const sig = await agent.signTypedData({
      domain: domain("OffpeakChannel", contract("ChannelManager")),
      types: voucherTypes,
      primaryType: "Voucher",
      message: { channelId: id, seq: 1n, cumulative: owed },
    })
    const next = await channelChat(id, "second", { "x-offpeak-voucher": voucherHeader(1n, owed, sig) })
    expect(next.status).toBe(200)
    await next.text()
    const state = await db.query<{ cumulative: string }>("SELECT cumulative FROM shared.channel_state WHERE channel_id = $1", [id])
    expect(BigInt(state.rows[0]!.cumulative)).toBe(owed)
    const stale = await channelChat(id, "replay", { "x-offpeak-voucher": voucherHeader(1n, owed, sig) })
    expect(stale.status).toBe(200)
    await stale.text()
    const after = await db.query<{ cumulative: string }>("SELECT cumulative FROM shared.channel_state WHERE channel_id = $1", [id])
    expect(BigInt(after.rows[0]!.cumulative)).toBe(owed)
  }, 60_000)

  test("upto authorizes on chain through the facilitator process and hears back over Redis", async () => {
    const reqId = keccak256(toBytes("live-upto"))
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const amount = 2_000_000n
    const witness = { reqId, payee: contract("OffpeakVault"), maxAmount: amount, validBefore: deadline, resourceHash: keccak256(toBytes("resource")) }
    const message = { permitted: { token: contract("MockUSDG"), amount }, spender: contract("X402Escrow"), nonce: 77n, deadline, witness }
    const signature = await agent.signTypedData({
      domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Address },
      types: permitWitnessTypes("UptoWitness"),
      primaryType: "PermitWitnessTransferFrom",
      message,
    } as never)
    const payment = {
      x402Version: 2,
      scheme: "upto",
      payload: {
        signature,
        permitted: { token: contract("MockUSDG"), amount: amount.toString() },
        spender: contract("X402Escrow"),
        nonce: "77",
        deadline: deadline.toString(),
        witness: { ...witness, maxAmount: amount.toString(), validBefore: deadline.toString() },
      },
    }
    const res = await chat({ "payment-signature": JSON.stringify(payment) }, "longform", { stream: true, max_tokens: 400 })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("event: offpeak.usage")
    await until("the capture", async () => {
      const row = await fetch(`http://127.0.0.1:${INDEXER_PORT}/idx/v1/escrows/${reqId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
      return ((await row.json()) as { data: { status: string } }).data.status === "captured"
    })
  }, 60_000)

  test("a withdraw-all push stops new holds", async () => {
    await send(buyerKey, contract("OffpeakVault"), OffpeakVaultAbi, "requestWithdrawAll")
    await until("the push", async () => {
      const res = await chat({ authorization: `Bearer ${buyerToken}` }, "after withdraw")
      await res.text()
      return res.status === 403
    }, 8_000)
  })
})

