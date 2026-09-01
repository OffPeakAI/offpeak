import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addressOf } from "@offpeak/abis"
import { ZERO_BYTES32, buyerRefOf, domain, hostCostMicro, loadModelTokenizer, manifestDigest, outputHashOf, privateKeyOf, promptHashOf, readManifest, recordToMessage, serializeRecord, signTyped, usageTypes, type Hex, type UsageRecord } from "@offpeak/shared"
import { keccak256, toBytes } from "viem"
import { anvilAccount, roleAccount } from "../../../../packages/shared/src/test-keys.ts"
import { EngineWatch } from "../../src/health.ts"
import { createAgentApp, signRouterBody, type AgentModel } from "../../src/proxy.ts"
import { SheetBook, sheetTypedData, type PriceSheet } from "../../src/sheets.ts"
import { SignedLog } from "../../src/signed-log.ts"
import { startFakeVllm, type FakeVllmOptions } from "./fake-vllm.ts"

export const fixtureDir = new URL("../../../../packages/shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/", import.meta.url).pathname
export const fixtureManifest = readManifest(`${fixtureDir}manifest.json`)
export const tokenizer = loadModelTokenizer(fixtureManifest, fixtureDir)
export const MODEL = fixtureManifest.name
export const DIGEST = manifestDigest(fixtureManifest)

export const router = roleAccount("router")
export const host = roleAccount("host")
export const HOST_KEY = privateKeyOf(host)
export const auditor = anvilAccount(12)
export const buyer = roleAccount("buyer")

export const REGISTRY = addressOf("HostRegistry")
export const LEDGER = addressOf("UsageLedger")
export const IMAGE_DIGEST = `0x${"ab".repeat(32)}` as Hex

export const NOW = 1_762_000_000
// Prices at the hour of week NOW falls in: base 200,000 in and 800,000 out, floors 100,000 and 400,000.
export const LIVE = { in: 180_000n, out: 720_000n }

export const IMAGE = `vllm/vllm-openai@sha256:${"befccf0e7e4089aa".repeat(4)}`
export const SMI = "name, memory.total [MiB], uuid\nNVIDIA H100 80GB HBM3, 81559 MiB, GPU-00000000-aaaa-bbbb-cccc-1234567890ab\n"

/**
 * A host's folder: a model that matches its manifest, a deployment file and `host.yaml`. The fixture has no weights,
 * so this writes a small file in their place. Callers remove `root`.
 */
export function hostFolder(over: { deployment?: { HostRegistry: string; UsageLedger: string }; modelLines?: string[]; topLines?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "offpeak-host-"))
  const modelDir = join(root, "model")
  mkdirSync(modelDir)
  copyFileSync(`${fixtureDir}tokenizer.json`, join(modelDir, "tokenizer.json"))
  copyFileSync(`${fixtureDir}tokenizer_config.json`, join(modelDir, "tokenizer_config.json"))
  writeFileSync(join(modelDir, "model.safetensors"), "small weights")
  const manifest = {
    ...fixtureManifest,
    weights: [{ path: "model.safetensors", sha256: new Bun.CryptoHasher("sha256").update("small weights").digest("hex") }],
    tokenizer: fixtureManifest.tokenizer.filter((file) => file.path === "tokenizer.json"),
  }
  const manifestPath = join(root, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const deploymentPath = join(root, "deployment.json")
  writeFileSync(deploymentPath, JSON.stringify({ contracts: over.deployment ?? { HostRegistry: REGISTRY, UsageLedger: LEDGER } }))
  const configPath = join(root, "host.yaml")
  writeFileSync(
    configPath,
    [
      `operator: "${host.address}"`,
      "endpoint: https://host.example.net",
      "gpuClass: h100-80g-sxm",
      `image: ${IMAGE}`,
      `router: "${router.address}"`,
      `dataDir: ${join(root, "data")}`,
      ...(over.topLines ?? []),
      "models:",
      `  - name: ${MODEL}`,
      `    path: ${modelDir}`,
      `    manifest: ${manifestPath}`,
      "    maxTps: 400",
      ...(over.modelLines ?? []),
    ].join("\n"),
  )
  const env = { OFFPEAK_ENV: "mainnet", OFFPEAK_RPC_URL: "http://127.0.0.1:31999", OFFPEAK_DEPLOYMENT_FILE: deploymentPath, OFFPEAK_HOST_OPERATOR_KEY: HOST_KEY, OFFPEAK_HOST_CONFIG: configPath }
  return { root, modelDir, configPath, env, digest: manifestDigest(manifest) }
}

export const week = (value: bigint) => Array.from({ length: 168 }, () => value)

export const baseSheet = (over: Partial<PriceSheet> = {}): PriceSheet => ({
  host: host.address.toLowerCase() as Hex,
  modelDigest: DIGEST,
  baseIn: week(200_000n),
  baseOut: week(800_000n),
  floorIn: 100_000n,
  floorOut: 400_000n,
  validFrom: 0,
  nonce: 1n,
  ...over,
})

export const signSheet = (sheet: PriceSheet, registry: string = REGISTRY) => signTyped(host as never, sheetTypedData(sheet, registry) as never)

let nextReq = 0

export const newReqId = () => keccak256(toBytes(`req-${Date.now()}-${nextReq++}`))

type HarnessOptions = Partial<FakeVllmOptions> & { nightJobs?: boolean; integrityFailed?: string; auditor?: Hex | null; model?: Partial<AgentModel> }
