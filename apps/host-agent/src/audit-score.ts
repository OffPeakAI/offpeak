import { keccak256, toBytes } from "viem"
import { canonicalJson } from "@offpeak/shared"
import { verifyRouterReq } from "./proxy.ts"

const AUDIT_SCORE_WINDOW_S = 300

/** `X-Offpeak-Audit` has the shape of `X-Offpeak-Req`, signed by the auditor key over the exact bytes. */
export async function verifyAuditScore(header: string | undefined, rawBody: string, auditor: string, nowS = Math.floor(Date.now() / 1000)) {
  const req = await verifyRouterReq(header, auditor)
  if (!req || Math.abs(nowS - req.ts) > AUDIT_SCORE_WINDOW_S) return false
  return keccak256(toBytes(canonicalJson(rawBody))) === req.bodyHash.toLowerCase()
}
