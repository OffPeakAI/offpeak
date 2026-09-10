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

export async function agentHarness(opts: HarnessOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "offpeak-agent-"))
  const engine = startFakeVllm({ name: MODEL, tokenizer, ...opts })
  const sheets = new SheetBook(join(dataDir, "sheets"), host.address.toLowerCase(), REGISTRY)
  await sheets.load()
  const sheet = baseSheet()
  const sheetHash = await sheets.save(sheet, await signSheet(sheet))
  const log = new SignedLog(join(dataDir, "signed"))
  await log.open()
  const clock = { now: NOW }
  const integrity = { failed: opts.integrityFailed ?? null }
  const app = createAgentApp({
    operator: host as never,
    routerAddress: router.address,
    usageLedger: LEDGER,
    sheets,
    log,
    clock: () => clock.now,
    imageDigest: IMAGE_DIGEST,
    gpuClass: "h100-80g-sxm",
    models: [{ name: MODEL, digest: DIGEST, engine: engine.url, tokenizer, nightJobs: opts.nightJobs ?? false, ...opts.model }],
    integrity,
    engines: new EngineWatch([{ name: MODEL, engine: engine.url, vllmArgs: [] }]),
    auditor: opts.auditor === undefined ? (auditor.address.toLowerCase() as Hex) : opts.auditor,
  })

  /** A request as the router sends it: signed over the exact bytes. */
  const post = async (path: string, body: unknown, over: { reqId?: Hex; ts?: number; signer?: unknown; rawBody?: string; signedBody?: string; header?: string | null; headerName?: string } = {}) => {
    const reqId = over.reqId ?? newReqId()
    const payload = over.signedBody ?? JSON.stringify(body)
    const header = over.header === undefined ? await signRouterBody((over.signer ?? router) as never, { reqId, ts: over.ts ?? clock.now, payload }) : over.header
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(header ? { [over.headerName ?? "x-offpeak-req"]: header } : {}) },
      body: over.rawBody ?? payload,
    })
    return { res, reqId }
  }

  const chatBody = (over: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: "user", content: "Say something." }], stream: true, max_tokens: 64, stream_options: { include_usage: true }, ...over })

  /** Serves one chat to the end, as the router would read it. */
  const serve = async (over: Record<string, unknown> = {}) => {
    const body = chatBody(over)
    const { res, reqId } = await post("/offpeak/v1/chat/completions", body)
    const text = await res.text()
    return { res, reqId, text, body }
  }

  /** A record that passes every check for a served reply. Tests change one field at a time. */
  const record = (reqId: Hex, over: Partial<UsageRecord> = {}): UsageRecord => {
    const tokensIn = over.tokensIn ?? 0
    const tokensOut = over.tokensOut ?? 0
    const priceIn = over.priceIn ?? LIVE.in
    const priceOut = over.priceOut ?? LIVE.out
    return {
      reqId,
      buyerRef: buyerRefOf(buyer.address, reqId),
      host: host.address.toLowerCase() as Hex,
      modelDigest: DIGEST,
      tokensIn,
      tokensOut,
      promptHash: promptHashOf({ any: 1 }),
      outputHash: outputHashOf("text", []),
      priceIn,
      priceOut,
      hostCostMicro: hostCostMicro(tokensIn, tokensOut, priceIn, priceOut),
      feeMicro: 1n,
      payMode: 0,
      payRef: ZERO_BYTES32,
      ts: NOW,
      sheetHash,
      ...over,
    }
  }

  const routerSig = (rec: UsageRecord, signer: unknown = router, ledger: string = LEDGER) =>
    signTyped(signer as never, { domain: domain("OffpeakUsage", ledger), types: usageTypes, primaryType: "UsageRecord", message: recordToMessage(rec) as never })

  const sign = async (rec: UsageRecord, over: { partial?: boolean; signer?: unknown; sig?: Hex } = {}) => {
    const res = await app.request("/offpeak/v1/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: serializeRecord(rec), routerSig: over.sig ?? (await routerSig(rec, over.signer)), partial: over.partial }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }

  const stop = () => {
    engine.stop()
    rmSync(dataDir, { recursive: true, force: true })
  }

  return { app, engine, sheets, sheet, sheetHash, log, dataDir, clock, integrity, post, chatBody, serve, record, routerSig, sign, stop }
}
