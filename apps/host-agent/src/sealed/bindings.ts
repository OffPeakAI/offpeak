import type { Hex } from "viem"
import { bindingsSchema, reportDataFor, type Bindings } from "../../../../packages/sdk/src/sealed/attest.ts"

export { reportDataFor, type Bindings }

/** Bun's `fetch` sends even loopback calls through any of these. */
const PROXY_ENV = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]

/** Everything a client needs tied to the VM's report. `reportDataFor` hashes its canonical form. */
export function buildBindings(input: { modelDigest: Hex; imageDigest: Hex; operator: string; hpkePublicKey: Hex; countsSigner: Hex; configHash: Hex; gpuEvidenceHash: Hex }): Bindings {
  return bindingsSchema.parse({ v: 1, ...input })
}

/** The one place plaintext goes. It must be this machine by address, with nothing that could redirect the call. */
export function sealedEngine(engine: string) {
  const url = new URL(engine)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("a sealed engine must be plain http on 127.0.0.1")
  if (PROXY_ENV.some((name) => process.env[name])) throw new Error("a sealed agent cannot run with a proxy in its environment")
  return url.origin
}
