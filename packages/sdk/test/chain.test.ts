import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ChannelManagerAbi, MockUSDGAbi, UsageLedgerAbi, X402EscrowAbi } from "@offpeak/abis"
import { channelAuthMessage, coopCloseTypes, domain, leafFor, merkleProof, merkleRoot, recoverPersonal, type ChannelChain, type PaymentPayload } from "@offpeak/shared"
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex, type PublicClient, type WalletClient } from "viem"
import { startLocalChain, type LocalChain } from "../../../tests/integration/local-chain.ts"
import { anvilAccount } from "../../shared/src/test-keys.ts"
import { ask, BASE, bootRouter, chainView, channelRow, costOf, inProcess, type Booted } from "./support.ts"
import { Offpeak, type ChatResult, type CloseResult, type OffpeakOptions } from "../src/index.ts"

const PORT = 35_000 + Math.floor(Math.random() * 1000)
const USDG = 1_000_000n
const agent = anvilAccount(18)
const payee = anvilAccount(14)
const relay = anvilAccount(11)
const stranger = anvilAccount(15)
const nowish = () => Math.floor(Date.now() / 1000)

let chain: LocalChain
let reader: PublicClient
let wallet: WalletClient
let booted: Booted

const contract = (name: string) => chain.contracts[name]!

const channelOf = (id: Hex) => reader.readContract({ address: contract("ChannelManager"), abi: ChannelManagerAbi, functionName: "channelView", args: [id] })
const usdgOf = (who: Address) => reader.readContract({ address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "balanceOf", args: [who] })

async function rpc(method: string, params: unknown[]) {
  await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

type CloseHandler = (req: Request, id: Hex) => Promise<Response> | Response

/** What a correct router answers, for the tests that bend that answer. Everything else closes through the real router. */
const honestClose: CloseHandler = async (req, id) => {
  const { finalCumulative, deadline, payerSig } = (await req.json()) as { finalCumulative: string; deadline: string; payerSig: Hex }
  const close = { channelId: id, finalCumulative: BigInt(finalCumulative), deadline: BigInt(deadline) }
  const manager = contract("ChannelManager")
  const typed = { domain: domain("OffpeakChannel", manager), types: coopCloseTypes, primaryType: "CooperativeClose" as const, message: close }
  const signer = await recoverTypedDataAddress({ ...typed, signature: payerSig })
  if (signer !== agent.address) return Response.json({ error: { message: "Bad payer signature", type: "auth", code: "bad_signature" } }, { status: 401 })
  const routerSig = await payee.signTypedData(typed)
  const data = encodeFunctionData({ abi: ChannelManagerAbi, functionName: "cooperativeClose", args: [id, close, payerSig, routerSig] })
  return Response.json({ routerSig, to: manager, data, value: "0", chainId: 4663 })
}

function withCloseStub(handler: CloseHandler) {
  const send = inProcess(booted.app)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const match = /\/v1\/channels\/(0x[0-9a-f]{64})\/close$/.exec(String(input))
    return match ? handler(new Request(input, init), match[1] as Hex) : send(input, init)
  }) as typeof fetch
}

/** The real chain, except that the mock router's hosts register on the mock indexer. */
const chainWithHosts = () => {
  const hosts = chainView(booted)
  const read = ((args: { functionName: string }) => (args.functionName === "hostView" || args.functionName === "modelsOf" ? hosts.readContract(args as never) : reader.readContract(args as never))) as PublicClient["readContract"]
  return { ...reader, readContract: read } as PublicClient
}

const client = (close?: CloseHandler, opts: Partial<OffpeakOptions> = {}) => new Offpeak({ baseURL: BASE, wallet, publicClient: chainWithHosts(), deployment: "local", fetch: close ? withCloseStub(close) : inProcess(booted.app), ...opts })

async function openAndSpend(op: Offpeak) {
  const opened = await op.channels.open(2n * USDG, nowish() + 7 * 3600)
  const spent = costOf(((await op.chat(ask("on chain"))) as ChatResult).envelope) + costOf(((await op.chat(ask("twice"))) as ChatResult).envelope)
  return { id: opened.channelId, spent }
}

const challenged = (result: CloseResult) => {
  if (result.mode !== "challenge") throw new Error("expected the challenge path")
  return result
}

beforeAll(async () => {
  chain = await startLocalChain(PORT)
  reader = createPublicClient({ transport: http(chain.rpcUrl), pollingInterval: 50 }) as PublicClient
  wallet = createWalletClient({ account: agent, transport: http(chain.rpcUrl), pollingInterval: 50 })
  const hash = await wallet.writeContract({ account: agent, chain: null, address: contract("MockUSDG"), abi: MockUSDGAbi, functionName: "mint", args: [agent.address, 1_000n * USDG] })
  await reader.waitForTransactionReceipt({ hash })
  booted = await bootRouter()
  // These tests outlast a channel proof, so the router keeps real time.
  booted.stack.clock = nowish
  // The router reads this channel from the real chain instead of a mock row.
  booted.indexer.channel = async (id: string): Promise<ChannelChain | null> => {
    const view = await channelOf(id as Hex)
    return view.status === 0 ? null : ({ ...view, closeRequested: view.status === 2 } as ChannelChain)
  }
}, 120_000)

afterAll(() => chain?.stop())

describe("opening a channel", () => {
  test("approves, opens, and serves through the real contract view", async () => {
    const op = client()
    const before = await usdgOf(agent.address)
    const expiry = nowish() + 7 * 3600
    const opened = await op.channels.open(2n * USDG, expiry)
    const view = await channelOf(opened.channelId)
    expect(view).toMatchObject({ payer: agent.address, deposit: 2n * USDG, status: 1, expiry: BigInt(expiry) })
    expect(await usdgOf(agent.address)).toBe(before - 2n * USDG)
    const result = (await op.chat(ask("first on chain"))) as ChatResult
    expect(result.envelope.record.payRef).toBe(opened.channelId)
    expect((await channelRow(booted, opened.channelId))?.cumulative).toBe(costOf(result.envelope))
    await op.channels.close()
  })

  test("a raw account with an RPC URL works too", async () => {
    const op = client(undefined, { wallet: agent, publicClient: undefined, rpcUrl: chain.rpcUrl })
    const opened = await op.channels.open(2n * USDG, nowish() + 7 * 3600)
    expect((await channelOf(opened.channelId)).status).toBe(1)
    expect((await op.channels.close()).mode).toBe("cooperative")
  })

  test("the first chat opens the configured channel by itself", async () => {
    const op = client(undefined, { channel: { deposit: 2n * USDG, expirySeconds: 7 * 3600 } })
    const results = (await Promise.all([op.chat(ask("auto a")), op.chat(ask("auto b"))])) as ChatResult[]
    const id = op.channels.snapshot()!.id
    expect(results.map((row) => row.envelope.record.payRef)).toEqual([id, id])
    expect((await channelOf(id)).deposit).toBe(2n * USDG)
    await op.channels.close()
  })

  test("refuses a short channel and a small deposit before any transaction", async () => {
    const op = client()
    const before = await reader.getTransactionCount({ address: agent.address })
    await expect(op.channels.open(2n * USDG, nowish() + 3600)).rejects.toMatchObject({ code: "bad_channel" })
    await expect(op.channels.open(1n, nowish() + 7 * 3600)).rejects.toMatchObject({ code: "bad_channel" })
    expect(await reader.getTransactionCount({ address: agent.address })).toBe(before)
  })

  test("refuses a wallet on another chain", async () => {
    const otherChain = createWalletClient({ account: agent, transport: custom({ request: async () => "0x1" }) })
    const op = client(undefined, { wallet: otherChain, publicClient: reader })
    await expect(op.channels.open(2n * USDG, nowish() + 7 * 3600)).rejects.toMatchObject({ code: "wrong_chain" })
  })

  test("says plainly when the router has not seen a new channel, and keeps it", async () => {
    const op = client()
    const channel = booted.indexer.channel
    booted.indexer.channel = async () => null
    const slow = op.channels.open(2n * USDG, nowish() + 7 * 3600)
    const failed = await Promise.race([slow.catch((err) => err), Bun.sleep(30_000)])
    booted.indexer.channel = channel
    expect(failed).toMatchObject({ code: "channel_not_seen" })
    const id = op.channels.snapshot()!.id
    expect((failed as { detail: { channelId: string } }).detail.channelId).toBe(id)
    expect((await op.channels.close()).mode).toBe("cooperative")
  }, 40_000)
})
