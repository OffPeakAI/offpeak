import { z } from "zod"

const roleKeys = [
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

type RoleKey = (typeof roleKeys)[number]

export const envSchema = z.object({
  OFFPEAK_ENV: z.enum(["local", "testnet-fork", "mainnet"]).default("local"),
  OFFPEAK_CHAIN_ID: z.coerce.number().default(4663),
  OFFPEAK_DATABASE_URL: z.string().default("pglite://memory"),
  OFFPEAK_INDEXER_MODE: z.enum(["live", "mock"]).default("mock"),
  OFFPEAK_PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:8787"),
})

/** The router holds its own keys and no others, and no two of its roles may share one. */
export function assertKeySeparation(env: NodeJS.ProcessEnv, own: RoleKey[]) {
  const present = roleKeys.filter((name) => env[name] && env[name] !== "replace-me")
  if (present.some((name) => !own.includes(name))) throw new Error("refusing to start with another role key in the environment")
  if (new Set(present.map((name) => env[name]!.toLowerCase())).size < present.length) throw new Error("refusing to start with two roles on one key")
}

export function readEnv(env: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(env)
}
