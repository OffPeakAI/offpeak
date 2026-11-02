import { CHAIN_ID, UPTO_MIN_MAX_MICRO, ZERO_BYTES32, domain, permitWitnessTypes, type Micro, type PaymentPayload } from "@offpeak/shared"
import { bytesToHex, erc20Abi, type Address, type Hex } from "viem"
import { z } from "zod"
import { OffpeakError, addressSchema, assertChain, bytes32Schema, digitsSchema, nowSeconds, type ClientContext } from "./core.ts"

const NETWORK = `eip155:${CHAIN_ID}`
const MIN_VALID_S = 60
/** A long `validBefore` keeps the buyer's money in escrow that long if the capture never comes. */
const MAX_VALID_S = 3_600
export const DEFAULT_UPTO_CAP_MICRO = 1_000_000n

export const uptoRequirementSchema = z.object({
  scheme: z.literal("upto"),
  network: z.literal(NETWORK),
  asset: addressSchema,
  maxAmountRequired: digitsSchema,
  payTo: addressSchema,
  extra: z.object({
    permit2: addressSchema,
    spender: addressSchema,
    reqId: bytes32Schema,
    validBefore: z.coerce.number().int(),
    witness: z.literal("UptoWitness"),
    resourceHash: bytes32Schema.optional(),
  }),
})

export type UptoRequirement = z.input<typeof uptoRequirementSchema>

export type UptoPayment = {
  /** The value for the `PAYMENT-SIGNATURE` header. */
  header: string
  payload: PaymentPayload
  reqId: Hex
  maxAmount: Micro
  validBefore: number
}

/** The `upto` entry of a 402 body, when it has one. */
export function findUpto(body: unknown): unknown {
  const accepts = (body as { accepts?: unknown } | null)?.accepts
  return Array.isArray(accepts) ? accepts.find((row) => (row as { scheme?: unknown })?.scheme === "upto") : undefined
}

export class X402 {
  constructor(
    private ctx: ClientContext,
    private capMicro: Micro,
    private onUpto?: (maxAmount: Micro) => void,
  ) {}

  /**
   * Signs a Permit2 witness transfer for a 402 `upto` requirement. The requirement comes from the
   * network, so every field that decides where money can go is checked against the deployment first.
   */
  async payUpto(requirement: unknown, opts: { maxAmount?: Micro } = {}): Promise<UptoPayment> {
    const signer = this.ctx.signer
    if (!signer) throw new OffpeakError("no_wallet", "Paying with upto needs a wallet")
    const offer = uptoRequirementSchema.parse(requirement)
    const { book } = this.ctx
    const usdg = book.contract("USDG")
    const permit2 = book.contract("Permit2")
    if (offer.asset !== usdg) throw new OffpeakError("bad_requirement", "Requirement is not for USDG")
    if (offer.payTo !== book.contract("OffpeakVault")) throw new OffpeakError("bad_requirement", "Requirement pays an unknown address")
    if (offer.extra.spender !== book.contract("X402Escrow")) throw new OffpeakError("bad_requirement", "Requirement names an unknown spender")
    if (offer.extra.permit2 !== permit2) throw new OffpeakError("bad_requirement", "Requirement names an unknown Permit2")
    const required = BigInt(offer.maxAmountRequired)
    const maxAmount = opts.maxAmount ?? (required > UPTO_MIN_MAX_MICRO ? required : UPTO_MIN_MAX_MICRO)
    if (maxAmount < required) throw new OffpeakError("bad_requirement", "maxAmount is below what the router requires")
    if (maxAmount > this.capMicro) throw new OffpeakError("above_upto_cap", `Requirement of ${maxAmount} µUSDG is above the ${this.capMicro} µUSDG cap`)
    const { reqId, validBefore: until } = offer.extra
    const now = nowSeconds()
    if (until < now + MIN_VALID_S || until > now + MAX_VALID_S) throw new OffpeakError("bad_requirement", "Requirement's validBefore is out of range")
    this.onUpto?.(maxAmount)
    const resourceHash = offer.extra.resourceHash ?? ZERO_BYTES32
    const validBefore = BigInt(until)
    const witness = { reqId, payee: offer.payTo, maxAmount, validBefore, resourceHash }
    const nonce = BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32))))
    const signature = await signer.signTypedData({
      domain: domain("Permit2", permit2),
      types: permitWitnessTypes("UptoWitness"),
      primaryType: "PermitWitnessTransferFrom",
      message: { permitted: { token: usdg, amount: maxAmount }, spender: offer.extra.spender, nonce, deadline: validBefore, witness },
    })
    const payload: PaymentPayload = {
      x402Version: 2,
      scheme: "upto",
      payload: {
        signature,
        permitted: { token: usdg, amount: maxAmount.toString() },
        spender: offer.extra.spender,
        nonce: nonce.toString(),
        deadline: validBefore.toString(),
        witness: { ...witness, maxAmount: maxAmount.toString(), validBefore: validBefore.toString() },
      },
    }
    return { header: JSON.stringify(payload), payload, reqId, maxAmount, validBefore: until }
  }

  /** `upto` pulls through Permit2, so the wallet approves it once. Sent from your own wallet. */
  async approvePermit2(amount: Micro): Promise<Hex> {
    const writer = this.ctx.chain.writer()
    const reader = this.ctx.chain.reader()
    if (!writer?.account || !reader) throw new OffpeakError("no_rpc", "Approving needs a wallet and an RPC URL")
    await assertChain(writer)
    const hash = await writer.writeContract({
      account: writer.account,
      chain: writer.chain ?? null,
      address: this.ctx.book.contract("USDG"),
      abi: erc20Abi,
      functionName: "approve",
      args: [this.ctx.book.contract("Permit2") as Address, amount],
    })
    const receipt = await reader.waitForTransactionReceipt({ hash, pollingInterval: 250 })
    if (receipt.status !== "success") throw new OffpeakError("tx_reverted", "Approve transaction reverted")
    return hash
  }
}
