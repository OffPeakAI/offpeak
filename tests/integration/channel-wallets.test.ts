import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Address, type Hex, type HDAccount, type PublicClient } from "viem"
import { rpcWallets } from "../../apps/router/src/pay/signatures.ts"
import { bootStack } from "../../apps/router/test/support/stack.ts"
import { ChannelManagerAbi, MockUSDGAbi } from "../../packages/abis/src/index.ts"
import { channelAuthHeader, coopCloseTypes, domain } from "../../packages/shared/src/index.ts"
import { anvilAccount } from "../../packages/shared/src/test-keys.ts"
import { startLocalChain, type LocalChain } from "./local-chain.ts"

const PORT = 34601
const agent = anvilAccount(19)
const payee = anvilAccount(14)
const keeper = anvilAccount(13)
const wallet = "0x00000000000000000000000000000000000c0de1" as Address

/** A contract wallet in five instructions: it answers one word to everything. */
const answering = (word: string) => `0x7f${word.padEnd(64, "0")}60005260206000f3` as Hex
const SAYS_YES = answering("1626ba7e")
const SAYS_NO = answering("ffffffff")

let chain: LocalChain
let booted: Awaited<ReturnType<typeof bootStack>>
let reader: PublicClient
let salts = 0

const contract = (name: string) => chain.contracts[name]!
const rpc = (method: string, params: unknown[] = []) => fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
const chainTime = async () => Number((await reader.getBlock({ blockTag: "latest" })).timestamp)
const channelOf = (id: Hex) => reader.readContract({ address: contract("ChannelManager"), abi: ChannelManagerAbi, functionName: "channelView", args: [id] })
const usdgOf = (who: Address) => reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [who] })

async function send(account: HDAccount | Address, address: Address, abi: unknown, functionName: string, args: unknown[] = []) {
  const client = createWalletClient({ account, transport: http(chain.rpcUrl), chain: null })
  const hash = await client.writeContract({ address, abi, functionName, args } as never)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe("success")
}

async function open(payer: HDAccount | Address, deposit: bigint) {
  const address = typeof payer === "string" ? payer : payer.address
  const salt = keccak256(toBytes(`wallet-channel-${salts++}`))
  await send(payer, contract("MockUSDG"), MockUSDGAbi, "mint", [address, deposit])
  await send(payer, contract("MockUSDG"), MockUSDGAbi, "approve", [contract("ChannelManager"), deposit])
  await send(payer, contract("ChannelManager"), ChannelManagerAbi, "open", [deposit, BigInt((await chainTime()) + 3 * 86_400), salt])
  const logs = await reader.getContractEvents({ address: contract("ChannelManager"), abi: ChannelManagerAbi, eventName: "ChannelOpened", fromBlock: "earliest" })
  const id = logs.at(-1)!.args.channelId!.toLowerCase() as Hex
  const view = await channelOf(id)
  booted.indexer.channels.set(id, { ...view, payer: view.payer.toLowerCase() as Hex, status: 1, closeRequested: false })
  booted.stack.setClock(await chainTime())
  return id
}

async function call(id: Hex, sign: (args: { message: string }) => Promise<Hex>, text: string) {
  const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: text }], max_tokens: 16 })
  const auth = await channelAuthHeader({ signMessage: sign }, { channelId: id, ts: booted.stack.clock(), body })
  return booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 50 })
  booted = await bootStack()
  booted.stack.channelManager = contract("ChannelManager")
  booted.stack.wallets = rpcWallets(chain.rpcUrl)
}, 120_000)

afterAll(() => chain?.stop())

describe("on a real chain", () => {
  test("the contract takes the router's cooperative close, pays what was owed and returns the rest", async () => {
    const deposit = 5_000_000n
    const id = await open(agent, deposit)
    const first = await call(id, (args) => agent.signMessage(args), "one")
    expect(first.status).toBe(200)
    const owed = BigInt(first.headers.get("x-offpeak-channel-owed")!)
    const deadline = BigInt((await chainTime()) + 600)
    const payerSig = await agent.signTypedData({ domain: domain("OffpeakChannel", contract("ChannelManager")), types: coopCloseTypes, primaryType: "CooperativeClose", message: { channelId: id, finalCumulative: owed, deadline } })

    // The contract insists on its payee, so this router holds that key from here on.
    const { router, channelPayee } = booted.stack
    booted.stack.router = payee as never
    booted.stack.channelPayee = payee.address
    const res = await booted.app.request(`/v1/channels/${id}/close`, { method: "POST", body: JSON.stringify({ finalCumulative: owed.toString(), deadline: deadline.toString(), payerSig }) })
    booted.stack.router = router
    booted.stack.channelPayee = channelPayee
    expect(res.status).toBe(200)
    const { to, data, value } = (await res.json()) as { to: Address; data: Hex; value: string }

    const before = await usdgOf(agent.address)
    const sender = createWalletClient({ account: keeper, transport: http(chain.rpcUrl), chain: null })
    const receipt = await reader.waitForTransactionReceipt({ hash: await sender.sendTransaction({ to, data, value: BigInt(value) }) })
    expect(receipt.status).toBe("success")
    const after = await channelOf(id)
    expect(after.status).toBe(3)
    expect(after.claimed).toBe(owed)
    expect((await usdgOf(agent.address)) - before).toBe(deposit - owed)
  }, 60_000)

  test("a router signature from any other key is one the contract refuses", async () => {
    const id = await open(agent, 1_000_000n)
    const deadline = BigInt((await chainTime()) + 600)
    const typed = { domain: domain("OffpeakChannel", contract("ChannelManager")), types: coopCloseTypes, primaryType: "CooperativeClose", message: { channelId: id, finalCumulative: 0n, deadline } } as const
    const args = [id, { channelId: id, finalCumulative: 0n, deadline }, await agent.signTypedData(typed), await keeper.signTypedData(typed)]
    const refused = await reader.simulateContract({ address: contract("ChannelManager"), abi: ChannelManagerAbi, functionName: "cooperativeClose", args: args as never, account: keeper }).catch(() => null)
    expect(refused).toBe(null)
  }, 60_000)

  test("a contract wallet pays by channel, its voucher lands, and the router sees it change its mind", async () => {
    await rpc("anvil_setCode", [wallet, SAYS_YES])
    await rpc("anvil_setBalance", [wallet, "0xde0b6b3a7640000"])
    await rpc("anvil_impersonateAccount", [wallet])
    const id = await open(wallet, 5_000_000n)
    expect((booted.indexer.channels.get(id)!.payer as string).toLowerCase()).toBe(wallet)

    const signature = "0x1234" as Hex
    const served = await call(id, async () => signature, "from a wallet")
    expect(served.status).toBe(200)
    const owed = BigInt(served.headers.get("x-offpeak-channel-owed")!)

    const voucher = await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: owed.toString(), sig: signature }) })
    expect(voucher.status).toBe(200)
    const state = await booted.stack.db.query<{ voucher_sig: string }>("SELECT voucher_sig FROM shared.channel_state WHERE channel_id = $1", [id])
    expect(state.rows[0]!.voucher_sig).toBe(signature)
    await send(keeper, contract("ChannelManager"), ChannelManagerAbi, "settleChannel", [id, { channelId: id, seq: 1n, cumulative: owed }, signature])
    expect((await channelOf(id)).claimed).toBe(owed)

    await rpc("anvil_setCode", [wallet, SAYS_NO])
    const refused = await call(id, async () => signature, "after it turned")
    expect(refused.status).toBe(401)
    await rpc("anvil_setCode", [wallet, "0x60006000fd"])
    expect((await call(id, async () => signature, "after it reverts")).status).toBe(401)
    await rpc("anvil_stopImpersonatingAccount", [wallet])
  }, 60_000)
})
