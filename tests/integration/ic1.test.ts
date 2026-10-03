import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, decodeEventLog, http, type Address, type Hex } from "viem"
import { bootStack } from "../../apps/router/test/support/stack.ts"
import { MockUSDGAbi, OffpeakVaultAbi, UsageLedgerAbi } from "../../packages/abis/src/index.ts"
import { verifyUsage } from "../../packages/sdk/src/verify.ts"
import { leafFor, parseEnvelope, recordToMessage, usageDigest, type UsageEnvelope } from "../../packages/shared/src/index.ts"
import { roleAccount } from "../../packages/shared/src/test-keys.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 29547
const DEPOSIT = 100_000_000n
const HOURLY_CAP = 5_000_000n

const buyer = roleAccount("buyer").address.toLowerCase() as Address
const router = roleAccount("router").address
const host = roleAccount("host").address

let chain: LocalChain
let booted: Awaited<ReturnType<typeof bootStack>>

function clients() {
  const transport = http(chain.rpcUrl)
  return { reader: createPublicClient({ transport }), wallet: createWalletClient({ account: buyer, transport, chain: null }) }
}

/** The live indexer arrives in A4, so this copies the chain's own view into the router the way it will. */
async function syncBuyerFromChain() {
  const view = await clients().reader.readContract({
    address: chain.contracts.OffpeakVault!,
    abi: OffpeakVaultAbi,
    functionName: "buyerState",
    args: [buyer],
  })
  booted.indexer.setBuyer(buyer, {
    balance: view.balance.toString(),
    reserve: view.reserve.toString(),
    hourlyCap: view.hourlyCap.toString(),
    dailyCap: view.dailyCap.toString(),
    lastSettledHour: view.lastSettledHour.toString(),
    withdrawRequestedAt: view.withdrawRequestedAt.toString(),
  })
  return view
}

async function stream(): Promise<UsageEnvelope> {
  const res = await booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "ic1" }], max_tokens: 16, stream: true }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  const match = /event: offpeak\.usage\ndata: (.+)\n/.exec(text)
  expect(match).not.toBeNull()
  return parseEnvelope(JSON.parse(match![1]!))
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  booted = await bootStack()
  const { reader, wallet } = clients()
  const send = async (hash: Hex) => reader.waitForTransactionReceipt({ hash })
  await send(
    await wallet.writeContract({
      address: chain.contracts.MockUSDG!,
      abi: MockUSDGAbi,
      functionName: "approve",
      args: [chain.contracts.OffpeakVault!, DEPOSIT],
    }),
  )
  await send(
    await wallet.writeContract({
      address: chain.contracts.OffpeakVault!,
      abi: OffpeakVaultAbi,
      functionName: "deposit",
      args: [DEPOSIT],
    }),
  )
  await send(
    await wallet.writeContract({
      address: chain.contracts.OffpeakVault!,
      abi: OffpeakVaultAbi,
      functionName: "setCaps",
      args: [HOURLY_CAP, 0n],
    }),
  )
}, 120_000)

afterAll(() => {
  chain?.stop()
})

describe("IC1: a prepaid call on local anvil", () => {
  test("deposit, hold, stream, and the envelope verifies against the deployed ledger", async () => {
    const view = await syncBuyerFromChain()
    expect(view.balance).toBe(DEPOSIT)
    expect(view.hourlyCap).toBe(HOURLY_CAP)
    expect(view.dailyCap).toBe(4n * HOURLY_CAP)

    const envelope = await stream()
    expect(envelope.record.payMode).toBe(0)
    expect(envelope.record.hostCostMicro + envelope.record.feeMicro).toBeLessThanOrEqual(HOURLY_CAP)

    const ledger = chain.contracts.UsageLedger!
    const report = await verifyUsage(envelope, ledger, router, host)
    expect(report.reasons).toEqual([])
    expect(leafFor(envelope.record, envelope.routerSig, envelope.hostSig)).toBe(envelope.leaf)

    const message = recordToMessage(envelope.record) as never
    const { reader } = clients()
    expect(
      await reader.readContract({ address: ledger, abi: UsageLedgerAbi, functionName: "usageDigest", args: [message] }),
    ).toBe(usageDigest(message, ledger))
    expect(
      await reader.readContract({
        address: ledger,
        abi: UsageLedgerAbi,
        functionName: "leafOf",
        args: [message, envelope.routerSig, envelope.hostSig],
      }),
    ).toBe(envelope.leaf)
  })

  test("a withdraw-all on chain stops the router serving that buyer", async () => {
    const { reader, wallet } = clients()
    const hash = await wallet.writeContract({
      address: chain.contracts.OffpeakVault!,
      abi: OffpeakVaultAbi,
      functionName: "requestWithdrawAll",
    })
    const receipt = await reader.waitForTransactionReceipt({ hash })
    const event = decodeEventLog({ abi: OffpeakVaultAbi, ...receipt.logs[0]! })
    expect(event.eventName).toBe("WithdrawAllRequested")
    const args = event.args as { buyer: Address; requestedAt: bigint; dueAt: bigint }
    booted.indexer.emit({
      type: event.eventName,
      buyer: args.buyer,
      requestedAt: Number(args.requestedAt),
      dueAt: Number(args.dueAt),
      block: Number(receipt.blockNumber),
      txHash: hash,
    })

    const res = await booted.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "ic1" }], max_tokens: 8 }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("withdraw_pending")
  })
})
