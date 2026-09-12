import { readFileSync } from "node:fs"
import { z } from "zod"
import { assertKeySeparation } from "../../../services/common/src/env.ts"
import { parseKek } from "./sample.ts"

const auditorEnv = z.object({
  OFFPEAK_ENV: z.enum(["local", "testnet-fork", "mainnet"]),
  OFFPEAK_CHAIN_ID: z.coerce.number().pipe(z.literal(4663)),
  OFFPEAK_RPC_URL: z.string().url(),
  OFFPEAK_DEPLOYMENT_FILE: z.string().min(1),
  OFFPEAK_DATABASE_URL: z.string().min(1),
  OFFPEAK_REDIS_URL: z.string().min(1),
  OFFPEAK_INTERNAL_TOKEN: z.string().min(32),
  OFFPEAK_INDEXER_URL: z.string().url(),
  OFFPEAK_PUBLIC_BASE_URL: z.string().url(),
  OFFPEAK_AUDITOR_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  OFFPEAK_AUDIT_SAMPLE_KEK: z.string().refine((value) => parseKek(value) !== null, "must be 32 bytes of hex"),
  OFFPEAK_CANARY_ACCOUNTS_FILE: z.string().min(1),
  /** The operator's own prompts, kept outside the repo. `canaryCorpus` refuses mainnet without it. */
  OFFPEAK_CANARY_CORPUS_FILE: z.string().min(1).optional(),
  OFFPEAK_MODELS_FILE: z.string().min(1),
  OFFPEAK_AUDITOR_PORT: z.coerce.number().int().default(8792),
  OFFPEAK_AUDITOR_FILE_THROUGHPUT: z.enum(["0", "1"]).default("0"),
})

export type AuditorEnv = z.infer<typeof auditorEnv>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AuditorEnv {
  assertKeySeparation(source, "OFFPEAK_AUDITOR_KEY")
  return auditorEnv.parse(source)
}

const modelRows = z.array(z.object({ name: z.string().min(1), digest: z.string().regex(/^0x[0-9a-f]{64}$/), kind: z.string() }))

export function loadModels(path: string) {
  return modelRows.parse(JSON.parse(readFileSync(path, "utf8"))).filter((row) => row.kind === "chat").map((row) => ({ name: row.name, digest: row.digest as `0x${string}` }))
}
