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
