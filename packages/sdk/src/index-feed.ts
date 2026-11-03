import { createHash } from "node:crypto"
import { verifyMessage, type Address, type Hex } from "viem"
export type SignedIndex = {
  payload: { schema: string; chainId: number; usageLedger: string; asOf: number; expiresAt: number; [key: string]: unknown }
  hash: string
  signer: string
  signature: Hex
}
/** Pin the publisher and chain deployment independently; a signature supplied with its own key proves nothing. */
export async function verifyIndex(feed: SignedIndex, expected: { signer: Address; usageLedger: Address; chainId: number; now?: number }) {
  try {
    const now = expected.now ?? Math.floor(Date.now() / 1000),
      p = feed.payload
    if (!p || !Number.isSafeInteger(p.asOf) || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= p.asOf) return false
    if (
      p.schema !== "offpeak-index-v1" ||
      p.chainId !== expected.chainId ||
      p.usageLedger.toLowerCase() !== expected.usageLedger.toLowerCase() ||
      feed.signer.toLowerCase() !== expected.signer.toLowerCase() ||
      p.asOf > now + 30 ||
      p.expiresAt <= now ||
      p.expiresAt - p.asOf > 120
    )
      return false
    const hash = createHash("sha256").update(JSON.stringify(p)).digest("hex")
    return (
      feed.hash === `sha256:${hash}` &&
      (await verifyMessage({ address: expected.signer, message: `OFFPEAK_INDEX_V1\n${hash}`, signature: feed.signature }).catch(
        () => false,
      ))
    )
  } catch {
    return false
  }
}
