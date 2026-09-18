import { readFileSync } from "node:fs"
import { Offpeak, localWallet, type Deployment, type OffpeakOptions } from "@offpeak/sdk"
import { z } from "zod"

const ROLE_KEYS = [
  "OFFPEAK_ROUTER_SIGNER_KEY",
  "OFFPEAK_CHANNEL_PAYEE_KEY",
  "OFFPEAK_SETTLER_KEY",
  "OFFPEAK_KEEPER_KEY",
  "OFFPEAK_FACILITATOR_RELAY_KEY",
  "OFFPEAK_CAPTURER_KEY",
  "OFFPEAK_RULING_KEY",
  "OFFPEAK_AUDITOR_KEY",
  "OFFPEAK_HOST_OPERATOR_KEY",
]

const DEFAULT_MCP_PORT = 8790
const MIN_MCP_TOKEN_LENGTH = 32

const envSchema = z.object({
  OFFPEAK_PUBLIC_BASE_URL: z.url(),
  OFFPEAK_API_KEY: z.string().min(1).optional(),
  OFFPEAK_AGENT_WALLET_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key")
    .optional(),
  OFFPEAK_RPC_URL: z.url().optional(),
  OFFPEAK_DEPLOYMENT_FILE: z.string().min(1).optional(),
  OFFPEAK_ROUTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  OFFPEAK_CHANNEL_ID: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  OFFPEAK_CHANNEL_SEQ: z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .optional(),
  OFFPEAK_CHANNEL_CUMULATIVE: z
    .string()
    .regex(/^\d+$/, "must be whole µUSDG")
    .optional(),
  OFFPEAK_CHANNEL_DEPOSIT: z
    .string()
    .regex(/^\d+$/, "must be whole µUSDG")
    .optional(),
  OFFPEAK_CHANNEL_EXPIRY_S: z.coerce.number().int().positive().optional(),
  OFFPEAK_MCP_HOST: z.string().min(1).default("127.0.0.1"),
  OFFPEAK_MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_MCP_PORT),
  OFFPEAK_MCP_TOKEN: z.string().min(MIN_MCP_TOKEN_LENGTH).optional(),
})

export type McpConfig = z.output<typeof envSchema>

const deploymentSchema = z.object({ contracts: z.record(z.string(), z.string()), roles: z.object({ router: z.string().optional() }).loose().optional() })

/** Names the variable that is wrong and never repeats its value, which could be a key. */
export function readConfig(source: Record<string, string | undefined>): McpConfig {
  if (ROLE_KEYS.some((name) => source[name])) throw new Error("Refusing to start with an Offpeak service key in the environment")
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) throw new Error(`Bad environment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`)
  const config = parsed.data
  if (!config.OFFPEAK_API_KEY && !config.OFFPEAK_AGENT_WALLET_KEY) throw new Error("Set OFFPEAK_API_KEY or OFFPEAK_AGENT_WALLET_KEY")
  if (config.OFFPEAK_CHANNEL_ID && config.OFFPEAK_CHANNEL_DEPOSIT) throw new Error("Set OFFPEAK_CHANNEL_ID or OFFPEAK_CHANNEL_DEPOSIT, not both")
  if ((config.OFFPEAK_CHANNEL_ID || config.OFFPEAK_CHANNEL_DEPOSIT) && !config.OFFPEAK_AGENT_WALLET_KEY) throw new Error("A channel needs OFFPEAK_AGENT_WALLET_KEY")
  if (config.OFFPEAK_CHANNEL_DEPOSIT && !config.OFFPEAK_RPC_URL) throw new Error("Opening a channel needs OFFPEAK_RPC_URL")
  if (config.OFFPEAK_CHANNEL_ID && !config.OFFPEAK_RPC_URL) throw new Error("A channel is read from the chain, which needs OFFPEAK_RPC_URL")
  if (Boolean(config.OFFPEAK_CHANNEL_SEQ) !== Boolean(config.OFFPEAK_CHANNEL_CUMULATIVE)) throw new Error("Set OFFPEAK_CHANNEL_SEQ and OFFPEAK_CHANNEL_CUMULATIVE as a pair")
  return config
}

function wallet(key: `0x${string}`) {
  try {
    return localWallet(key)
  } catch {
    throw new Error("OFFPEAK_AGENT_WALLET_KEY is not a usable key")
  }
}

function deployment(file: string | undefined): Deployment | undefined {
  return file ? deploymentSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined
}

/** The key signs inside this process. Requests carry signatures, never the key. */
export function clientFrom(config: McpConfig, fetcher?: typeof fetch, publicClient?: OffpeakOptions["publicClient"]) {
  const known = config.OFFPEAK_CHANNEL_SEQ && config.OFFPEAK_CHANNEL_CUMULATIVE ? { seq: BigInt(config.OFFPEAK_CHANNEL_SEQ), cumulative: BigInt(config.OFFPEAK_CHANNEL_CUMULATIVE) } : undefined
  const channel = config.OFFPEAK_CHANNEL_ID
    ? { id: config.OFFPEAK_CHANNEL_ID, known }
    : config.OFFPEAK_CHANNEL_DEPOSIT
      ? { deposit: BigInt(config.OFFPEAK_CHANNEL_DEPOSIT), expirySeconds: config.OFFPEAK_CHANNEL_EXPIRY_S }
      : undefined
  return new Offpeak({
    baseURL: config.OFFPEAK_PUBLIC_BASE_URL,
    apiKey: config.OFFPEAK_API_KEY,
    wallet: config.OFFPEAK_AGENT_WALLET_KEY ? wallet(config.OFFPEAK_AGENT_WALLET_KEY as `0x${string}`) : undefined,
    rpcUrl: config.OFFPEAK_RPC_URL,
    publicClient,
    deployment: deployment(config.OFFPEAK_DEPLOYMENT_FILE),
    router: config.OFFPEAK_ROUTER_ADDRESS,
    channel,
    fetch: fetcher,
  })
}
