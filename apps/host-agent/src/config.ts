import { readFileSync } from "node:fs"
import { CHAIN_ID, DEV_ONLY_GPU_CLASS, GPU_CLASSES, VLLM_DTYPES, readManifest, type ModelManifest, type Recipe } from "@offpeak/shared"
import { parse } from "yaml"
import { TSM_REPORT_ROOT } from "./sealed/tdx.ts"
import { privateKeyToAddress } from "viem/accounts"
import type { Hex } from "viem"
import { z } from "zod"

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Hex)
  .refine((value) => !/^0x0+$/.test(value), "must not be the zero address")

/** vLLM never listens beyond this machine. Only the agent can reach it. */
const loopbackUrl = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/" && !url.search && !url.hash
}, "must be plain http on this machine")

const LOOPBACK = ["127.0.0.1", "::1", "localhost"]

const IMAGE = /^vllm\/vllm-openai@sha256:[0-9a-f]{64}$/

const modelSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  path: z.string().min(1),
  manifest: z.string().min(1),
  maxTps: z.int().positive(),
  vllmArgs: z.array(z.string()).default([]),
  engine: loopbackUrl.default("http://127.0.0.1:8000"),
  /** Night jobs bill a locked price that can sit outside the band for that hour. This host accepts them. */
  nightJobs: z.boolean().default(false),
})

const hostYamlSchema = z
  .strictObject({
    operator: address,
    endpoint: z.url(),
    gpuClass: z.enum(GPU_CLASSES),
    image: z.string().regex(IMAGE, "must be vllm/vllm-openai pinned by digest"),
    /** The router's signing address. Boot checks it against `UsageLedger.routerSigner`. */
    router: address,
    /** Plain HTTP, so it stays on this machine. TLS goes in front of it. */
    listen: z.strictObject({ host: z.string().min(1).default("127.0.0.1"), port: z.int().min(1).max(65535).default(8790) }).prefault({}),
    dataDir: z.string().min(1).default("/var/lib/offpeak"),
    /** Only reference hosts set this. It turns on `/offpeak/v1/score` for that auditor key. */
    reference: z.strictObject({ auditor: address }).optional(),
    /** Set inside a TDX VM. The bindings name one model, so one agent seals one model. */
    sealed: z
      .strictObject({
        model: z.string().min(1),
        tsmRoot: z.string().min(1).default(TSM_REPORT_ROOT),
      })
      .optional(),
    models: z.array(modelSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const names = config.models.map((model) => model.name)
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "model names must be unique" })
    if (config.operator === config.router) ctx.addIssue({ code: "custom", message: "operator and router must be different keys" })
    if (config.sealed && !names.includes(config.sealed.model)) ctx.addIssue({ code: "custom", message: "sealed.model must be one of models" })
  })

export type HostYaml = z.infer<typeof hostYamlSchema>
export type HostModel = HostYaml["models"][number]

const ROLE_KEYS = [
  "OFFPEAK_ROUTER_SIGNER_KEY",
  "OFFPEAK_CHANNEL_PAYEE_KEY",
  "OFFPEAK_SETTLER_KEY",
  "OFFPEAK_KEEPER_KEY",
  "OFFPEAK_FACILITATOR_RELAY_KEY",
  "OFFPEAK_CAPTURER_KEY",
  "OFFPEAK_RULING_KEY",
  "OFFPEAK_AUDITOR_KEY",
] as const

const hostEnvSchema = z.object({
  OFFPEAK_ENV: z.enum(["local", "testnet-fork", "mainnet"]).default("local"),
  OFFPEAK_CHAIN_ID: z.coerce.number().pipe(z.literal(CHAIN_ID)).default(CHAIN_ID),
  OFFPEAK_RPC_URL: z.url(),
  OFFPEAK_DEPLOYMENT_FILE: z.string().min(1),
  OFFPEAK_HOST_OPERATOR_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key"),
  OFFPEAK_HOST_ENDPOINT: z.url().optional(),
  OFFPEAK_PUBLIC_BASE_URL: z.url().optional(),
  /** A container's own interface, for `deploy/host/compose.yaml`, which publishes the port on the host's loopback only. */
  OFFPEAK_AGENT_BIND: z.string().min(1).optional(),
})

export type HostEnv = z.infer<typeof hostEnvSchema>

/** Both sides enforce this at boot: another role's key on this machine stops the agent. */
export function readHostEnv(env: NodeJS.ProcessEnv): HostEnv {
  const held = ROLE_KEYS.filter((name) => env[name] && env[name] !== "replace-me")
  if (held.length > 0) throw new Error("refusing to start with another role key in the environment")
  return hostEnvSchema.parse(env)
}

/** Boots fail on a digest nobody could have published, such as all zeros left in a template. */
export function assertPinnedImage(image: string) {
  if (!IMAGE.test(image)) throw new Error("image must be vllm/vllm-openai pinned by digest")
  const digest = image.slice(image.indexOf("sha256:") + "sha256:".length)
  if (new Set(digest).size < 4) throw new Error("image digest is a placeholder")
}

const INT_ARGS = ["tensor-parallel-size", "max-model-len"] as const

type VllmArg = { name: keyof Recipe; value: number | string | boolean }

function parseArg(arg: string): VllmArg | null {
  if (arg === "--enable-prefix-caching") return { name: "enable-prefix-caching", value: true }
  if (arg === "--no-enable-prefix-caching") return { name: "enable-prefix-caching", value: false }
  const match = /^--([a-z-]+)=(.+)$/.exec(arg)
  if (!match) return null
  const [, name, value] = match
  if ((INT_ARGS as readonly string[]).includes(name!)) return /^[1-9][0-9]*$/.test(value!) ? { name: name as VllmArg["name"], value: Number(value) } : null
  if (name === "dtype") return (VLLM_DTYPES as readonly string[]).includes(value!) ? { name, value: value! } : null
  return null
}

/** Only the four approved arguments, each once, each with a value the model's recipe allows. */
export function assertRecipe(model: { vllmArgs: string[] }, recipe: Recipe = {}) {
  const seen = new Set<string>()
  for (const arg of model.vllmArgs) {
    const parsed = parseArg(arg)
    if (!parsed || seen.has(parsed.name)) throw new Error(`vllm arg not in the recipe: ${arg}`)
    seen.add(parsed.name)
    const allowed = recipe[parsed.name] as (number | string | boolean)[] | undefined
    if (allowed && !allowed.includes(parsed.value)) throw new Error(`vllm arg not in the recipe: ${arg}`)
  }
}

export function maxModelLen(model: { vllmArgs: string[] }): number | null {
  for (const arg of model.vllmArgs) {
    const parsed = parseArg(arg)
    if (parsed?.name === "max-model-len") return parsed.value as number
  }
  return null
}

export type LoadedModel = HostModel & { recipeManifest: ModelManifest }

export type HostConfig = Omit<HostYaml, "models"> & { models: LoadedModel[] }

export function parseHostYaml(text: string): HostYaml {
  return hostYamlSchema.parse(parse(text))
}

/** Reads and checks `host.yaml`. Every refusal here stops the boot. */
export function loadHostConfig(path: string, env: HostEnv): HostConfig {
  const file = parseHostYaml(readFileSync(path, "utf8"))
  assertPinnedImage(file.image)
  const local = env.OFFPEAK_ENV === "local"
  if (file.gpuClass === DEV_ONLY_GPU_CLASS && !local) throw new Error(`${DEV_ONLY_GPU_CLASS} is not routable outside local`)
  if (!local && !file.endpoint.startsWith("https://")) throw new Error("endpoint must be https outside local")
  if (!local && !LOOPBACK.includes(file.listen.host)) throw new Error("listen.host must be loopback outside local: the agent speaks plain HTTP, so a TLS proxy goes in front of it")
  if (env.OFFPEAK_HOST_ENDPOINT && env.OFFPEAK_HOST_ENDPOINT !== file.endpoint) throw new Error("OFFPEAK_HOST_ENDPOINT differs from host.yaml")
  if (privateKeyToAddress(env.OFFPEAK_HOST_OPERATOR_KEY as Hex).toLowerCase() !== file.operator) throw new Error("operator key does not match host.yaml")
  const models = file.models.map((model) => {
    const recipeManifest = readManifest(model.manifest)
    if (recipeManifest.name !== model.name) throw new Error(`manifest is for ${recipeManifest.name}, not ${model.name}`)
    assertRecipe(model, recipeManifest.recipe)
    return { ...model, recipeManifest }
  })
  return { ...file, models }
}
