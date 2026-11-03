import { escrowAbi, mandateAccountAbi, mandateAccountFactoryAbi, commitCanonical } from "@bursar/core"
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, erc20Abi, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { Offpeak, type ChatResult } from "@offpeak/sdk"
import { connectDatabase } from "@offpeak/common"
import { z } from "zod"
import { createGateway, gatewaySql } from "./gateway.ts"
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s as Address)
const env = z
  .object({
    BURSAR_GATEWAY_ORIGIN: z.url(),
    BURSAR_RPC_URL: z.url(),
    BURSAR_MERCHANT_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    BURSAR_ESCROW: addr,
    BURSAR_FACTORY: addr,
    BURSAR_USDG: addr,
    BURSAR_PRICE_MICRO: z.string().regex(/^[1-9]\d{0,17}$/),
    BURSAR_MODELS: z.string().min(1),
    BURSAR_CAPABILITY: z.string().default("service:inference.text"),
    BURSAR_DATABASE_URL: z.string().startsWith("postgres"),
    OFFPEAK_PUBLIC_BASE_URL: z.url(),
    OFFPEAK_API_KEY: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(8793),
  })
  .safeParse(process.env)
if (!env.success) throw Error("Gateway environment is incomplete: " + env.error.issues.map((i) => i.path.join(".")).join(", "))
const e = env.data,
  account = privateKeyToAccount(e.BURSAR_MERCHANT_KEY as Hex),
  chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [e.BURSAR_RPC_URL] } },
  })
const reader = createPublicClient({ chain, transport: http(e.BURSAR_RPC_URL) }),
  writer = createWalletClient({ chain, account, transport: http(e.BURSAR_RPC_URL) })
if ((await reader.getChainId()) !== 4663) throw Error("Gateway RPC is on another chain")
if (
  (await reader.readContract({ address: e.BURSAR_ESCROW, abi: escrowAbi, functionName: "settlementAsset" })).toLowerCase() !==
  e.BURSAR_USDG.toLowerCase()
)
  throw Error("Escrow uses a different asset")
if ((await reader.readContract({ address: e.BURSAR_USDG, abi: erc20Abi, functionName: "decimals" })) !== 6)
  throw Error("Gateway needs a six-decimal settlement asset")
const minLock = await reader.readContract({ address: e.BURSAR_ESCROW, abi: escrowAbi, functionName: "minLock" })
if (BigInt(e.BURSAR_PRICE_MICRO) < minLock) throw Error("Task price is below the escrow minimum lock")
const db = connectDatabase(e.BURSAR_DATABASE_URL)
await db.exec(gatewaySql)
const op = new Offpeak({
  baseURL: e.OFFPEAK_PUBLIC_BASE_URL,
  apiKey: e.OFFPEAK_API_KEY,
  rpcUrl: e.BURSAR_RPC_URL,
  fetch: ((i, init) =>
    fetch(i, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(120000)]) })) as typeof fetch,
})
const readLock = (id: bigint) => reader.readContract({ address: e.BURSAR_ESCROW, abi: escrowAbi, functionName: "getLock", args: [id] })
const app = createGateway(
  {
    origin: e.BURSAR_GATEWAY_ORIGIN,
    merchant: account.address,
    escrow: e.BURSAR_ESCROW,
    asset: e.BURSAR_USDG,
    priceMicro: BigInt(e.BURSAR_PRICE_MICRO),
    models: e.BURSAR_MODELS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    capability: e.BURSAR_CAPABILITY,
  },
  db,
  {
    readLock,
    async isMandate(address) {
      const [escrow, principal] = await Promise.all([
        reader.readContract({ address, abi: mandateAccountAbi, functionName: "escrow" }),
        reader.readContract({ address, abi: mandateAccountAbi, functionName: "principal" }),
      ])
      if (escrow.toLowerCase() !== e.BURSAR_ESCROW.toLowerCase()) return false
      return (
        await reader.readContract({
          address: e.BURSAR_FACTORY,
          abi: mandateAccountFactoryAbi,
          functionName: "accountsOf",
          args: [principal],
        })
      ).some((a) => a.toLowerCase() === address.toLowerCase())
    },
    async lockedIn(tx, id) {
      const r = await reader.getTransactionReceipt({ hash: tx })
      return (
        r.status === "success" &&
        parseEventLogs({ abi: escrowAbi, eventName: "Locked", logs: r.logs }).some(
          (l) => l.address.toLowerCase() === e.BURSAR_ESCROW.toLowerCase() && l.args.id === id,
        )
      )
    },
    async complete(body, cap) {
      const r = (await op.chat(body, { maxChargeMicro: cap })) as ChatResult
      if (!(await op.verifyUsage(r.envelope)).ok) throw Error("Backend usage record failed verification")
      return {
        ...r.completion,
        offpeak_gateway: {
          pricing: "fixed-task",
          chargeMicro: cap.toString(),
          backendPayer: "merchant",
          receipt: r.completion.offpeak_usage,
        },
      }
    },
    async release(id, output) {
      const expected = commitCanonical(output),
        lock = await readLock(id)
      if (lock.status === 2) {
        if (lock.outputCommit.toLowerCase() !== expected.toLowerCase()) throw Error("Released output does not match saved task")
        return null
      }
      if (lock.status !== 1) throw Error("Escrow is no longer releasable")
      // Publish the output hash, never the user's conversation. Retrieval requires the original bound payment.
      const { request } = await reader.simulateContract({
        address: e.BURSAR_ESCROW,
        abi: escrowAbi,
        functionName: "release",
        args: [id, expected, `${e.BURSAR_GATEWAY_ORIGIN}/v1/chat/completions`],
        account,
      })
      const hash = await writer.writeContract(request)
      const receipt = await reader.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw Error("Escrow release reverted")
      return hash
    },
  },
  async () => Number((await reader.getBlock()).timestamp),
)
Bun.serve({ hostname: "127.0.0.1", port: e.PORT, fetch: app.fetch, idleTimeout: 180 })
console.log(`Bursar merchant gateway listening on 127.0.0.1:${e.PORT}`)
