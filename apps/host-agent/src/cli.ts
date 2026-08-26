#!/usr/bin/env bun
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostRegistryAbi } from "@offpeak/abis"
import { CHAIN_ID, DEV_ONLY_GPU_CLASS, HOST_MIN_BOND, ZERO_BYTES32, canonicalJson, gpuClassOf, manifestDigest, signTyped } from "@offpeak/shared"
import { encodeFunctionData, erc20Abi, keccak256, toBytes, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import { hostChain, readDeployment, sendCalls, type HostChain, type TxCall } from "./chain.ts"
import { assertRecipe, loadHostConfig, readHostEnv, type HostConfig, type LoadedModel } from "./config.ts"
import { buildManifest, hashModel } from "./digest.ts"
import { assertGpuClass, readNvidiaSmi } from "./gpu.ts"
import { dataPaths, imageDigestFor } from "./main.ts"
import { SheetBook, sheetFromJson, sheetHashOf, sheetJsonSchema, sheetProblem, sheetToJson, sheetTypedData } from "./sheets.ts"

const USAGE = `usage: offpeak-host <command> [--config host.yaml]
  init                         create data folders and write the vLLM arguments
  init --manifest --model-dir <dir> --name <name> --kind chat|embeddings --out <file>
  verify [--no-image]          check digests, GPU and image
  register [--send] [--bond-usdg <micro>] [--bond-ofpk <wei>]
  price-sheet set --file <sheet.json>
  credits                      show releasable and pending credits
  credits withdraw [--send]
  attestation [--send]         register the running agent's attestationRef
  exit [--finalize] [--send]`

export type CliDeps = {
  env: NodeJS.ProcessEnv
  print: (line: string) => void
  chain?: HostChain
  gpu?: () => Promise<string>
  docker?: (args: string[]) => Promise<string>
  send?: (calls: TxCall[]) => Promise<Hex[]>
  fetcher?: typeof fetch
  clock?: () => number
}

const flagValue = (argv: string[], name: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

const required = (argv: string[], name: string) => {
  const value = flagValue(argv, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

const amount = (argv: string[], name: string, fallback: bigint) => {
  const value = flagValue(argv, name)
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number`)
  return BigInt(value)
}

const runDocker = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile("docker", args, { timeout: 30_000 }, (err, stdout) => (err ? reject(new Error(`docker ${args[0]} failed`)) : resolve(stdout.trim())))
  })

/** The vLLM arguments every host runs. Only `vllmArgs` varies, and only inside the recipe. */
export function vllmCommand(model: LoadedModel) {
  const manifest = model.recipeManifest
  const tools = manifest.toolCallParser ? ["--enable-auto-tool-choice", `--tool-call-parser=${manifest.toolCallParser}`] : []
  return [`--served-model-name=${model.name}`, ...tools, ...model.vllmArgs]
}

/** The container must run the pinned image, and an image pulled by tag can differ from it. */
export async function checkImage(image: string, docker: (args: string[]) => Promise<string>) {
  const pinned = await docker(["image", "inspect", "--format", "{{.Id}}", image])
  const running = await docker(["inspect", "--format", "{{.Image}}", "offpeak-vllm"])
  if (pinned !== running) throw new Error("the vLLM container is not running the pinned image")
}

class Commands {
  readonly env
  readonly config: HostConfig
  readonly deployment
  readonly chain: HostChain
  readonly account
  readonly key: Hex

  constructor(
    argv: string[],
    readonly deps: CliDeps,
  ) {
    this.env = readHostEnv(deps.env)
    this.config = loadHostConfig(flagValue(argv, "--config") ?? deps.env.OFFPEAK_HOST_CONFIG ?? "host.yaml", this.env)
    this.deployment = readDeployment(this.env.OFFPEAK_DEPLOYMENT_FILE)
    this.chain = deps.chain ?? hostChain(this.env.OFFPEAK_RPC_URL, this.deployment)
    this.key = this.env.OFFPEAK_HOST_OPERATOR_KEY as Hex
    this.account = { ...privateKeyToAccount(this.key), localKey: this.key }
  }

  /** Prints what would go on chain, and sends it only when asked. */
  async finish(argv: string[], calls: TxCall[]) {
    for (const call of calls) this.deps.print(JSON.stringify({ to: call.to, data: call.data, value: "0", chainId: CHAIN_ID }))
    if (!argv.includes("--send")) {
      this.deps.print("nothing sent; pass --send to send it from the operator key")
      return false
    }
    const send = this.deps.send ?? ((rows: TxCall[]) => sendCalls(this.env.OFFPEAK_RPC_URL, privateKeyToAccount(this.key), rows))
    for (const hash of await send(calls)) this.deps.print(`sent ${hash}`)
    return true
  }

  async init() {
    const paths = dataPaths(this.config)
    await mkdir(paths.sheets, { recursive: true, mode: 0o700 })
    await mkdir(paths.signed, { recursive: true, mode: 0o700 })
    this.deps.print(`operator ${this.config.operator}`)
    for (const model of this.config.models) {
      const path = join(this.config.dataDir, `vllm-${model.name}.env`)
      await writeFile(path, `VLLM_ARGS=${vllmCommand(model).join(" ")}\n`, { mode: 0o600 })
      this.deps.print(`${model.name} ${manifestDigest(model.recipeManifest)}`)
      this.deps.print(`wrote ${path}`)
    }
  }

  async verify(argv: string[]) {
    const smi = this.config.gpuClass === DEV_ONLY_GPU_CLASS ? null : await (this.deps.gpu ?? readNvidiaSmi)()
    assertGpuClass(this.config.gpuClass, smi, this.env.OFFPEAK_ENV === "local")
    this.deps.print(`gpu ${this.config.gpuClass} ok`)
    for (const model of this.config.models) {
      assertRecipe(model, model.recipeManifest.recipe)
      this.deps.print(`${model.name} ${await hashModel(model.path, model.recipeManifest)} ok`)
    }
    if (argv.includes("--no-image")) {
      this.deps.print("image not checked")
      return
    }
    await checkImage(this.config.image, this.deps.docker ?? runDocker)
    this.deps.print(`image ${imageDigestFor(this.config)} ok`)
  }

  async register(argv: string[]) {
    const bondUsdg = amount(argv, "--bond-usdg", HOST_MIN_BOND)
    const bondOfpk = amount(argv, "--bond-ofpk", 0n)
    const registry = this.deployment.HostRegistry
    const { usdg, ofpk } = await this.chain.bondTokens()
    const approve = (token: Hex, value: bigint): TxCall => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [registry, value] }) })
    const data = encodeFunctionData({
      abi: hostRegistryAbi,
      functionName: "register",
      args: [
        {
          modelDigests: this.config.models.map((model) => manifestDigest(model.recipeManifest)),
          maxTps: this.config.models.map((model) => model.maxTps),
          imageDigest: imageDigestFor(this.config),
          gpuClass: gpuClassOf(this.config.gpuClass),
          endpointHash: keccak256(toBytes(this.config.endpoint)),
          attestationRef: ZERO_BYTES32,
          bondUsdg,
          bondOfpk,
        },
      ],
    })
    const calls = [approve(usdg, bondUsdg), ...(bondOfpk > 0n ? [approve(ofpk, bondOfpk)] : []), { to: registry, data }]
    if (!(await this.finish(argv, calls))) return
    const base = this.env.OFFPEAK_PUBLIC_BASE_URL
    if (!base) {
      this.deps.print("OFFPEAK_PUBLIC_BASE_URL is not set, so the router does not have this endpoint yet")
      return
    }
    const { operator, endpoint } = this.config
    const sig = await this.account.signMessage({ message: canonicalJson({ endpoint, operator }) })
    const res = await (this.deps.fetcher ?? fetch)(`${base}/v1/hosts/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operator,
        endpoint,
        models: this.config.models.map((model) => ({ name: model.name, digest: manifestDigest(model.recipeManifest), maxTps: model.maxTps })),
        imageDigest: imageDigestFor(this.config),
        gpuClass: gpuClassOf(this.config.gpuClass),
        sig,
      }),
    })
    if (!res.ok) throw new Error(`router refused the endpoint: ${res.status}`)
    this.deps.print(`router has ${endpoint}; canary-only probation runs for 72 h`)
  }

  async priceSheet(argv: string[]) {
    if (argv[1] !== "set") throw new Error(USAGE)
    const raw = sheetFileSchema.parse(JSON.parse(await readFile(required(argv, "--file"), "utf8")))
    const model = this.config.models.find((row) => row.name === raw.model)
    if (!model) throw new Error(`host.yaml has no model ${raw.model}`)
    const { model: _name, ...fields } = raw
    const sheet = sheetFromJson(sheetJsonSchema.parse({ ...fields, host: this.config.operator, modelDigest: manifestDigest(model.recipeManifest) }))
    const registry = this.deployment.HostRegistry
    const problem = sheetProblem(sheet, (this.deps.clock ?? (() => Math.floor(Date.now() / 1000)))())
    if (problem) throw new Error(problem)
    const sig = await signTyped(this.account, sheetTypedData(sheet, registry) as never)
    const base = this.env.OFFPEAK_PUBLIC_BASE_URL
    if (!base) throw new Error("OFFPEAK_PUBLIC_BASE_URL is required")
    const res = await (this.deps.fetcher ?? fetch)(`${base}/v1/hosts/price-sheet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheet: sheetToJson(sheet), sig }),
    })
    const reply = routerReply.safeParse(await res.json().catch(() => null)).data
    if (!res.ok || !reply?.ok) throw new Error(`router refused the sheet: ${reply?.error ?? res.status}`)
    // Saved only now. A sheet the router never took would make this host refuse the sheet it does bill from.
    await new SheetBook(dataPaths(this.config).sheets, this.config.operator, registry).save(sheet, sig)
    this.deps.print(`sheet ${sheetHashOf(sheet, registry)} in force from ${sheet.validFrom}`)
  }

  async credits(argv: string[]) {
    if (argv[1] === "withdraw") {
      await this.finish(argv, [{ to: this.deployment.HostRegistry, data: encodeFunctionData({ abi: hostRegistryAbi, functionName: "withdrawCredits" }) }])
      return
    }
    const view = await this.chain.registration(this.config.operator)
    this.deps.print(`releasable ${view.releasableCredits} µUSDG`)
    this.deps.print(`pending ${view.pendingCredits} µUSDG`)
  }

  /** A sealed agent makes a new key at every boot, so its ref is only known once it runs. */
  async attestation(argv: string[]) {
    const { host, port } = this.config.listen
    const res = await (this.deps.fetcher ?? fetch)(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/offpeak/v1/attest`)
    const ref = attestStatus.safeParse(await res.json().catch(() => null)).data?.attestationRef
    if (!res.ok || !ref) throw new Error("the running agent has no attestationRef; is host.yaml's sealed section set?")
    this.deps.print(`attestationRef ${ref}`)
    const data = encodeFunctionData({
      abi: hostRegistryAbi,
      functionName: "updateServing",
      args: [
        this.config.models.map((model) => manifestDigest(model.recipeManifest)),
        this.config.models.map((model) => model.maxTps),
        imageDigestFor(this.config),
        gpuClassOf(this.config.gpuClass),
        ref as Hex,
      ],
    })
    this.deps.print("updateServing restarts the 72 h probation if the image, GPU class or models changed; the ref alone does not")
    await this.finish(argv, [{ to: this.deployment.HostRegistry, data }])
  }

  async exit(argv: string[]) {
    const functionName = argv.includes("--finalize") ? "finalizeExit" : "exit"
    if (functionName === "exit") this.deps.print("exiting starts a 7-day unbonding period; bonds come back with exit --finalize after it")
    await this.finish(argv, [{ to: this.deployment.HostRegistry, data: encodeFunctionData({ abi: hostRegistryAbi, functionName }) }])
  }
}

const sheetUnits = z.union([z.string(), z.int().nonnegative()]).transform(String)

/** What a host writes by hand: the model by name, and amounts as strings or plain numbers. */
const sheetFileSchema = z.strictObject({
  model: z.string().min(1),
  baseIn: z.array(sheetUnits),
  baseOut: z.array(sheetUnits),
  floorIn: sheetUnits,
  floorOut: sheetUnits,
  validFrom: z.int().nonnegative(),
  nonce: sheetUnits,
})

const routerReply = z.looseObject({ ok: z.boolean(), error: z.string().optional() })

const attestStatus = z.looseObject({ attestationRef: z.string().regex(/^0x[0-9a-f]{64}$/) })

/** Writes a manifest for a new model. It needs no key or chain, so it runs before anything else exists. */
async function writeManifest(argv: string[], deps: CliDeps) {
  const kind = z.enum(["chat", "embeddings"]).parse(flagValue(argv, "--kind") ?? "chat")
  const manifest = await buildManifest(required(argv, "--model-dir"), { name: required(argv, "--name"), kind })
  const out = required(argv, "--out")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`)
  deps.print(`${manifest.name} ${manifestDigest(manifest)}`)
}

/** Runs one command. Anything that goes wrong throws, and the wrapper below turns that into exit code 1. */
export async function run(argv: string[], deps: CliDeps) {
  const command = argv[0]
  if (command === "init" && argv.includes("--manifest")) return writeManifest(argv, deps)
  if (!["init", "verify", "register", "price-sheet", "credits", "attestation", "exit"].includes(command ?? "")) {
    deps.print(USAGE)
    return
  }
  const commands = new Commands(argv, deps)
  if (command === "init") return commands.init()
  if (command === "verify") return commands.verify(argv)
  if (command === "register") return commands.register(argv)
  if (command === "price-sheet") return commands.priceSheet(argv)
  if (command === "credits") return commands.credits(argv)
  if (command === "attestation") return commands.attestation(argv)
  return commands.exit(argv)
}

if (import.meta.main) {
  try {
    await run(process.argv.slice(2), { env: process.env, print: console.log })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
