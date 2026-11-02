import { recoverTypedDataAddress, type Hex } from "viem"
import { CHAIN_ID, PERMIT2, domainSeparator, hashStruct, permitWitnessTypes, typedDataDigest, type ChainPush, type PaymentClient, type PaymentPayload } from "@offpeak/shared"

export type { PaymentPayload } from "@offpeak/shared"

export class MockFacilitator implements PaymentClient {
  delayMs = Number(process.env.OFFPEAK_MOCK_AUTHORIZE_DELAY_MS ?? 400)
  deny = new Set<string>()
  failReqIds = new Set<string>()
  captured: { reqId: string; actual: bigint }[] = []
  constructor(private emit: (msg: ChainPush) => void) {}

  async verify(body: { paymentPayload: PaymentPayload; paymentRequirements: { payTo: string; asset: string; maxAmountRequired?: string } }) {
    const started = performance.now()
    const payload = body.paymentPayload
    if (payload.scheme === "channel") return { isValid: false, invalidReason: "use_channel_header", payer: null }
    try {
      const witnessName = payload.scheme === "exact" ? "ExactWitness" : "UptoWitness"
      const types = permitWitnessTypes(witnessName)
      const message = {
        permitted: { token: payload.payload.permitted.token, amount: BigInt(payload.payload.permitted.amount) },
        spender: payload.payload.spender,
        nonce: BigInt(payload.payload.nonce),
        deadline: BigInt(payload.payload.deadline),
        witness: normalizeWitness(payload.payload.witness),
      }
      const struct = hashStruct("PermitWitnessTransferFrom", types as never, message)
      const digest = typedDataDigest(struct, domainSeparator("Permit2", PERMIT2, null))
      const payer = await recoverTypedDataAddress({
        domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 as Hex },
        types,
        primaryType: "PermitWitnessTransferFrom",
        message,
        signature: payload.payload.signature,
      } as never)
      if (this.deny.has(payer.toLowerCase())) return { isValid: false, invalidReason: "denied", payer: payer.toLowerCase() }
      if (BigInt(payload.payload.deadline) < BigInt(Math.floor(Date.now() / 1000) + 30)) {
        return { isValid: false, invalidReason: "deadline", payer: payer.toLowerCase() }
      }
      void digest
      void started
      return { isValid: true, payer: payer.toLowerCase() }
    } catch {
      return { isValid: false, invalidReason: "bad_signature", payer: null }
    }
  }

  settle(body: { paymentPayload: PaymentPayload; mode: "authorize" | "exact" }) {
    const reqId = String(body.paymentPayload.payload.witness.reqId)
    const delay = this.delayMs
    const fail = this.failReqIds.has(reqId)
    const amount = body.mode === "exact" ? { amount: String(body.paymentPayload.payload.witness.amount) } : {}
    setTimeout(() => {
      this.emit({
        type: fail ? "AuthorizeFailed" : body.mode === "exact" ? "ExactSettled" : "Authorized",
        reqId,
        ...amount,
        block: 1,
        txHash: `0x${"ab".repeat(32)}` as Hex,
      })
    }, delay)
    return { success: true, txHash: `0x${"cd".repeat(32)}`, status: "submitted" as const }
  }

  fail(reqId: string) {
    this.emit({ type: "AuthorizeFailed", reqId, block: 1, txHash: `0x${"ef".repeat(32)}` as Hex, reason: "0x" })
  }

  capture(reqId: string, actual: bigint) {
    this.captured.push({ reqId, actual })
    return { queued: true }
  }
}

function normalizeWitness(witness: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(witness)) {
    if (typeof value === "string" && /^\d+$/.test(value) && key !== "reqId" && key !== "resourceHash" && !value.startsWith("0x")) {
      out[key] = BigInt(value)
    } else out[key] = value
  }
  return out
}
