import { privateKeyToAddress } from "viem/accounts"
import { z } from "zod"
import type { Hex } from "viem"

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
] as const

type RoleKey = (typeof ROLE_KEYS)[number]

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/)

const baseEnv = z.object({
  OFFPEAK_ENV: z.enum(["local", "testnet-fork", "mainnet"]),
  OFFPEAK_CHAIN_ID: z.coerce.number().pipe(z.literal(4663)),
  OFFPEAK_RPC_URL: z.string().url(),
  OFFPEAK_CONFIRMATIONS: z.coerce.number().int().min(1).default(2),
  OFFPEAK_DEPLOYMENT_FILE: z.string().min(1),
  OFFPEAK_DATABASE_URL: z.string().min(1),
  OFFPEAK_REDIS_URL: z.string().min(1).optional(),
})

export const indexerEnv = baseEnv.extend({
  OFFPEAK_INTERNAL_TOKEN: z.string().min(32),
  OFFPEAK_RPC_ARCHIVE_URL: z.string().url().optional(),
  OFFPEAK_INDEXER_PORT: z.coerce.number().int().default(8788),
})

export const settlementEnv = baseEnv.extend({
  OFFPEAK_SETTLER_INDEX: z.coerce.number().int().min(1).max(3),
  OFFPEAK_SETTLER_KEY: privateKey,
  OFFPEAK_SETTLER_ADDRESSES: z.string().transform((v) => v.split(",")).pipe(z.array(address).length(3)),
  OFFPEAK_ROUTER_ADDRESS: address,
  OFFPEAK_METRICS_PORT: z.coerce.number().int().optional(),
})

export const rulingEnv = baseEnv.extend({
  OFFPEAK_RULING_INDEX: z.coerce.number().int().min(1).max(3),
  OFFPEAK_RULING_KEY: privateKey,
  OFFPEAK_RULER_ADDRESSES: z.string().transform((v) => v.split(",")).pipe(z.array(address).length(3)),
  OFFPEAK_AUDITOR_ADDRESS: address,
})

export const keeperEnv = baseEnv.extend({
  OFFPEAK_KEEPER_KEY: privateKey,
  OFFPEAK_REDIS_URL: z.string().min(1),
  OFFPEAK_RELAY_ADDRESS: address.optional(),
  OFFPEAK_CAPTURER_ADDRESS: address.optional(),
  OFFPEAK_BURN_MIN_OFPK_PER_USDG: z.coerce.bigint().optional(),
})

export const facilitatorEnv = baseEnv.extend({
  OFFPEAK_INTERNAL_TOKEN: z.string().min(32),
  OFFPEAK_REDIS_URL: z.string().min(1),
  OFFPEAK_FACILITATOR_RELAY_KEY: privateKey,
  OFFPEAK_CAPTURER_KEY: privateKey,
  OFFPEAK_FACILITATOR_PORT: z.coerce.number().int().default(8789),
  OFFPEAK_RELAY_FLOOR_WEI: z.coerce.bigint().default(1_000_000_000_000_000n),
  OFFPEAK_DENYLIST_URL: z.string().url().optional(),
  OFFPEAK_NATIVE_USD: z.coerce.number().positive().default(3_000),
  OFFPEAK_AUTHORIZE_FLUSH_MS: z.coerce.number().int().positive().default(250),
  OFFPEAK_CAPTURE_FLUSH_MS: z.coerce.number().int().positive().default(5_000),
})

/** Refuses to boot when a service holds another role's key, or when two roles share one. */
export function assertKeySeparation(env: Record<string, string | undefined>, own: RoleKey | RoleKey[]) {
  const owned = Array.isArray(own) ? own : [own]
  const seen = new Map<string, RoleKey>()
  for (const role of ROLE_KEYS) {
    const key = env[role]
    if (!key) continue
    if (!owned.includes(role)) throw new Error(`${owned.join(", ")} service must not hold ${role}`)
    const signer = privateKeyToAddress(key as Hex)
    const other = seen.get(signer)
    if (other) throw new Error(`${role} and ${other} share a key`)
    seen.set(signer, role)
  }
}

const blankIsUnset = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema)

export const routerEnv = z.object({
  OFFPEAK_ENV: z.enum(["local", "testnet-fork", "mainnet"]),
  OFFPEAK_DEPLOYMENT_FILE: z.string().min(1),
  OFFPEAK_MODELS_FILE: z.string().min(1),
  OFFPEAK_DATABASE_URL: z.string().min(1),
  OFFPEAK_REDIS_URL: z.string().min(1),
  OFFPEAK_INDEXER_URL: z.string().url(),
  OFFPEAK_FACILITATOR_URL: z.string().url(),
  OFFPEAK_INTERNAL_TOKEN: z.string().min(32),
  OFFPEAK_ROUTER_SIGNER_KEY: privateKey,
  OFFPEAK_CHANNEL_PAYEE: address,
  OFFPEAK_CHANNEL_PAYEE_KEY: z.preprocess((value) => (value === "" || value === "replace-me" ? undefined : value), privateKey.optional()),
  OFFPEAK_PUBLIC_BASE_URL: z.string().url(),
  OFFPEAK_USDG_ADDRESS: address.optional(),
  OFFPEAK_RPC_URL: z.string().url().optional(),
  OFFPEAK_ROUTER_PORT: z.coerce.number().int().default(8787),
  /** Sealed-tier services. Left unset, no host is sealed-verified. */
  OFFPEAK_TDX_VERIFIER_URL: blankIsUnset(z.string().url().optional()),
  OFFPEAK_GPU_ATTESTATION_URL: blankIsUnset(z.string().url().optional()),
  /** JSON list of `{ imageDigest, mrtd, rtmrs }`. Empty means no host passes. */
  OFFPEAK_SEALED_MEASUREMENTS: blankIsUnset(z.string().optional()),
})
