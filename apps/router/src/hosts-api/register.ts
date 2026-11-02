import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem"
import { hostRegistryAbi } from "@offpeak/abis"
import { CHAIN_ID, canonicalJson, recoverPersonal } from "@offpeak/shared"
import { z } from "zod"
import { signature, wallet } from "../pay/schemas.ts"
import { endpointAllowed, saveEndpoint } from "../routing/probes.ts"
import type { Stack } from "../pipeline.ts"

const digest = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex)
const MAX_HOST_MODELS = 64

export const registerBody = z.object({
  operator: wallet.transform((value) => value as Hex),
  endpoint: z.string().max(512),
  sig: signature,
  models: z.array(z.object({ digest, maxTps: z.int().positive() })).min(1).max(MAX_HOST_MODELS),
  imageDigest: digest,
  gpuClass: digest,
})

export function registerCalldata(registry: Hex, body: {
  operator: Hex
  models: { digest: Hex; maxTps: number }[]
  imageDigest: Hex
  gpuClass: Hex
  endpoint: string
}) {
  const data = encodeFunctionData({
    abi: hostRegistryAbi,
    functionName: "register",
    args: [
      {
        modelDigests: body.models.map((m) => m.digest),
        maxTps: body.models.map((m) => m.maxTps),
        imageDigest: body.imageDigest,
        gpuClass: body.gpuClass,
        endpointHash: keccak256(toBytes(body.endpoint)),
        attestationRef: `0x${"00".repeat(32)}`,
        bondUsdg: 2_000_000_000n,
        bondOfpk: 0n,
      },
    ],
  })
  return { to: registry, data, value: "0", chainId: CHAIN_ID, operator: body.operator }
}

/** Stores the endpoint for routing. The operator signs it, so nobody else can repoint a host. */
export async function rememberHost(stack: Stack, body: { operator: Hex; endpoint: string; sig: Hex }) {
  const signer = await recoverPersonal(canonicalJson({ endpoint: body.endpoint, operator: body.operator.toLowerCase() }), body.sig).catch(() => null)
  if (signer?.toLowerCase() !== body.operator.toLowerCase()) return { error: "bad_signature" as const }
  if (!endpointAllowed(body.endpoint, stack.production)) return { error: "bad_endpoint" as const }
  await saveEndpoint(stack.db, body.operator, body.endpoint)
  return { endpoint: body.endpoint, probation: true, seconds: 259200 }
}
