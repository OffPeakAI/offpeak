import { keccak256, toBytes, type Hex } from "viem"
import { PERMIT2, permitWitnessTypes } from "@offpeak/shared"
import type { Stack } from "../../src/context.ts"
import type { roleAccount } from "../../../../packages/shared/src/test-keys.ts"

/** A signed `upto` payment, ready for the `PAYMENT-SIGNATURE` header. */
export async function uptoHeader(stack: Stack, buyer: ReturnType<typeof roleAccount>, reqId: Hex) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const amount = 2_000_000n
  const witness = { reqId, payee: stack.vault as Hex, maxAmount: amount, validBefore: deadline, resourceHash: keccak256(toBytes("resource")) }
  const message = { permitted: { token: stack.usdg as Hex, amount }, spender: stack.escrow as Hex, nonce: BigInt(`0x${reqId.slice(2, 10)}`), deadline, witness }
  const signature = await buyer.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 },
    types: permitWitnessTypes("UptoWitness"),
    primaryType: "PermitWitnessTransferFrom",
    message,
  } as never)
  return JSON.stringify({
    x402Version: 2,
    scheme: "upto",
    payload: {
      signature,
      permitted: { token: stack.usdg, amount: amount.toString() },
      spender: stack.escrow,
      nonce: message.nonce.toString(),
      deadline: deadline.toString(),
      witness: { ...witness, maxAmount: amount.toString(), validBefore: deadline.toString() },
    },
  })
}
