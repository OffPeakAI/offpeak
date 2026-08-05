import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Hex } from "viem"
import { z } from "zod"
import { manifestSha256, modelDigestOf } from "./hash.ts"
import { modelTokenizerFrom, type ModelTokenizer } from "./tokenizer.ts"

const relativePath = z.string().refine((path) => !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "must be a relative path")

const fileEntry = z.strictObject({ path: relativePath, sha256: z.string().regex(/^[0-9a-f]{64}$/) })

export const VLLM_DTYPES = ["auto", "bfloat16", "float", "float16", "float32", "half"] as const

/** The values a host may pick for this model. An argument left out may take any value of its type. */
export const recipeSchema = z.strictObject({
  "tensor-parallel-size": z.array(z.int().min(1)).min(1).optional(),
  "max-model-len": z.array(z.int().min(1)).min(1).optional(),
  dtype: z.array(z.enum(VLLM_DTYPES)).min(1).optional(),
  "enable-prefix-caching": z.array(z.boolean()).min(1).optional(),
})

export type Recipe = z.infer<typeof recipeSchema>

/** The files that make up a model, split the way `modelDigest` hashes them (3.2). */
export const modelManifestSchema = z
  .strictObject({
    v: z.literal(1),
    name: z.string().min(1),
    kind: z.enum(["chat", "embeddings"]),
    /** How vLLM hands content to this template. The tokenizer works this out from the pinned template and refuses a manifest that disagrees. */
    contentFormat: z.enum(["string", "openai"]).default("string"),
    /** vLLM's parser for this model's tool calls. Absent means the model takes no tools. */
    toolCallParser: z.string().regex(/^[a-z0-9_]+$/).optional(),
    recipe: recipeSchema.default({}),
    weights: z.array(fileEntry),
    tokenizer: z.array(fileEntry).min(1),
    chatTemplate: z.array(fileEntry),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>()
    for (const file of [...manifest.weights, ...manifest.tokenizer, ...manifest.chatTemplate]) {
      if (seen.has(file.path)) ctx.addIssue({ code: "custom", message: `${file.path} is listed twice` })
      seen.add(file.path)
    }
    if (!manifest.tokenizer.some((file) => file.path === "tokenizer.json")) ctx.addIssue({ code: "custom", message: "tokenizer.json must be pinned" })
  })

export type ModelManifest = z.infer<typeof modelManifestSchema>

export function readManifest(path: string): ModelManifest {
  return modelManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function manifestFiles(manifest: ModelManifest) {
  return [...manifest.weights, ...manifest.tokenizer, ...manifest.chatTemplate]
}

export function manifestDigest(manifest: Pick<ModelManifest, "weights" | "tokenizer" | "chatTemplate">): Hex {
  return modelDigestOf(manifestSha256(manifest.weights), manifestSha256(manifest.tokenizer), manifestSha256(manifest.chatTemplate))
}

/** Loads the tokenizer from `dir`, refusing any file that differs from the hash the manifest pins. */
export function loadModelTokenizer(manifest: ModelManifest, dir: string): ModelTokenizer {
  const pinned = new Map([...manifest.tokenizer, ...manifest.chatTemplate].map((file) => [file.path, file.sha256]))
  const read = (path: string) => {
    const sha256 = pinned.get(path)
    if (!sha256) return null
    const bytes = readFileSync(join(dir, path))
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${path} does not match its pinned hash`)
    return bytes.toString("utf8")
  }
  return modelTokenizerFrom(read, manifest.contentFormat)
}
