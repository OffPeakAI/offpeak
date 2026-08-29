import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertPinnedImage, assertRecipe, loadHostConfig, maxModelLen, parseHostYaml, readHostEnv } from "../src/config.ts"
import { HOST_KEY, MODEL, buyer, fixtureDir, host, router } from "./support/harness.ts"

const IMAGE = `vllm/vllm-openai@sha256:${"befccf0e7e4089aa".repeat(4)}`

const yaml = (over: Record<string, string> = {}, modelLines: string[] = []) =>
  [
    `operator: "${over.operator ?? host.address}"`,
    `endpoint: ${over.endpoint ?? "https://host.example.net"}`,
    `gpuClass: ${over.gpuClass ?? "h100-80g-sxm"}`,
    `image: ${over.image ?? IMAGE}`,
    `router: "${over.router ?? router.address}"`,
    ...(over.extra ? [over.extra] : []),
    "models:",
    `  - name: ${over.name ?? MODEL}`,
    "    path: /models/current",
    `    manifest: ${over.manifest ?? `${fixtureDir}manifest.json`}`,
    "    maxTps: 400",
    ...modelLines,
  ].join("\n")

const envFor = (over: Record<string, string> = {}) => readHostEnv({ OFFPEAK_ENV: "mainnet", OFFPEAK_RPC_URL: "http://127.0.0.1:31999", OFFPEAK_DEPLOYMENT_FILE: "d.json", OFFPEAK_HOST_OPERATOR_KEY: HOST_KEY, ...over })

const dirs: string[] = []
const write = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "offpeak-config-"))
  dirs.push(dir)
  const path = join(dir, "host.yaml")
  writeFileSync(path, text)
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("host.yaml", () => {
  test("a good file loads with its defaults", () => {
    const config = loadHostConfig(write(yaml({}, ['    vllmArgs: ["--tensor-parallel-size=2", "--max-model-len=8192", "--dtype=auto", "--enable-prefix-caching"]'])), envFor())
    expect(config.operator).toBe(host.address.toLowerCase())
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 8790 })
    expect(config.models[0]!.engine).toBe("http://127.0.0.1:8000")
    expect(config.models[0]!.recipeManifest.name).toBe(MODEL)
    expect(maxModelLen(config.models[0]!)).toBe(8192)
  })

  test.each([
    ["an unknown key", yaml({ extra: "gpuLimit: 2" })],
    ["a bad address", yaml({ operator: "0x123" })],
    ["the zero router", yaml({ router: `0x${"00".repeat(20)}` })],
    ["an unknown gpu class", yaml({ gpuClass: "h100-80g-liquid" })],
    ["no models", "operator: x"],
    ["one key in two roles", yaml({ router: host.address })],
  ])("%s fails", (_name, text) => {
    expect(() => parseHostYaml(text)).toThrow()
  })

  test.each([
    ["a tag", "vllm/vllm-openai:v0.32.0"],
    ["another image", `someone/vllm@sha256:${"ab12".repeat(16)}`],
    ["the template text", "vllm/vllm-openai@sha256:<digest>"],
  ])("an image pinned by %s fails", (_name, image) => {
    expect(() => parseHostYaml(yaml({ image }))).toThrow()
  })

  test("a placeholder digest fails the boot", () => {
    expect(() => assertPinnedImage(`vllm/vllm-openai@sha256:${"0".repeat(64)}`)).toThrow("placeholder")
    expect(() => assertPinnedImage(`vllm/vllm-openai@sha256:${"ab".repeat(32)}`)).toThrow("placeholder")
    expect(() => loadHostConfig(write(yaml({ image: `vllm/vllm-openai@sha256:${"0".repeat(64)}` })), envFor())).toThrow("placeholder")
    assertPinnedImage(IMAGE)
  })

  test("vLLM must stay on this machine", () => {
    expect(() => parseHostYaml(yaml({}, ["    engine: http://10.0.0.9:8000"]))).toThrow()
    expect(() => parseHostYaml(yaml({}, ["    engine: https://127.0.0.1:8000"]))).toThrow()
    expect(parseHostYaml(yaml({}, ["    engine: http://127.0.0.1:8001"])).models[0]!.engine).toBe("http://127.0.0.1:8001")
  })

  test("the dev gpu class stays local", () => {
    const local = envFor({ OFFPEAK_ENV: "local" })
    expect(() => loadHostConfig(write(yaml({ gpuClass: "cpu-tdx-dev" })), envFor())).toThrow("not routable")
    expect(loadHostConfig(write(yaml({ gpuClass: "cpu-tdx-dev" })), local).gpuClass).toBe("cpu-tdx-dev")
  })
