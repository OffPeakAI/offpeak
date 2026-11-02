import type { Db } from "@offpeak/common"
import { CHAIN_ID, PERMIT2, UPTO_MIN_MAX_MICRO, permitWitnessTypes } from "@offpeak/shared"
import { concat, erc20Abi, getAddress, hashTypedData, isAddressEqual, keccak256, parseAbi, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem"
import type { Denylist } from "./denylist.ts"

const NETWORK = `eip155:${CHAIN_ID}`
const MIN_DEADLINE_S = 30
const MIN_VALID_S = 60
const EIP1271_MAGIC = "0x1626ba7e"
/** `exact` may pass the quote by this much. Excess comes back from the reserve, so it stays small. */
const EXACT_MARGIN_BPS = 2_000n
const permit2Abi = parseAbi(["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"])
const eip1271Abi = parseAbi(["function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)"])

export type PaymentPayload = {
  x402Version?: number
  network?: string
  scheme: string
  payload: {
    signature: Hex
    witness: Record<string, unknown>
    permitted: { token: Address; amount: string }
    spender: Address
    nonce: string
    deadline: string
    /** Needed only for a contract wallet, whose address cannot be recovered from a signature. */
    payer?: Address
  }
}

export type PaymentRequirements = { payTo: string; asset: string; network?: string; maxAmountRequired?: string; maxAmount?: string }
export type VerifyBody = { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }
export type VerifyResult = { isValid: boolean; invalidReason?: string; payer: string | null }

export type VerifyDeps = {
  db: Db
  reader: PublicClient
  usdg: Address
  vault: Address
  escrow: Address
  relay: Address
  relayFloorWei: bigint
  denylist: Denylist
}

type Head = { number: bigint; timestamp: number; at: number }

/** Chain reads are shared within a block, so a burst of requests costs one round of RPC. */
export class ReadCache {
  private head: Head | null = null
  private values = new Map<string, Promise<unknown>>()

  constructor(private reader: PublicClient, private headTtlMs = 100) {}

  async currentHead(): Promise<Head> {
    if (this.head && performance.now() - this.head.at < this.headTtlMs) return this.head
    const block = await this.reader.getBlock({ blockTag: "latest" })
    this.head = { number: block.number, timestamp: Number(block.timestamp), at: performance.now() }
    return this.head
  }

  async read<T>(key: string, load: (blockNumber: bigint) => Promise<T>): Promise<T> {
    const { number } = await this.currentHead()
    const scoped = `${number}:${key}`
    const cached = this.values.get(scoped)
    if (cached) return cached as Promise<T>
    if (this.values.size > 10_000) this.values.clear()
    const value = load(number)
    this.values.set(scoped, value)
    value.catch(() => this.values.delete(scoped))
    return value
  }
}

function typedMessage(payload: PaymentPayload["payload"], scheme: "upto" | "exact") {
  const w = payload.witness
  const witness =
    scheme === "exact"
      ? { reqId: w.reqId, payee: w.payee, amount: BigInt(String(w.amount)), validBefore: BigInt(String(w.validBefore)), resourceHash: w.resourceHash }
      : { reqId: w.reqId, payee: w.payee, maxAmount: BigInt(String(w.maxAmount)), validBefore: BigInt(String(w.validBefore)), resourceHash: w.resourceHash }
  return {
    domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 as Address },
    types: permitWitnessTypes(scheme === "exact" ? "ExactWitness" : "UptoWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: payload.permitted.token, amount: BigInt(payload.permitted.amount) },
      spender: payload.spender,
      nonce: BigInt(payload.nonce),
      deadline: BigInt(payload.deadline),
      witness,
    },
  } as const
}

/** What a claim binds: the signed terms and the signature, so settle queues only the payload verify accepted. */
export function payloadHash(payload: PaymentPayload["payload"], scheme: "upto" | "exact"): Hex {
  return keccak256(concat([hashTypedData(typedMessage(payload, scheme) as never), payload.signature]))
}

/** An EOA recovers. A contract wallet names itself and answers EIP-1271. */
async function recoverPayer(deps: VerifyDeps, payload: PaymentPayload["payload"], scheme: "upto" | "exact"): Promise<Address | null> {
  const typed = typedMessage(payload, scheme)
  const claimed = payload.payer ? getAddress(payload.payer) : null
  const recovered = await recoverTypedDataAddress({ ...typed, signature: payload.signature } as never).catch(() => null)
  if (recovered && (!claimed || isAddressEqual(recovered, claimed))) return recovered
  if (!claimed) return null
  const answer = await deps.reader
    .readContract({
      address: claimed,
      abi: eip1271Abi,
      functionName: "isValidSignature",
      args: [hashTypedData(typed as never), payload.signature],
    })
    .catch(() => null)
  return answer === EIP1271_MAGIC ? claimed : null
}

function checkTerms(deps: VerifyDeps, body: VerifyBody, now: number): string | null {
  const { paymentPayload: payment, paymentRequirements: required } = body
  const { payload } = payment
  if (payment.x402Version !== undefined && payment.x402Version !== 1 && payment.x402Version !== 2) return "unsupported_version"
  if (payment.scheme === "channel") return "use_channel_header"
  if (payment.scheme !== "upto" && payment.scheme !== "exact") return "unsupported_scheme"
  if ((payment.network ?? NETWORK) !== NETWORK || (required.network ?? NETWORK) !== NETWORK) return "wrong_network"
  if (!isAddressEqual(payload.permitted.token, deps.usdg) || !isAddressEqual(required.asset as Address, deps.usdg)) return "wrong_asset"
  const w = payload.witness
  if (!isAddressEqual(w.payee as Address, deps.vault) || !isAddressEqual(required.payTo as Address, deps.vault)) return "wrong_payee"
  if (!isAddressEqual(payload.spender, deps.escrow)) return "wrong_spender"
  const amount = BigInt(String(payment.scheme === "exact" ? w.amount : w.maxAmount))
  if (BigInt(payload.permitted.amount) !== amount) return "wrong_amount"
  const quoted = BigInt(required.maxAmountRequired ?? required.maxAmount ?? 0)
  if (amount < quoted) return "amount_too_low"
  if (payment.scheme === "exact" && amount > (quoted * (10_000n + EXACT_MARGIN_BPS)) / 10_000n) return "amount_too_high"
  if (payment.scheme === "upto" && amount < UPTO_MIN_MAX_MICRO) return "max_too_low"
  if (BigInt(payload.deadline) < BigInt(now + MIN_DEADLINE_S)) return "deadline"
  if (BigInt(String(w.validBefore)) < BigInt(now + MIN_VALID_S)) return "valid_before"
  return null
}

async function nonceUnused(deps: VerifyDeps, cache: ReadCache, payer: Address, nonce: bigint) {
  const word = nonce >> 8n
  const bitmap = await cache.read(`nonce:${payer}:${word}`, (blockNumber) =>
    deps.reader.readContract({ address: PERMIT2 as Address, abi: permit2Abi, functionName: "nonceBitmap", args: [payer, word], blockNumber }),
  )
  return (bitmap & (1n << (nonce & 0xffn))) === 0n
}

async function checkFunds(deps: VerifyDeps, cache: ReadCache, payer: Address, amount: bigint): Promise<string | null> {
  const token = { address: deps.usdg, abi: erc20Abi }
  const [allowance, balance] = await Promise.all([
    cache.read(`allowance:${payer}`, (blockNumber) =>
      deps.reader.readContract({ ...token, functionName: "allowance", args: [payer, PERMIT2 as Address], blockNumber }),
    ),
    cache.read(`balance:${payer}`, (blockNumber) => deps.reader.readContract({ ...token, functionName: "balanceOf", args: [payer], blockNumber })),
  ])
  if (allowance < amount) return "allowance"
  if (balance < amount) return "balance"
  return null
}

/** Runs the checks in the documented order. The last one writes the claim, so a payload is accepted once. */
export async function verifyPayment(deps: VerifyDeps, cache: ReadCache, body: VerifyBody): Promise<VerifyResult> {
  const relayBalance = await cache.read("relay", (blockNumber) => deps.reader.getBalance({ address: deps.relay, blockNumber }))
  if (relayBalance < deps.relayFloorWei) return { isValid: false, invalidReason: "facilitator_unavailable", payer: null }

  const head = await cache.currentHead()
  let invalid: string | null
  try {
    invalid = checkTerms(deps, body, head.timestamp)
  } catch {
    invalid = "malformed"
  }
  if (invalid) return { isValid: false, invalidReason: invalid, payer: null }

  const { payload, scheme } = body.paymentPayload
  const permitScheme = scheme as "upto" | "exact"
  const payer = await recoverPayer(deps, payload, permitScheme)
  if (!payer) return { isValid: false, invalidReason: "bad_signature", payer: null }
  const reply = (invalidReason: string) => ({ isValid: false, invalidReason, payer: payer.toLowerCase() })

  if (!(await nonceUnused(deps, cache, payer, BigInt(payload.nonce)))) return reply("nonce_used")
  const funds = await checkFunds(deps, cache, payer, BigInt(payload.permitted.amount))
  if (funds) return reply(funds)
  if (deps.denylist.has(payer)) return reply("denied")

  const claimed = await deps.db.query(
    "INSERT INTO chain.x402_claims (req_id, payer, scheme, payload_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (req_id) DO NOTHING RETURNING req_id",
    [String(payload.witness.reqId).toLowerCase(), payer.toLowerCase(), scheme, payloadHash(payload, permitScheme)],
  )
  if (claimed.rows.length === 0) return reply("req_id_used")
  return { isValid: true, payer: payer.toLowerCase() }
}
