import type { Db } from "@offpeak/common"
import { CHAIN_ID, PERMIT2, UPTO_MIN_MAX_MICRO, permitWitnessTypes } from "@offpeak/shared"
import { erc20Abi, getAddress, hashTypedData, isAddressEqual, parseAbi, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem"
import type { Denylist } from "./denylist.ts"

const NETWORK = `eip155:${CHAIN_ID}`
const MIN_DEADLINE_S = 30
const MIN_VALID_S = 60
const EIP1271_MAGIC = "0x1626ba7e"
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
