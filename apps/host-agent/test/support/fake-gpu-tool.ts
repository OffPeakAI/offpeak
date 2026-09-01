import { createHmac } from "node:crypto"

/** Stands in for NVIDIA's evidence tool. What it prints has the service's shape and carries no real GPU claim. */

const FAKE_GPU_KEY = "offpeak-fake-gpu-key"

export const fakeEvidenceFor = (nonce: string) => createHmac("sha256", FAKE_GPU_KEY).update(nonce).digest("hex")

export const fakeGpuCommand = () => [process.execPath, new URL(import.meta.url).pathname, "{nonce}"]

if (import.meta.main) {
  const nonce = process.argv[2]!
  console.log(JSON.stringify({ arch: "HOPPER", evidence_list: [{ evidence: fakeEvidenceFor(nonce), certificate: "fake-certificate" }] }))
}
