import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  AuditCourtAbi,
  ChannelManagerAbi,
  HostRegistryAbi,
  MockUSDGAbi,
  OffpeakVaultAbi,
  UsageLedgerAbi,
  WindowMarketAbi,
} from "../../packages/abis/src/index.ts"
import { PERMIT2, domainSeparator, parseRecord, recordToMessage, usageDigest } from "../../packages/shared/src/index.ts"
import { createPublicClient, createWalletClient, decodeEventLog, http, type Abi, type Address, type Hex } from "viem"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29746
const rpcUrl = `http://127.0.0.1:${PORT}`
const root = new URL("../../", import.meta.url).pathname
const client = createPublicClient({ transport: http(rpcUrl) })

let chain: LocalChain
let contracts: Record<string, Address>
let vectors: { addresses: { contracts: Record<string, string>; buyer: Address }; usage: { record: never }[] }

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  contracts = chain.contracts
  vectors = JSON.parse(readFileSync(`${root}packages/shared/fixtures/vectors.json`, "utf8"))
}, 120_000)

afterAll(() => {
  chain?.stop()
})

describe("bun run chain:local", () => {
  test("deploys on chain id 4663 at the addresses the vectors are signed over", async () => {
    expect(await client.getChainId()).toBe(4663)
    for (const [name, address] of Object.entries(contracts)) {
      expect((await client.getCode({ address }))?.length ?? 0).toBeGreaterThan(2)
      if (name in vectors.addresses.contracts) expect(address).toBe(vectors.addresses.contracts[name] as Address)
    }
  })

  test("runs canonical Permit2 and a 6-decimal mock USDG", async () => {
    const permit2Domain = await client.readContract({
      address: PERMIT2,
      abi: [{ type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }],
      functionName: "DOMAIN_SEPARATOR",
    })
    expect(permit2Domain).toBe(domainSeparator("Permit2", PERMIT2, null))
    const usdg = { address: contracts.MockUSDG!, abi: MockUSDGAbi }
    expect(await client.readContract({ ...usdg, functionName: "decimals" })).toBe(6)
    expect(await client.readContract({ ...usdg, functionName: "symbol" })).toBe("USDG")
  })

  test("every EIP-712 domain has the name and chain id section 3.3 fixes", async () => {
    const domains: [string, Abi, string][] = [
      ["UsageLedger", UsageLedgerAbi, "OffpeakUsage"],
      ["OffpeakVault", OffpeakVaultAbi, "OffpeakSettlement"],
      ["ChannelManager", ChannelManagerAbi, "OffpeakChannel"],
      ["HostRegistry", HostRegistryAbi, "OffpeakPriceSheet"],
      ["AuditCourt", AuditCourtAbi, "OffpeakAudit"],
      ["WindowMarket", WindowMarketAbi, "OffpeakWindows"],
    ]
    for (const [contract, abi, name] of domains) {
      const domain = (await client.readContract({
        address: contracts[contract]!,
        abi,
        functionName: "eip712Domain",
      })) as readonly unknown[]
      expect(domain.slice(1, 4)).toEqual([name, "1", 4663n])
    }
  })

  test("the ledger's on-chain usage digest matches packages/shared", async () => {
    const record = parseRecord(vectors.usage[0]!.record)
    const onchain = await client.readContract({
      address: contracts.UsageLedger!,
      abi: UsageLedgerAbi,
      functionName: "usageDigest",
      args: [recordToMessage(record) as never],
    })
    expect(onchain).toBe(usageDigest(recordToMessage(record), contracts.UsageLedger!))
  })

  test("a stub call emits the final event through the generated ABI", async () => {
    const wallet = createWalletClient({ account: vectors.addresses.buyer, transport: http(rpcUrl), chain: null })
    const hash: Hex = await wallet.writeContract({
      address: contracts.OffpeakVault!,
      abi: OffpeakVaultAbi,
      functionName: "requestWithdrawAll",
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    const event = decodeEventLog({ abi: OffpeakVaultAbi, ...receipt.logs[0]! })
    expect(event.eventName).toBe("WithdrawAllRequested")
    expect((event.args as { buyer: string }).buyer.toLowerCase()).toBe(vectors.addresses.buyer.toLowerCase())
  })
})
