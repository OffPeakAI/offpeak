import { keccak256, toBytes, type Hex } from "viem"
import { canonicalJson } from "@offpeak/shared"

export type SignedReq = { reqId: Hex; ts: number; bodyHash: Hex; sig: Hex }

export function bodyHashOf(body: unknown): Hex {
  return keccak256(toBytes(canonicalJson(body)))
}

export { reqMessage } from "../../../host-agent/src/proxy.ts"
