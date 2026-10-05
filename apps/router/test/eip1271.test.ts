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

  test("a wallet stops at its credit limit until its vouchers are on chain", async () => {
    const booted = await bootStack()
    const row = openChannel(booted, wallet, 2_000_000n)
    const fake = fakeWallet()
    booted.stack.wallets = fake.chain
    await booted.stack.db.query("INSERT INTO shared.channel_state (channel_id, payer, latest_seq, cumulative, voucher_sig) VALUES ($1,$2,1,199995,'0x')", [id, wallet])
    const body = chatBody("over")
    const refused = await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, body) }, body)
    expect(refused.status).toBe(402)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("credit_limit")
    row.claimed = 199_995n
    const again = chatBody("landed")
    expect((await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, again) }, again)).status).toBe(200)
  })

  test("a wallet slower than the limit is refused in time, as unavailable rather than as a forgery", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const fake = fakeWallet({ delayMs: WALLET_CHECK_MS * 4 })
    booted.stack.wallets = fake.chain
    const body = chatBody("slow")
    const proof = await walletProof(booted, fake, body)
    const t0 = performance.now()
    const res = await request(booted, { "x-offpeak-channel-auth": proof }, body)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("verify_unavailable")
    expect(performance.now() - t0).toBeLessThan(WALLET_CHECK_MS * 3)
  })

  test("with no chain access a contract wallet is refused, not trusted", async () => {
    const booted = await bootStack()
    openChannel(booted)
    const fake = fakeWallet()
    const body = chatBody("no rpc")
    expect((await request(booted, { "x-offpeak-channel-auth": await walletProof(booted, fake, body) }, body)).status).toBe(401)
  })
})

describe("ordinary keys", () => {
  test("a good EOA signature makes no chain call at all", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer as Hex)
    const fake = fakeWallet()
    booted.stack.wallets = fake.chain
    const body = chatBody("eoa")
    const auth = await channelAuthHeader(roleAccount("buyer"), { channelId: id, ts: booted.stack.clock(), body })
    expect((await request(booted, { "x-offpeak-channel-auth": auth }, body)).status).toBe(200)
    expect(fake.calls).toEqual({ code: 0, sig: 0 })
  })

  test("bad signatures on an EOA cost one code read, and never a wallet call", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer as Hex)
    const fake = fakeWallet({ code: false })
    booted.stack.wallets = fake.chain
    for (let i = 0; i < 5; i++) {
      const body = chatBody(`forged ${i}`)
      const auth = await channelAuthHeader(roleAccount("host"), { channelId: id, ts: booted.stack.clock(), body })
      expect((await request(booted, { "x-offpeak-channel-auth": auth }, body)).status).toBe(401)
    }
    expect(fake.calls).toEqual({ code: 1, sig: 0 })
  })

  test("a proof cannot be replayed in its other signature form", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer as Hex)
    const body = chatBody("once")
    const auth = await channelAuthHeader(roleAccount("buyer"), { channelId: id, ts: booted.stack.clock(), body })
    expect((await request(booted, { "x-offpeak-channel-auth": auth }, body)).status).toBe(200)
    const proof = JSON.parse(Buffer.from(auth, "base64url").toString("utf8")) as { ts: number; nonce: string; sig: Hex }
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const s = BigInt(`0x${proof.sig.slice(66, 130)}`)
    const flipped = `${proof.sig.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${proof.sig.slice(130) === "1b" ? "1c" : "1b"}`
    const twin = Buffer.from(JSON.stringify({ ...proof, sig: flipped })).toString("base64url")
    expect((await request(booted, { "x-offpeak-channel-auth": twin }, body)).status).toBe(401)
  })
})

describe("the RPC wallet check", () => {
  const rpcServer = (port: number, handle: (method: string, params: unknown[]) => unknown, delayMs = 0) =>
    Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const { id: rpcId, method, params } = (await req.json()) as { id: number; method: string; params: unknown[] }
        if (delayMs) await Bun.sleep(delayMs)
        const reply = handle(method, params)
        return Response.json(reply instanceof Error ? { jsonrpc: "2.0", id: rpcId, error: { code: 3, message: reply.message } } : { jsonrpc: "2.0", id: rpcId, result: reply })
      },
    })
  const digest = keccak256(toBytes("digest"))
  const magic = "0x1626ba7e00000000000000000000000000000000000000000000000000000000"

  test("a yes needs the exact magic value, and a revert is a no", async () => {
    let answer: unknown = magic
    const server = rpcServer(34501, (method) => (method === "eth_getCode" ? "0x60" : answer))
    const wallets = rpcWallets("http://127.0.0.1:34501")
    expect(await wallets.hasCode(wallet)).toBe(true)
    expect(await wallets.isValidSignature(wallet, digest, "0x1234")).toBe(true)
    answer = "0xffffffff00000000000000000000000000000000000000000000000000000000"
    expect(await wallets.isValidSignature(wallet, digest, "0x1234")).toBe(false)
    answer = new Error("execution reverted")
    expect(await wallets.isValidSignature(wallet, digest, "0x1234")).toBe(false)
    server.stop(true)
  })

  test("a node that does not answer in time is a failure, not a no", async () => {
    const server = rpcServer(34502, () => magic, WALLET_CHECK_MS * 3)
    const wallets = rpcWallets("http://127.0.0.1:34502")
    await expect(wallets.isValidSignature(wallet, digest, "0x1234")).rejects.toThrow()
    server.stop(true)
  })
})
