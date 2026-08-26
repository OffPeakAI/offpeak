import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem"
import { auditCourtAbi } from "@offpeak/abis"
import { CHAIN_ID } from "@offpeak/shared"
import { z } from "zod"
import { oai } from "../http.ts"
import type { Stack } from "../pipeline.ts"

const responseBody = z.object({ challengeId: z.string().regex(/^\d{1,78}$/).transform(BigInt), response: z.string().min(1) })

export function auditResponseCalldata(auditCourt: Hex, challengeId: bigint, response: string) {
  const responseHash = keccak256(toBytes(response))
  const data = encodeFunctionData({
    abi: auditCourtAbi,
    functionName: "respond",
    args: [challengeId, responseHash],
  })
  return { to: auditCourt, data, value: "0", chainId: CHAIN_ID, responseHash }
}

export function auditResponse(stack: Stack, raw: unknown) {
  const body = responseBody.safeParse(raw)
  if (!body.success) return oai(400, "Response needs a challengeId and text", "invalid_request", "bad_audit_response")
  if (!stack.auditCourt) return oai(503, "The audit court is not deployed here", "server_error", "contract_not_deployed")
  return Response.json(auditResponseCalldata(stack.auditCourt as Hex, body.data.challengeId, body.data.response))
}
