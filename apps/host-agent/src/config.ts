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
