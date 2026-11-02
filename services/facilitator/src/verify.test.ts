import { describe, expect, test } from "bun:test"
import { PERMIT2, permitWitnessTypes } from "@offpeak/shared"
import { anvilAccount } from "../../../packages/shared/src/test-keys.ts"
import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { openDatabase, type Db } from "@offpeak/common"
import { Denylist } from "./denylist.ts"
import { ReadCache, verifyPayment, type PaymentPayload, type VerifyBody, type VerifyDeps } from "./verify.ts"

const NOW = 1_800_000_000
const VAULT = "0x00000000000000000000000000000000000000aa" as Address
const USDG = "0x00000000000000000000000000000000000000bb" as Address
const ESCROW = "0x00000000000000000000000000000000000000cc" as Address
const RELAY = "0x00000000000000000000000000000000000000dd" as Address
const agent = anvilAccount(19)
const OWNER = agent.address.toLowerCase()

type Chain = { allowance: bigint; balance: bigint; bitmap: bigint; relay: bigint; walletAnswer: Hex; calls: Record<string, number>; block: bigint }

function fakeChain(over: Partial<Chain> = {}) {
  const chain: Chain = { allowance: 10n ** 9n, balance: 10n ** 9n, bitmap: 0n, relay: 10n ** 18n, walletAnswer: "0x00000000", calls: {}, block: 1n, ...over }
  const reader = {
    getBlock: async () => ({ number: chain.block, timestamp: BigInt(NOW) }),
    getBalance: async () => chain.relay,
    readContract: async ({ functionName }: { functionName: string }) => {
      chain.calls[functionName] = (chain.calls[functionName] ?? 0) + 1
      if (functionName === "allowance") return chain.allowance
      if (functionName === "balanceOf") return chain.balance
      if (functionName === "nonceBitmap") return chain.bitmap
      if (functionName === "isValidSignature") return chain.walletAnswer
      throw new Error(functionName)
    },
  } as unknown as PublicClient
  return { chain, reader }
}

let nextReq = 0
async function uptoBody(over: { max?: bigint; witness?: Record<string, unknown>; payload?: Partial<PaymentPayload["payload"]>; top?: Partial<PaymentPayload> } = {}): Promise<VerifyBody> {
  const max = over.max ?? 1_000_000n
  const witness = {
    reqId: keccak256(toBytes(`req-${nextReq++}`)),
    payee: VAULT,
    maxAmount: max,
    validBefore: BigInt(NOW + 600),
    resourceHash: keccak256(toBytes("resource")),
    ...over.witness,
  }
  const message = {
    permitted: { token: USDG, amount: max },
    spender: ESCROW,
    nonce: 5n,
    deadline: BigInt(NOW + 600),
    witness,
  }
  const signature = await agent.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Address },
    types: permitWitnessTypes("UptoWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  } as never)
  return {
    paymentPayload: {
      x402Version: 2,
      scheme: "upto",
      payload: {
        signature,
        witness: { ...witness, maxAmount: max.toString(), validBefore: witness.validBefore.toString() },
        permitted: { token: USDG, amount: max.toString() },
        spender: ESCROW,
        nonce: "5",
        deadline: message.deadline.toString(),
        ...over.payload,
      },
      ...over.top,
    },
    paymentRequirements: { payTo: VAULT, asset: USDG, maxAmountRequired: max.toString() },
  }
}

async function setup(over: Partial<Chain> = {}, denied: string[] = []) {
  const db: Db = await openDatabase("pglite://memory")
  const { chain, reader } = fakeChain(over)
  const denylist = new Denylist()
  ;(denylist as unknown as { denied: Set<string> }).denied = new Set(denied)
  const deps: VerifyDeps = { db, reader, usdg: USDG, vault: VAULT, escrow: ESCROW, relay: RELAY, relayFloorWei: 1000n, denylist }
  return { deps, chain, cache: new ReadCache(reader, 0) }
}

const refused = async (body: VerifyBody, reason: string, over: Partial<Chain> = {}, denied: string[] = []) => {
  const { deps, cache } = await setup(over, denied)
  expect((await verifyPayment(deps, cache, body)).invalidReason).toBe(reason)
}

describe("verify", () => {
  test("a good payload passes and names the payer", async () => {
    const { deps, cache } = await setup()
    expect(await verifyPayment(deps, cache, await uptoBody())).toEqual({ isValid: true, payer: OWNER })
  })

  test("x402 v1 and an unset version are accepted, others are not", async () => {
    const { deps, cache } = await setup()
    expect((await verifyPayment(deps, cache, await uptoBody({ top: { x402Version: 1 } }))).isValid).toBe(true)
    expect((await verifyPayment(deps, cache, await uptoBody({ top: { x402Version: undefined } }))).isValid).toBe(true)
    await refused(await uptoBody({ top: { x402Version: 3 } }), "unsupported_version")
  })

  test("the scheme must be one the facilitator settles", async () => {
    await refused(await uptoBody({ top: { scheme: "stream" } }), "unsupported_scheme")
    await refused(await uptoBody({ top: { scheme: "channel" } }), "use_channel_header")
  })

  test("the network must be Robinhood Chain", async () => {
    await refused(await uptoBody({ top: { network: "eip155:1" } }), "wrong_network")
  })

  test("the asset must be USDG, on both sides", async () => {
    const other = "0x00000000000000000000000000000000000000ee" as Address
    await refused(await uptoBody({ payload: { permitted: { token: other, amount: "1000000" } } }), "wrong_asset")
    const body = await uptoBody()
    body.paymentRequirements.asset = other
    await refused(body, "wrong_asset")
  })

  test("the money must be going to the vault, through the escrow", async () => {
    await refused(await uptoBody({ witness: { payee: RELAY } }), "wrong_payee")
    await refused(await uptoBody({ payload: { spender: RELAY } }), "wrong_spender")
  })

  test("the permit must cover the witness and the request", async () => {
    await refused(await uptoBody({ payload: { permitted: { token: USDG, amount: "999999" } } }), "wrong_amount")
    const body = await uptoBody()
    body.paymentRequirements.maxAmountRequired = "1000001"
    await refused(body, "amount_too_low")
    await refused(await uptoBody({ max: 49_999n }), "max_too_low")
  })

  test("timing bounds are exact", async () => {
    await refused(await uptoBody({ payload: { deadline: String(NOW + 29) } }), "deadline")
    await refused(await uptoBody({ witness: { validBefore: BigInt(NOW + 59) } }), "valid_before")
  })

  test("a tampered witness recovers a stranger, never the signer", async () => {
    const body = await uptoBody()
    body.paymentPayload.payload.witness.resourceHash = keccak256(toBytes("other"))
    const { deps, cache } = await setup()
    const result = await verifyPayment(deps, cache, body)
    expect(result.isValid).toBe(true)
    expect(result.payer).not.toBe(OWNER)
  })

  test("a claimed payer must match what the signature recovers", async () => {
    const claimed = anvilAccount(3).address
    await refused(await uptoBody({ payload: { payer: claimed } }), "bad_signature")
  })

  test("a contract wallet passes through EIP-1271", async () => {
    const wallet = anvilAccount(3).address
    const { deps, cache, chain } = await setup({ walletAnswer: "0x1626ba7e" })
    const body = await uptoBody({ payload: { payer: wallet } })
    expect(await verifyPayment(deps, cache, body)).toEqual({ isValid: true, payer: wallet.toLowerCase() })
    expect(chain.calls.isValidSignature).toBe(1)
  })

  test("a used Permit2 nonce is refused", async () => {
    await refused(await uptoBody(), "nonce_used", { bitmap: 1n << 5n })
  })

  test("allowance, balance and the deny list each refuse", async () => {
    await refused(await uptoBody(), "allowance", { allowance: 999_999n })
    await refused(await uptoBody(), "balance", { balance: 999_999n })
    await refused(await uptoBody(), "denied", {}, [OWNER])
  })

  test("a payload is accepted once, even before the chain sees it", async () => {
    const { deps, cache } = await setup()
    const body = await uptoBody()
    expect((await verifyPayment(deps, cache, body)).isValid).toBe(true)
    expect((await verifyPayment(deps, cache, body)).invalidReason).toBe("req_id_used")
  })

  test("a relay low on gas turns away upto, so the router offers channels only", async () => {
    await refused(await uptoBody(), "facilitator_unavailable", { relay: 999n })
  })

  test("garbage is refused rather than thrown", async () => {
    const body = await uptoBody()
    body.paymentPayload.payload.deadline = "soon"
    await refused(body, "malformed")
  })

  async function exactBody(amount: bigint, quote: bigint, name: string): Promise<VerifyBody> {
    const witness = { reqId: keccak256(toBytes(name)), payee: VAULT, amount, validBefore: BigInt(NOW + 600), resourceHash: keccak256(toBytes("r")) }
    const typed = {
      domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 as Address },
      types: permitWitnessTypes("ExactWitness"),
      primaryType: "PermitWitnessTransferFrom",
      message: { permitted: { token: USDG, amount }, spender: ESCROW, nonce: 9n, deadline: BigInt(NOW + 600), witness },
    } as never
    return {
      paymentPayload: {
        scheme: "exact",
        payload: {
          signature: await agent.signTypedData(typed),
          witness: { ...witness, amount: amount.toString(), validBefore: witness.validBefore.toString() },
          permitted: { token: USDG, amount: amount.toString() },
          spender: ESCROW,
          nonce: "9",
          deadline: String(NOW + 600),
        },
      },
      paymentRequirements: { payTo: VAULT, asset: USDG, maxAmountRequired: quote.toString() },
    }
  }

  test("exact needs no minimum and signs its own witness", async () => {
    const { deps, cache } = await setup()
    expect(await verifyPayment(deps, cache, await exactBody(40_000n, 40_000n, "exact"))).toEqual({ isValid: true, payer: OWNER })
  })

  test("exact may pass the quote by the margin and no further", async () => {
    const { deps, cache } = await setup()
    expect(await verifyPayment(deps, cache, await exactBody(48_000n, 40_000n, "exact-margin"))).toEqual({ isValid: true, payer: OWNER })
    await refused(await exactBody(48_001n, 40_000n, "exact-over"), "amount_too_high")
  })

  test("a 100 USDG exact on a 0.001 USDG quote is refused and leaves no claim", async () => {
    const { deps, cache } = await setup()
    const body = await exactBody(100_000_000n, 1_000n, "exact-huge")
    expect((await verifyPayment(deps, cache, body)).invalidReason).toBe("amount_too_high")
    expect((await deps.db.query("SELECT 1 FROM chain.x402_claims")).rows.length).toBe(0)
  })
})

describe("read cache", () => {
  test("a burst inside one block costs one read of each kind", async () => {
    const { deps, chain } = await setup()
    const cache = new ReadCache(deps.reader, 1_000)
    const bodies = await Promise.all(Array.from({ length: 50 }, () => uptoBody()))
    await Promise.all(bodies.map((body) => verifyPayment(deps, cache, body)))
    expect(chain.calls.allowance).toBe(1)
    expect(chain.calls.balanceOf).toBe(1)
    expect(chain.calls.nonceBitmap).toBe(1)
  })

  test("a new block reads again", async () => {
    const { deps, chain } = await setup()
    const cache = new ReadCache(deps.reader, 0)
    await verifyPayment(deps, cache, await uptoBody())
    chain.block += 1n
    await verifyPayment(deps, cache, await uptoBody())
    expect(chain.calls.allowance).toBe(2)
  })

  test("verify stays inside its budget with a warm cache", async () => {
    const { deps } = await setup()
    const cache = new ReadCache(deps.reader, 1_000)
    const bodies = await Promise.all(Array.from({ length: 100 }, () => uptoBody()))
    const times: number[] = []
    for (const body of bodies) {
      const started = performance.now()
      await verifyPayment(deps, cache, body)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expect(times[94]!).toBeLessThan(40)
  })
})

describe("deny list", () => {
  test("a failed refresh keeps the last good list", async () => {
    let up = true
    const server = Bun.serve({
      port: 0,
      fetch: () => (up ? Response.json([OWNER.toUpperCase().replace("0X", "0x")]) : new Response("down", { status: 500 })),
    })
    const list = new Denylist(`http://127.0.0.1:${server.port}/`)
    await list.refresh()
    expect(list.has(OWNER)).toBe(true)
    up = false
    await list.refresh()
    expect(list.has(OWNER)).toBe(true)
    server.stop(true)
  })
})
