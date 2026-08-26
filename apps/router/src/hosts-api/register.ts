import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem"
import { hostRegistryAbi } from "@offpeak/abis"
import { CHAIN_ID, canonicalJson, recoverPersonal } from "@offpeak/shared"
import { endpointAllowed, saveEndpoint } from "../routing/probes.ts"
import type { Stack } from "../pipeline.ts"

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
