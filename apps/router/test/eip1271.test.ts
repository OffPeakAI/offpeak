import { describe, expect, test } from "bun:test"
import { channelAuthHeader, channelAuthMessage, coopCloseTypes, domain, voucherTypes, type ChannelChain } from "@offpeak/shared"
import { hashMessage, hashTypedData, keccak256, toBytes, type Hex } from "viem"
import { WALLET_CHECK_MS, rpcWallets, type WalletChain } from "../src/pay/signatures.ts"
import { admitChannel } from "../src/pay/channel.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const id = keccak256(toBytes("wallet-channel"))
const wallet = "0x00000000000000000000000000000000000c0de1" as Hex
/** A contract wallet's owner. Its signatures do not recover to the wallet. */
const owner = roleAccount("settlerA")

function openChannel(booted: Booted, payer: Hex = wallet, deposit = 50_000_000n) {
  const row: ChannelChain = { payer, deposit, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false }
  booted.indexer.channels.set(id, row)
  return row
}

/** A wallet that says yes to whatever its owner signed, for as long as `open` stays true. */
function fakeWallet(opts: { delayMs?: number; code?: boolean } = {}) {
  const calls = { code: 0, sig: 0 }
  const state = { open: true, approved: new Set<string>() }
  const chain: WalletChain = {
    hasCode: async () => {
      calls.code += 1
      return opts.code ?? true
    },
    isValidSignature: async (_address, digest) => {
      calls.sig += 1
      if (opts.delayMs) await Bun.sleep(opts.delayMs)
      return state.open && state.approved.has(digest)
    },
  }
  return { chain, calls, state }
}

const request = (booted: Booted, headers: Record<string, string>, body: string) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, ...headers }, body })
const chatBody = (text: string) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: text }], max_tokens: 8 })

/** The header a contract wallet produces: the owner's signature, on a digest the wallet approved. */
async function walletProof(booted: Booted, fake: ReturnType<typeof fakeWallet>, body: string) {
  const ts = booted.stack.clock()
  const nonce = crypto.randomUUID()
  const message = channelAuthMessage({ channelId: id, ts, nonce, bodyHash: keccak256(toBytes(body)) })
  fake.state.approved.add(hashMessage(message))
  return Buffer.from(JSON.stringify({ ts, nonce, sig: await owner.signMessage({ message }) })).toString("base64url")
}

describe("contract wallets", () => {
  test("a request proof is checked with the wallet", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const fake = fakeWallet()
    booted.stack.wallets = fake.chain
    const body = chatBody("hello")
    expect((await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, body) }, body)).status).toBe(200)
    expect(fake.calls.sig).toBe(1)
  })

  test("a voucher from a wallet lands in channel_state like any other", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const fake = fakeWallet()
    booted.stack.wallets = fake.chain
    const body = chatBody("first")
    const first = await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, body) }, body)
    const owed = BigInt(first.headers.get("x-offpeak-channel-owed")!)
    const typed = { domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: owed } } as const
    const sig = await owner.signTypedData(typed)
    const refused = await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: owed.toString(), sig }) })
    expect(refused.status).toBe(402)
    fake.state.approved.add(hashTypedData(typed))
    expect((await booted.app.request(`/v1/channels/${id}/voucher`, { method: "POST", body: JSON.stringify({ seq: "1", cumulative: owed.toString(), sig }) })).status).toBe(200)
    const state = await booted.stack.db.query<{ cumulative: string }>("SELECT cumulative FROM shared.channel_state WHERE channel_id = $1", [id])
    expect(BigInt(state.rows[0]!.cumulative)).toBe(owed)
  })

  test("a wallet can sign a cooperative close", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const fake = fakeWallet()
    booted.stack.wallets = fake.chain
    const deadline = BigInt(booted.stack.clock() + 600)
    const typed = { domain: domain("OffpeakChannel", booted.stack.channelManager), types: coopCloseTypes, primaryType: "CooperativeClose", message: { channelId: id, finalCumulative: 0n, deadline } } as const
    const payerSig = await owner.signTypedData(typed)
    const send = () => booted.app.request(`/v1/channels/${id}/close`, { method: "POST", body: JSON.stringify({ finalCumulative: "0", deadline: deadline.toString(), payerSig }) })
    expect((await send()).status).toBe(401)
    fake.state.approved.add(hashTypedData(typed))
    expect((await send()).status).toBe(200)
  })

  test("an answer that changes is seen on the next request, because nothing is cached", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const fake = fakeWallet()
    booted.stack.wallets = fake.chain
    const one = chatBody("one")
    expect((await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, one) }, one)).status).toBe(200)
    fake.state.open = false
    const two = chatBody("two")
    expect((await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, two) }, two)).status).toBe(401)
  })

  test("vouchers a wallet has not landed use up its credit, so a wallet that turns cannot run past the limit", () => {
    const base = { status: 1, expiry: 1_000_000, closeRequested: false, now: 0, deposit: 50_000_000n, voucherCumulative: 10_000_000n, unvouchered: 0n, newMax: 100_000n }
    expect(admitChannel(base).ok).toBe(true)
    expect(admitChannel({ ...base, unlanded: 200_000n })).toEqual({ ok: false, error: "credit_limit" })
    expect(admitChannel({ ...base, unlanded: 150_000n }).ok).toBe(true)
  })
