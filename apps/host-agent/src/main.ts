import { join } from "node:path"
import { addressOf } from "@offpeak/abis"
import { CHAIN_ID, DEV_ONLY_GPU_CLASS, HOST_STATUS, imageDigestOf, keepSigners, loadModelTokenizer, manifestDigest } from "@offpeak/shared"
import { keccak256, toBytes, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { hostChain, readDeployment, type HostChain } from "./chain.ts"
import { loadHostConfig, readHostEnv, type HostConfig, type LoadedModel } from "./config.ts"
import { ModelIntegrity } from "./digest.ts"
import { assertGpuClass, assertRegisteredGpu, readNvidiaSmi } from "./gpu.ts"
import { EngineWatch } from "./health.ts"
import { createAgentApp, serveAgent } from "./proxy.ts"
import { SealedAgent } from "./sealed/serve.ts"
import { SheetBook } from "./sheets.ts"
import { SignedLog } from "./signed-log.ts"

const DAY_MS = 86_400_000

export type BootInput = {
  configPath: string
  env: NodeJS.ProcessEnv
  chain?: HostChain
  gpu?: () => Promise<string>
  /** Stands in for NVIDIA's evidence tool on a machine with no GPU. */
  gpuTool?: string[]
  clock?: () => number
}

export const dataPaths = (config: { dataDir: string }) => ({ sheets: join(config.dataDir, "sheets"), signed: join(config.dataDir, "signed") })

/** The host's chain record must already say what this machine is about to serve. */
async function assertRegistration(config: HostConfig, chain: HostChain) {
  if ((await chain.chainId()) !== CHAIN_ID) throw new Error("rpc is on the wrong chain")
  const signer = await chain.routerSigner()
  if (signer.toLowerCase() !== config.router) throw new Error("router differs from UsageLedger.routerSigner")
  const registration = await chain.registration(config.operator)
  if (registration.status === HOST_STATUS.None) throw new Error("this operator is not registered")
  if (registration.imageDigest.toLowerCase() !== imageDigestFor(config).toLowerCase()) throw new Error("image differs from the registration")
  assertRegisteredGpu(config.gpuClass, registration.gpuClass)
  const registered = new Set(registration.models.map((digest) => digest.toLowerCase()))
  for (const model of config.models) {
    if (!registered.has(manifestDigest(model.recipeManifest).toLowerCase())) throw new Error(`model digest mismatch: ${model.name} is not registered`)
  }
}

export const imageDigestFor = (config: { image: string }) => imageDigestOf(config.image.slice(config.image.indexOf("sha256:")))

const watched = (model: LoadedModel) => ({ name: model.name, path: model.path, digest: manifestDigest(model.recipeManifest), manifest: model.recipeManifest })

/** Every check that can refuse a start runs here, before the agent opens a port. */
export async function bootAgent(input: BootInput) {
  const env = readHostEnv(input.env)
  const config = loadHostConfig(input.configPath, env)
  const deployment = readDeployment(env.OFFPEAK_DEPLOYMENT_FILE)
  const local = env.OFFPEAK_ENV === "local"
  const smi = config.gpuClass === DEV_ONLY_GPU_CLASS ? null : await (input.gpu ?? readNvidiaSmi)()
  assertGpuClass(config.gpuClass, smi, local)
  await assertRegistration(config, input.chain ?? hostChain(env.OFFPEAK_RPC_URL, deployment))
  const integrity = new ModelIntegrity(config.models.map(watched))
  await integrity.verify()
  const models = config.models.map((model) => ({
    name: model.name,
    digest: manifestDigest(model.recipeManifest),
    engine: model.engine,
    tokenizer: loadModelTokenizer(model.recipeManifest, model.path),
    nightJobs: model.nightJobs,
  }))
  const paths = dataPaths(config)
  const sheets = new SheetBook(paths.sheets, config.operator, deployment.HostRegistry)
  await sheets.load()
  const log = new SignedLog(paths.signed)
  await log.open()
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000))
  await log.prune(clock())
  const key = env.OFFPEAK_HOST_OPERATOR_KEY as Hex
  const sealedModel = models.find((model) => model.name === config.sealed?.model)
  const sealed =
    config.sealed && sealedModel
      ? await SealedAgent.start({
          modelName: sealedModel.name,
          modelDigest: sealedModel.digest,
          imageDigest: imageDigestFor(config),
          operator: config.operator,
          engine: sealedModel.engine,
          tsmRoot: config.sealed.tsmRoot,
          gpuTool: input.gpuTool,
        })
      : undefined
  const app = createAgentApp({
    operator: { ...privateKeyToAccount(key), localKey: key },
    routerAddress: config.router,
    usageLedger: deployment.UsageLedger,
    sheets,
    log,
    clock,
    imageDigest: imageDigestFor(config),
    gpuClass: config.gpuClass,
    models,
    integrity,
    engines: new EngineWatch(config.models),
    auditor: config.reference?.auditor ?? null,
    sealed,
  })
  return { app, config, env, integrity, log, clock, sealed }
}

/** `--mock-engine`: the fake model from 3.11, for local stacks without a GPU. */
async function serveMockEngine(argv: string[], env: NodeJS.ProcessEnv) {
  if ((env.OFFPEAK_ENV ?? "local") !== "local") throw new Error("--mock-engine runs only with OFFPEAK_ENV=local")
  const { createHostApp } = await import("./mock-engine.ts")
  const flag = (name: string) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const key = env.OFFPEAK_HOST_OPERATOR_KEY as Hex
  const modelName = flag("--model") ?? "ofm-8b"
  const { app } = createHostApp({
    operator: { ...privateKeyToAccount(key), localKey: key },
    routerAddress: env.OFFPEAK_ROUTER_ADDRESS ?? "",
    usageLedger: addressOf("UsageLedger"),
    modelDigest: keccak256(toBytes(modelName)),
    modelName,
    imageDigest: keccak256(toBytes("offpeak-image-v1")),
    gpuClass: DEV_ONLY_GPU_CLASS,
    swap: false,
    sealed: false,
  })
  Bun.serve({ port: Number(flag("--port") ?? 8790), fetch: app.fetch })
  console.log(JSON.stringify({ service: "host-agent", event: "mock_engine_started", model: modelName }))
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--mock-engine")) return serveMockEngine(argv, process.env)
  keepSigners(DAY_MS)
  const { app, config, env, integrity, log, clock, sealed } = await bootAgent({ configPath: process.env.OFFPEAK_HOST_CONFIG ?? "host.yaml", env: process.env })
  integrity.watch()
  setInterval(() => void log.prune(clock()), DAY_MS).unref()
  // Plain HTTP: the TLS proxy in front of this port is the operator's, as `docs/runbooks/deploy-host.md` sets out.
  serveAgent(app, { hostname: env.OFFPEAK_AGENT_BIND ?? config.listen.host, port: config.listen.port })
  // `offpeak-host attestation` registers this. Until then the router refuses this host for sealed requests.
  console.log(JSON.stringify({ service: "host-agent", event: "started", operator: config.operator, models: config.models.map((model) => model.name), attestationRef: sealed?.attestationRef }))
}

if (import.meta.main) await main()
