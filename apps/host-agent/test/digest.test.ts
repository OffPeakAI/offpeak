import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifestDigest, manifestSha256, modelDigestOf, type ModelManifest } from "@offpeak/shared"
import { ModelIntegrity, buildManifest, expectDigest, hashModel, modelFiles, sha256File } from "../src/digest.ts"

const dirs: string[] = []

function modelDir(files: Record<string, string> = { "tokenizer.json": "{}", "tokenizer_config.json": "{}", "config.json": "{}", "shards/model-00001.safetensors": "weights one", "shards/model-00002.safetensors": "weights two" }) {
  const dir = mkdtempSync(join(tmpdir(), "offpeak-model-"))
  dirs.push(dir)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the manifest and digest", () => {
  test("files sort into the three groups 3.2 hashes", async () => {
    const manifest = await buildManifest(modelDir(), { name: "demo", kind: "chat" })
    expect(manifest.tokenizer.map((file) => file.path)).toEqual(["tokenizer.json"])
    expect(manifest.chatTemplate.map((file) => file.path)).toEqual(["tokenizer_config.json"])
    expect(manifest.weights.map((file) => file.path)).toEqual(["config.json", "shards/model-00001.safetensors", "shards/model-00002.safetensors"])
  })

  test("the digest follows the sorted path and hash lines in 3.2", async () => {
    const manifest = await buildManifest(modelDir(), { name: "demo", kind: "chat" })
    const lines = (rows: [string, string][]) => `${rows.map(([path, text]) => `${path}\t${hash(text)}`).join("\n")}\n`
    const weights = lines([["config.json", "{}"], ["shards/model-00001.safetensors", "weights one"], ["shards/model-00002.safetensors", "weights two"]])
    const expected = modelDigestOf(`0x${hash(weights)}`, `0x${hash(lines([["tokenizer.json", "{}"]]))}`, `0x${hash(lines([["tokenizer_config.json", "{}"]]))}`)
    expect(manifestDigest(manifest)).toBe(expected)
    expect(manifestSha256(manifest.weights)).toBe(`0x${hash(weights)}`)
  })

  test("hashing reads what is on disk, and a large file hashes the same as its bytes", async () => {
    const dir = modelDir({ big: "x".repeat(9 * 1024 * 1024) })
    expect(await sha256File(join(dir, "big"))).toBe(hash("x".repeat(9 * 1024 * 1024)))
  })

  test("a model linked in from a cache folder counts by its target", async () => {
    const dir = modelDir({ "blobs/abc": "weights" })
    mkdirSync(join(dir, "snapshot"))
    symlinkSync(join(dir, "blobs/abc"), join(dir, "snapshot/model.safetensors"))
    expect(await modelFiles(join(dir, "snapshot"))).toEqual(["model.safetensors"])
    expect(await sha256File(join(dir, "snapshot/model.safetensors"))).toBe(hash("weights"))
  })
})

describe("files against the manifest", () => {
  const good = async () => {
    const dir = modelDir()
    return { dir, manifest: await buildManifest(dir, { name: "demo", kind: "chat" }) }
  }

  test("an untouched folder gives the manifest's digest", async () => {
    const { dir, manifest } = await good()
    expect(await hashModel(dir, manifest)).toBe(manifestDigest(manifest))
  })

  test("a changed weight fails", async () => {
    const { dir, manifest } = await good()
    appendFileSync(join(dir, "shards/model-00002.safetensors"), "!")
    await expect(hashModel(dir, manifest)).rejects.toThrow("differs from its manifest hash")
  })

  test("a changed template fails", async () => {
    const { dir, manifest } = await good()
    writeFileSync(join(dir, "tokenizer_config.json"), '{"chat_template":"x"}')
    await expect(hashModel(dir, manifest)).rejects.toThrow("differs from its manifest hash")
  })

  test("a file the manifest does not list fails", async () => {
    const { dir, manifest } = await good()
    writeFileSync(join(dir, "extra.safetensors"), "smaller model")
    await expect(hashModel(dir, manifest)).rejects.toThrow("not in the manifest")
  })

  test("a missing file fails", async () => {
    const { dir, manifest } = await good()
    rmSync(join(dir, "config.json"))
    await expect(hashModel(dir, manifest)).rejects.toThrow("file is missing")
  })

  test("a digest other than the registered one refuses", async () => {
    const { manifest } = await good()
    expect(() => expectDigest(manifestDigest(manifest), `0x${"11".repeat(32)}`)).toThrow("model digest mismatch")
    expect(() => expectDigest(manifestDigest(manifest), manifestDigest(manifest).toUpperCase().replace("0X", "0x") as `0x${string}`)).not.toThrow()
  })

  test("moving a file between groups changes the digest", async () => {
    const { manifest } = await good()
    const moved: ModelManifest = { ...manifest, weights: manifest.weights.slice(1), tokenizer: [...manifest.tokenizer, manifest.weights[0]!] }
    expect(manifestDigest(moved)).not.toBe(manifestDigest(manifest))
  })
})

describe("the daily re-hash", () => {
  test("a file that changes after boot marks the host failed", async () => {
    const dir = modelDir()
    const manifest = await buildManifest(dir, { name: "demo", kind: "chat" })
    const integrity = new ModelIntegrity([{ name: "demo", path: dir, digest: manifestDigest(manifest), manifest }])
    await integrity.verify()
    await integrity.recheck()
    expect(integrity.failed).toBeNull()
    appendFileSync(join(dir, "config.json"), " ")
    await integrity.recheck()
    expect(integrity.failed).toContain("config.json")
  })

  test("the timer runs the re-hash", async () => {
    const dir = modelDir()
    const manifest = await buildManifest(dir, { name: "demo", kind: "chat" })
    const integrity = new ModelIntegrity([{ name: "demo", path: dir, digest: manifestDigest(manifest), manifest }])
    appendFileSync(join(dir, "config.json"), " ")
    integrity.watch(5)
    for (let i = 0; i < 100 && !integrity.failed; i++) await Bun.sleep(5)
    integrity.stop()
    await Bun.sleep(20)
    expect(integrity.failed).toContain("config.json")
  })
})
