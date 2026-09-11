import type { Hex } from "viem"
import { gpuEvidenceHash, gpuEvidenceSchema, type GpuEvidence } from "../../../../packages/sdk/src/sealed/attest.ts"

export { gpuEvidenceHash, type GpuEvidence }

const COLLECT_TIMEOUT_MS = 60_000
const NONCE_SLOT = "{nonce}"

/**
 * NVIDIA's evidence tool at its path in the image, with `{nonce}` standing for the nonce in bare hex.
 * It runs in the VM beside the plaintext, so it is fixed here. A command from `host.yaml` would let
 * an operator run anything in there under a quote that still verifies.
 */
export const GPU_EVIDENCE_COMMAND = ["/usr/local/bin/nvattest", "collect-evidence", "--device", "gpu", "--nonce", NONCE_SLOT, "--format", "json"]

/** Runs the tool with an empty environment and reads its JSON evidence off stdout. */
export async function collectGpuEvidence(command: string[], nonce: Hex): Promise<GpuEvidence> {
  const argv = command.map((arg) => arg.replaceAll(NONCE_SLOT, nonce.slice(2)))
  const child = Bun.spawn(argv, { env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: COLLECT_TIMEOUT_MS })
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw new Error(`GPU evidence tool exited with ${code}`)
  return gpuEvidenceSchema.parse(JSON.parse(text))
}
