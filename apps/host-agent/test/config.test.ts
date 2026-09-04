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

  test("the endpoint needs https outside local", () => {
    expect(() => loadHostConfig(write(yaml({ endpoint: "http://host.example.net" })), envFor())).toThrow("https")
    expect(loadHostConfig(write(yaml({ endpoint: "http://127.0.0.1:31990" })), envFor({ OFFPEAK_ENV: "local" })).endpoint).toBe("http://127.0.0.1:31990")
  })

  test("the operator key must match operator", () => {
    expect(() => loadHostConfig(write(yaml({ operator: buyer.address })), envFor())).toThrow("operator key")
  })

  test("the endpoint in the environment must match", () => {
    expect(() => loadHostConfig(write(yaml()), envFor({ OFFPEAK_HOST_ENDPOINT: "https://other.example.net" }))).toThrow("differs")
  })

  test("plain HTTP stays on loopback outside local", () => {
    const open = yaml({ extra: "listen:\n  host: 0.0.0.0\n  port: 8790" })
    expect(() => loadHostConfig(write(open), envFor())).toThrow("listen.host must be loopback")
    expect(loadHostConfig(write(yaml({ extra: "listen:\n  host: 127.0.0.1\n  port: 8790" })), envFor()).listen.host).toBe("127.0.0.1")
    expect(loadHostConfig(write(open), envFor({ OFFPEAK_ENV: "local" })).listen.host).toBe("0.0.0.0")
  })

  test("the manifest must be for this model", () => {
    expect(() => loadHostConfig(write(yaml({ name: "other-model" })), envFor())).toThrow("manifest is for")
  })
})

describe("the vLLM recipe", () => {
  const recipe = { "tensor-parallel-size": [1, 2], "max-model-len": [8192], dtype: ["auto" as const], "enable-prefix-caching": [true] }

  test("the four approved arguments pass", () => {
    assertRecipe({ vllmArgs: ["--tensor-parallel-size=2", "--max-model-len=8192", "--dtype=auto", "--enable-prefix-caching"] }, recipe)
    assertRecipe({ vllmArgs: ["--tensor-parallel-size=8", "--max-model-len=128000", "--dtype=float16", "--no-enable-prefix-caching"] })
  })

  test.each([
    ["an argument outside the recipe", "--quantization=awq"],
    ["a swapped model", "--model=/models/smaller"],
    ["a chat template override", "--chat-template=/tmp/x.jinja"],
    ["remote code", "--trust-remote-code"],
    ["a two-part argument", "--dtype"],
    ["a bad number", "--max-model-len=abc"],
    ["a suffixed number", "--max-model-len=8k"],
    ["a zero", "--tensor-parallel-size=0"],
    ["an unknown dtype", "--dtype=int8"],
    ["no dashes", "dtype=auto"],
    ["a value on the flag", "--enable-prefix-caching=yes"],
    ["a shell tail", "--dtype=auto --quantization=awq"],
  ])("%s fails", (_name, arg) => {
    expect(() => assertRecipe({ vllmArgs: [arg] })).toThrow("vllm arg not in the recipe")
  })

  test("a value outside this model's list fails", () => {
    expect(() => assertRecipe({ vllmArgs: ["--tensor-parallel-size=4"] }, recipe)).toThrow("vllm arg not in the recipe")
    expect(() => assertRecipe({ vllmArgs: ["--dtype=float16"] }, recipe)).toThrow("vllm arg not in the recipe")
    expect(() => assertRecipe({ vllmArgs: ["--max-model-len=32768"] }, recipe)).toThrow("vllm arg not in the recipe")
    expect(() => assertRecipe({ vllmArgs: ["--no-enable-prefix-caching"] }, recipe)).toThrow("vllm arg not in the recipe")
  })

  test("an argument given twice fails", () => {
    expect(() => assertRecipe({ vllmArgs: ["--dtype=auto", "--dtype=float16"] })).toThrow("vllm arg not in the recipe")
    expect(() => assertRecipe({ vllmArgs: ["--enable-prefix-caching", "--no-enable-prefix-caching"] })).toThrow("vllm arg not in the recipe")
  })

  test("a bad argument in host.yaml stops the boot", () => {
    expect(() => loadHostConfig(write(yaml({}, ['    vllmArgs: ["--quantization=awq"]'])), envFor())).toThrow("vllm arg not in the recipe")
    expect(() => loadHostConfig(write(yaml({}, ['    vllmArgs: ["--tensor-parallel-size=4"]'])), envFor())).toThrow("vllm arg not in the recipe")
  })
})

describe("the environment", () => {
  const base = { OFFPEAK_RPC_URL: "http://127.0.0.1:31999", OFFPEAK_DEPLOYMENT_FILE: "d.json", OFFPEAK_HOST_OPERATOR_KEY: HOST_KEY }

  test("another role's key stops the agent", () => {
    for (const name of ["OFFPEAK_ROUTER_SIGNER_KEY", "OFFPEAK_AUDITOR_KEY", "OFFPEAK_SETTLER_KEY", "OFFPEAK_RULING_KEY"]) {
      expect(() => readHostEnv({ ...base, [name]: `0x${"11".repeat(32)}` })).toThrow("another role key")
    }
    expect(readHostEnv({ ...base, OFFPEAK_ROUTER_SIGNER_KEY: "replace-me" }).OFFPEAK_ENV).toBe("local")
  })

  test("a missing or malformed operator key, and the wrong chain, are boot failures", () => {
    expect(() => readHostEnv({ ...base, OFFPEAK_HOST_OPERATOR_KEY: undefined })).toThrow()
    expect(() => readHostEnv({ ...base, OFFPEAK_HOST_OPERATOR_KEY: "replace-me" })).toThrow()
    expect(() => readHostEnv({ ...base, OFFPEAK_CHAIN_ID: "1" })).toThrow()
  })
})
