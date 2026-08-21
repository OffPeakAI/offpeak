import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LAUNCH_TOKENIZER, countChat as countMessages, countInputs as countTexts, countOutput as countReply, loadModelTokenizer, manifestDigest, readManifest, type ChatBody, type ModelManifest, type ModelTokenizer, type TokenCounter } from "@offpeak/shared"
import type { Hex } from "viem"

export { LAUNCH_TOKENIZER, countText, renderChat } from "@offpeak/shared"

/** Where a model's pinned tokenizer files live on the router's disk. */
export type TokenizerSource = { manifest: string; dir: string }

export type TokenizedModel = { name: string; digest: Hex; tokenizer?: TokenizerSource }

const loaded = new Map<string, ModelTokenizer>()
const sources = new Map<string, { manifest: ModelManifest; dir: string }>()

/** Loads each model's manifest at boot. In production every model must have one and it must hash to the model's digest. */
export function loadTokenizers(models: TokenizedModel[], production: boolean) {
  for (const model of models) {
    if (!model.tokenizer) {
      if (production) throw new Error(`no tokenizer for model ${model.name}`)
      continue
    }
    const manifest = readManifest(model.tokenizer.manifest)
    if (manifestDigest(manifest).toLowerCase() !== model.digest.toLowerCase()) throw new Error(`manifest does not match the digest of model ${model.name}`)
    loaded.set(model.digest.toLowerCase(), loadModelTokenizer(manifest, model.tokenizer.dir))
    sources.set(model.digest.toLowerCase(), { manifest, dir: model.tokenizer.dir })
  }
}

const COUNTING_FILES = ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja"]

const publishedJson = new Map<string, string>()

/**
 * The public files a buyer needs to recount, as JSON, or `null` when there are none. The buyer checks them
 * against the model digest, so nothing here is taken on trust. Built once, because the route is public and they run to megabytes.
 */
export function publishedTokenizer(digest: string) {
  const key = digest.toLowerCase()
  const known = publishedJson.get(key)
  if (known) return known
  const source = sources.get(key)
  if (!source) return null
  const { manifest, dir } = source
  const pinned = new Set([...manifest.tokenizer, ...manifest.chatTemplate].map((file) => file.path))
  const files = Object.fromEntries(COUNTING_FILES.filter((path) => pinned.has(path)).map((path) => [path, readFileSync(join(dir, path), "utf8")]))
  const json = JSON.stringify({ contentFormat: manifest.contentFormat, weights: manifest.weights, tokenizer: manifest.tokenizer, chatTemplate: manifest.chatTemplate, files })
  publishedJson.set(key, json)
  return json
}

/** Hosts run the same class on the same pinned files, so both sides count the same way. */
export function tokenizerFor(model: { digest: Hex }): TokenCounter {
  return loaded.get(model.digest.toLowerCase()) ?? LAUNCH_TOKENIZER
}

export function countChat(model: { digest: Hex }, body: ChatBody): number {
  return countMessages(tokenizerFor(model), body.messages ?? [], body.tools)
}

/** `finish` is the stream's `finish_reason`. It decides whether vLLM's count holds the end token. */
export function countOutput(model: { digest: Hex }, text: string, toolCalls?: unknown[] | null, finish?: string | null): number {
  return countReply(tokenizerFor(model), text, toolCalls, finish)
}

export function countInputs(model: { digest: Hex }, inputs: string[]): number {
  return countTexts(tokenizerFor(model), inputs)
}
