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
