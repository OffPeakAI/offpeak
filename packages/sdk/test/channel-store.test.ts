import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { CHAIN_ID } from "../../shared/src/index.ts"
import { anvilAccount } from "../../shared/src/test-keys.ts"
import { addressOf } from "../../abis/src/index.ts"
import { Offpeak, fileChannelStore, type ChannelStore, type WalletLike } from "../src/index.ts"

const KEY = `0x${Buffer.from(anvilAccount(3).getHdKey().privateKey!).toString("hex")}` as `0x${string}`
const DEPOSIT = 25_000_000n
const FAR = () => BigInt(Math.floor(Date.now() / 1000) + 86_400)

const dir = mkdtempSync(join(tmpdir(), "offpeak-channel-"))
let files = 0
const stateFile = () => join(dir, `channel-${files++}.json`)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A chain with one wallet on it. Channels it opens stay open until `end` says otherwise. */
function chainStub() {
  const account = privateKeyToAccount(KEY)
  const calls: { functionName: string; args: unknown[] }[] = []
  const channel = { status: 1, expiry: FAR(), failing: false }
  const wallet = {
    account,
    chain: null,
    getChainId: async () => CHAIN_ID,
    writeContract: async (call: { functionName: string; args: unknown[] }) => {
      calls.push(call)
      return `0x${calls.length.toString(16).padStart(64, "0")}`
    },
    signMessage: (args: { message: string }) => account.signMessage(args),
    signTypedData: (args: never) => account.signTypedData(args),
  }
  const reader = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== "channelView") return 0n
      if (channel.failing) throw new Error("rpc down")
      return { payer: account.address, deposit: DEPOSIT, claimed: 0n, lastSeq: 0n, expiry: channel.expiry, status: channel.status }
    },
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }
  const opens = () => calls.filter((call) => call.functionName === "open")
  return { wallet, reader, opens, channel }
}

const processStart = (chain: ReturnType<typeof chainStub>, store?: ChannelStore) => {
  const send = (async (input: RequestInfo | URL) => (String(input).includes("/v1/channels/") ? Response.json({ deposit: "1", claimed: "0", cumulative: "0", owed: "0", latestSeq: "0", status: 1, expiry: "1" }) : Response.json({ error: { message: "x" } }, { status: 503 }))) as typeof fetch
  return new Offpeak({ baseURL: "http://router.test", wallet: chain.wallet as unknown as WalletLike, publicClient: chain.reader as never, deployment: "local", router: addressOf("UsageLedger"), channel: { deposit: DEPOSIT, store }, fetch: send })
}

const firstCall = (op: Offpeak) => op.chat({ model: "m", messages: [{ role: "user", content: "x" }] }).catch((err) => err as { code: string })

describe("a deposit across restarts", () => {
  test("three sessions on one state file fund one channel", async () => {
    const chain = chainStub()
    const path = stateFile()
    for (let session = 0; session < 3; session++) await firstCall(processStart(chain, fileChannelStore(path)))
    expect(chain.opens()).toHaveLength(1)
  })

  test("one process reuses its channel", async () => {
    const chain = chainStub()
    const op = processStart(chain, fileChannelStore(stateFile()))
    for (let i = 0; i < 3; i++) await firstCall(op)
    expect(chain.opens()).toHaveLength(1)
  })

  test("a restart picks up the sequence number it kept", async () => {
    const path = stateFile()
    const chain = chainStub()
    const before = processStart(chain, fileChannelStore(path))
    await firstCall(before)
    const { id } = before.channels.snapshot()!
    fileChannelStore(path).save({ id, seq: 9n, cumulative: 400n })
    const after = processStart(chain, fileChannelStore(path))
    await firstCall(after)
    expect(after.channels.snapshot()).toMatchObject({ id, seq: 9n, signed: 400n })
  })

  test("a closed channel gets a new deposit", async () => {
    const chain = chainStub()
    const path = stateFile()
    await firstCall(processStart(chain, fileChannelStore(path)))
    chain.channel.status = 3
    await firstCall(processStart(chain, fileChannelStore(path)))
    expect(chain.opens()).toHaveLength(2)
  })

  test("a channel the router would refuse as near expiry gets a new deposit", async () => {
    const chain = chainStub()
    const path = stateFile()
    await firstCall(processStart(chain, fileChannelStore(path)))
    chain.channel.expiry = BigInt(Math.floor(Date.now() / 1000) + 60)
    await firstCall(processStart(chain, fileChannelStore(path)))
    expect(chain.opens()).toHaveLength(2)
  })

  test("a kept channel that cannot be read stops the start, with no deposit", async () => {
    const chain = chainStub()
    const path = stateFile()
    await firstCall(processStart(chain, fileChannelStore(path)))
    chain.channel.failing = true
    await firstCall(processStart(chain, fileChannelStore(path)))
    expect(chain.opens()).toHaveLength(1)
  })

  test("a damaged state file stops the start, with no deposit", async () => {
    const chain = chainStub()
    const path = stateFile()
    writeFileSync(path, "not json")
    const failure = await firstCall(processStart(chain, fileChannelStore(path)))
    expect(failure).toMatchObject({ code: "bad_channel_state" })
    expect(chain.opens()).toHaveLength(0)
  })

  test("the id is on disk before the deposit moves", async () => {
    const chain = chainStub()
    const path = stateFile()
    const wallet = { ...chain.wallet, writeContract: async (call: { functionName: string; args: unknown[] }) => {
      if (call.functionName === "open") throw new Error("crashed mid-deposit")
      return chain.wallet.writeContract(call)
    } }
    await firstCall(processStart({ ...chain, wallet }, fileChannelStore(path)))
    expect(JSON.parse(readFileSync(path, "utf8")).id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("without a store a process still opens its own channel", async () => {
    const chain = chainStub()
    await firstCall(processStart(chain))
    expect(chain.opens()).toHaveLength(1)
  })
})
