import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { imageDigestOf, manifestDigest, manifestFiles, sha256Hex, type Hex, type ModelManifest } from "@offpeak/shared"

const TOKENIZER_FILES = new Set(["added_tokens.json", "merges.txt", "special_tokens_map.json", "spiece.model", "tokenizer.json", "tokenizer.model", "vocab.json", "vocab.txt"])
const TEMPLATE_FILES = new Set(["chat_template.jinja", "chat_template.json", "tokenizer_config.json"])

const DAY_MS = 86_400_000

/** Reads in chunks, so hashing weights neither loads them into memory nor stops the server. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
export async function modelFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if ((await stat(path)).isDirectory()) await walk(path)
      else found.push(relative(dir, path).split(sep).join("/"))
    }
  }
  await walk(dir)
  return found.sort()
}

/** Hashes every file on disk. A file the manifest does not list, or one it lists that is gone or changed, stops this. */
export async function hashModel(dir: string, manifest: ModelManifest): Promise<Hex> {
  const pinned = new Map(manifestFiles(manifest).map((file) => [file.path, file.sha256]))
  const found = await modelFiles(dir)
  for (const path of found) if (!pinned.has(path)) throw new Error(`file is not in the manifest: ${path}`)
  const present = new Set(found)
  for (const path of pinned.keys()) if (!present.has(path)) throw new Error(`file is missing: ${path}`)
  const actual = new Map<string, string>()
  for (const path of found) actual.set(path, await sha256File(join(dir, path)))
  for (const [path, sha256] of pinned) if (actual.get(path) !== sha256) throw new Error(`file differs from its manifest hash: ${path}`)
  const measured = (group: { path: string }[]) => group.map((file) => ({ path: file.path, sha256: actual.get(file.path)! }))
  return manifestDigest({ weights: measured(manifest.weights), tokenizer: measured(manifest.tokenizer), chatTemplate: measured(manifest.chatTemplate) })
}

/** Writes down what is on disk now. Used to prepare a manifest for a new model, never to accept one at boot. */
export async function buildManifest(dir: string, input: Pick<ModelManifest, "name" | "kind">): Promise<ModelManifest> {
  const manifest: ModelManifest = { v: 1, ...input, contentFormat: "string", recipe: {}, weights: [], tokenizer: [], chatTemplate: [] }
  for (const path of await modelFiles(dir)) {
    const file = { path, sha256: await sha256File(join(dir, path)) }
    const group = TOKENIZER_FILES.has(path) ? manifest.tokenizer : TEMPLATE_FILES.has(path) ? manifest.chatTemplate : manifest.weights
    group.push(file)
  }
  return manifest
}

export function expectDigest(actual: Hex, registered: Hex) {
  if (actual.toLowerCase() !== registered.toLowerCase()) throw new Error("model digest mismatch")
}

export type WatchedModel = { name: string; path: string; digest: Hex; manifest: ModelManifest }

/** Holds the last hash result. A failure here stops serving until the operator restarts on good files. */
export class ModelIntegrity {
  failed: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly models: WatchedModel[]) {}

  async verify() {
    for (const model of this.models) expectDigest(await hashModel(model.path, model.manifest), model.digest)
  }

  async recheck() {
    try {
      await this.verify()
    } catch (err) {
      this.failed = err instanceof Error ? err.message : "model check failed"
      console.error(JSON.stringify({ service: "host-agent", event: "model_integrity_failed", error: this.failed }))
    }
  }

  watch(everyMs = DAY_MS) {
    this.timer = setInterval(() => void this.recheck(), everyMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}

export { imageDigestOf, sha256Hex }
