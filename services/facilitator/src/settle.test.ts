import { describe, expect, test } from "bun:test"
import { Metrics, openDatabase, type Db } from "@offpeak/common"
import { PERMIT2, permitWitnessTypes } from "@offpeak/shared"
import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { authorize, release, waitAuthorized } from "../../../apps/router/src/pay/authorize.ts"
import { sweepExact } from "../../../apps/router/src/pay/captures.ts"
import { LiveFacilitator } from "../../../apps/router/src/pay/facilitator.ts"
import { anvilAccount } from "../../../packages/shared/src/test-keys.ts"
import { applyX402Escrow } from "../../indexer/src/apply/X402Escrow.ts"
import { escrowView, type EscrowRow } from "../../indexer/src/views.ts"
import { facilitatorApp } from "./app.ts"
import { Denylist } from "./denylist.ts"

const NOW = 1_800_000_000
const VAULT = "0x00000000000000000000000000000000000000aa" as Address
const USDG = "0x00000000000000000000000000000000000000bb" as Address
const ESCROW = "0x00000000000000000000000000000000000000cc" as Address
const RELAY = "0x00000000000000000000000000000000000000dd" as Address
const TOKEN = "t".repeat(32)
const payerKey = anvilAccount(19)
const PAYER = payerKey.address.toLowerCase()
const VERIFIED = 100_000_000n
const SENT = 1n
const hash = (value: string) => keccak256(toBytes(value))

async function exactPayload(reqId: Hex, amount: bigint, nonce: bigint) {
  const witness = { reqId, payee: VAULT, amount, validBefore: BigInt(NOW + 600), resourceHash: `0x${"00".repeat(32)}` as Hex }
  const message = { permitted: { token: USDG, amount }, spender: ESCROW, nonce, deadline: BigInt(NOW + 600), witness }
  const signature = await payerKey.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Address },
    types: permitWitnessTypes("ExactWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  } as never)
  return {
    x402Version: 2,
    scheme: "exact",
    payload: {
      signature,
      witness: { ...witness, amount: amount.toString(), validBefore: witness.validBefore.toString() },
      permitted: { token: USDG, amount: amount.toString() },
      spender: ESCROW,
      nonce: nonce.toString(),
      deadline: message.deadline.toString(),
    },
  }
}

const reader = {
  getBlock: async () => ({ number: 1n, timestamp: BigInt(NOW) }),
  getBalance: async () => 10n ** 18n,
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "allowance" || functionName === "balanceOf") return VERIFIED
    if (functionName === "nonceBitmap") return 0n
    throw new Error(functionName)
  },
} as unknown as PublicClient

async function setup() {
  const db = await openDatabase("pglite://memory")
  await db.exec(`CREATE SCHEMA IF NOT EXISTS serving; CREATE TABLE serving.x402_requests (req_id text PRIMARY KEY, payer text NOT NULL, max_amount bigint NOT NULL, status text NOT NULL, preconfirm_stall_ms integer, valid_before bigint, created_at bigint NOT NULL DEFAULT 0);`)
  const enqueued: { mode: string; amount: string }[] = []
  const batcher = { enqueue: (mode: string, item: { payload: { permitted: { amount: string } } }) => enqueued.push({ mode, amount: item.payload.permitted.amount }) }
  const app = facilitatorApp({
    verify: { db, reader, usdg: USDG, vault: VAULT, escrow: ESCROW, relay: RELAY, relayFloorWei: 1n, denylist: new Denylist() },
    db,
    batcher: batcher as never,
    captures: {} as never,
    internalToken: TOKEN,
    metrics: new Metrics(),
  })
  const call = async (path: string, body: unknown, token: string | null = TOKEN) =>
    app.request(path, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) })
  const post = async (path: string, body: unknown) => (await call(path, body)).json() as Promise<Record<string, unknown>>
  return { db, enqueued, call, post }
}

function routerStack(db: Db, post: (path: string, body: unknown) => Promise<Record<string, unknown>>, onSlot?: () => Promise<void>) {
  return {
    clock: () => NOW,
    db,
    vault: VAULT,
    usdg: USDG,
    preconfirmTimeoutMs: 50,
    authWaiters: new Map(),
    authResults: new Map(),
    counters: {
      add: async () => {
        const run = onSlot
        onSlot = undefined
        await run?.()
        return 1n
      },
    },
    facilitator: { verify: (body: unknown) => post("/x402/verify", body), settle: (body: unknown) => post("/x402/settle", body) },
    indexer: { escrow: async (reqId: string) => escrowView((await db.query<EscrowRow>("SELECT * FROM chain.escrows WHERE req_id = $1", [reqId])).rows[0]) },
  } as never
}

const verifyBody = (payment: unknown, required = VERIFIED) => ({ paymentPayload: payment, paymentRequirements: { payTo: VAULT, asset: USDG, maxAmountRequired: required.toString() } })

describe("verify and settle need the internal token", () => {
  for (const path of ["/x402/verify", "/x402/settle"]) {
    for (const token of [null, "wrong"]) {
      test(`${path} refuses ${token ?? "no token"}`, async () => {
        const { db, enqueued, call } = await setup()
        const payment = await exactPayload(hash("noauth"), VERIFIED, 1n)
        const res = await call(path, path.endsWith("verify") ? verifyBody(payment) : { paymentPayload: payment, mode: "exact" }, token)
        expect(res.status).toBe(401)
        expect((await db.query("SELECT 1 FROM chain.x402_claims")).rows.length).toBe(0)
        expect(enqueued).toEqual([])
      })
    }
  }

  test("the router's client sends the token", async () => {
    const seen: (string | null)[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"))
      return Response.json({})
    }) as never
    try {
      const client = new LiveFacilitator({ url: "http://facilitator", token: TOKEN })
      await client.verify({} as never)
      await client.settle({} as never)
    } finally {
      globalThis.fetch = real
    }
    expect(seen).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
  })
})

describe("settle takes only the payload verify accepted", () => {
  test("a settle for a reqId nobody verified is refused", async () => {
    const { post, enqueued } = await setup()
    const reply = await post("/x402/settle", { paymentPayload: await exactPayload(hash("unseen"), SENT, 1n), mode: "exact" })
    expect(reply.errorReason).toBe("not_verified")
    expect(enqueued).toEqual([])
  })

  test("the router's own payload is queued and nothing is refunded", async () => {
    const { db, post, enqueued } = await setup()
    const stack = routerStack(db, post)
    const payment = await exactPayload(hash("honest"), VERIFIED, 2n)
    const pay = await authorize(stack, { mode: 2, wallet: PAYER as Hex, payment: payment as never, feeBps: 400 }, 1_000n, "{}")
    expect(pay).toMatchObject({ kind: "exact", paid: VERIFIED })
    await Bun.sleep(5)
    expect(enqueued).toEqual([{ mode: "exact", amount: VERIFIED.toString() }])
    await sweepExact(stack)
    expect((await db.query("SELECT 1 FROM shared.refunds")).rows.length).toBe(0)
  })

  test("a different payload under a claimed reqId is refused and the verified one still goes through", async () => {
    const { db, post, enqueued } = await setup()
    const reqId = hash("swap")
    const small = await exactPayload(reqId, SENT, 3n)
    const replies: Record<string, unknown>[] = []
    const stack = routerStack(db, post, async () => void replies.push(await post("/x402/settle", { paymentPayload: small, mode: "exact" })))
    const payment = await exactPayload(reqId, VERIFIED, 4n)
    await authorize(stack, { mode: 2, wallet: PAYER as Hex, payment: payment as never, feeBps: 400 }, 1_000n, "{}")
    await Bun.sleep(5)
    expect(replies[0]).toMatchObject({ success: false, errorReason: "payload_mismatch" })
    expect(enqueued).toEqual([{ mode: "exact", amount: VERIFIED.toString() }])
  })

  test("a malformed payload under a claimed reqId is refused", async () => {
    const { post, enqueued } = await setup()
    const payment = await exactPayload(hash("junk"), VERIFIED, 5n)
    await post("/x402/verify", verifyBody(payment))
    const junk = { ...payment, payload: { ...payment.payload, nonce: "not a number" } }
    expect(await post("/x402/settle", { paymentPayload: junk, mode: "exact" })).toMatchObject({ errorReason: "payload_mismatch" })
    expect(enqueued).toEqual([])
  })
})

describe("the exact sweep refunds what the chain took", () => {
  test("a refund is the captured amount, not the amount noted at verify", async () => {
    const { db, post } = await setup()
    const reqId = hash("short")
    const stack = routerStack(db, post)
    const payment = await exactPayload(reqId, VERIFIED, 6n)
    const pay = await authorize(stack, { mode: 2, wallet: PAYER as Hex, payment: payment as never, feeBps: 400 }, 1_000n, "{}")
    if (pay instanceof Response) throw new Error("refused")
    await waitAuthorized(stack, reqId, 10)
    await release(stack, pay)
    await applyX402Escrow(db, { txHash: hash("exact"), logIndex: 0, blockNumber: 2n, blockTs: NOW, contract: "X402Escrow", event: "ExactSettled", args: { reqId, payer: PAYER, amount: SENT.toString() } })
    await sweepExact(stack)
    const refunds = await db.query<{ amount: string }>("SELECT amount FROM shared.refunds")
    expect(refunds.rows.map((r) => BigInt(r.amount))).toEqual([SENT])
  })
})
