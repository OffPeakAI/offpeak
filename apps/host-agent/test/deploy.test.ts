import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { parse } from "yaml"
import { manifestDigest, modelManifestSchema } from "@offpeak/shared"
import { assertPinnedImage, assertRecipe, parseHostYaml } from "../src/config.ts"
import { DIGEST } from "./support/harness.ts"

const folder = new URL("../../../deploy/host/", import.meta.url).pathname
const compose = parse(readFileSync(`${folder}compose.yaml`, "utf8")) as { services: Record<string, any> }
const example = parseHostYaml(readFileSync(`${folder}host.example.yaml`, "utf8"))
const manifest = modelManifestSchema.parse(JSON.parse(readFileSync(`${folder}manifests/qwen2.5-0.5b-instruct.json`, "utf8")))

describe("deploy/host", () => {
  test("vLLM is pinned by a real digest, the same one host.yaml carries", () => {
    const image: string = compose.services.vllm.image
    assertPinnedImage(image)
    expect(image).toBe(example.image)
    expect(image).toBe("vllm/vllm-openai@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34")
  })

  test("vLLM stays on loopback, and the agent is the only way in", () => {
    expect(compose.services.vllm.command).toContain("--host=127.0.0.1")
    expect(compose.services.agent.network_mode).toBe("service:vllm")
    expect(compose.services.vllm.ports).toEqual(["127.0.0.1:${OFFPEAK_AGENT_PORT:-8790}:8790"])
  })

  test("the agent's plain HTTP port never leaves this machine", () => {
    expect(example.listen.host).toBe("127.0.0.1")
    expect(compose.services.agent.environment.OFFPEAK_AGENT_BIND).toBe("0.0.0.0")
    for (const row of compose.services.vllm.ports) expect(row).toStartWith("127.0.0.1:")
    expect(readFileSync(new URL("../../../docs/runbooks/deploy-host.md", import.meta.url), "utf8")).toContain("TLS")
  })

  test("the model folder is read-only on both sides", () => {
    for (const service of ["vllm", "agent"]) expect(compose.services[service].volumes.filter((row: string) => row.includes("/models/current")).every((row: string) => row.endsWith(":ro"))).toBe(true)
  })

  test("vLLM gets no arguments but the fixed ones and the agent's", () => {
    expect(compose.services.vllm.command).toStartWith("--model=/models/current --host=127.0.0.1 --port=8000 ${VLLM_ARGS")
  })

  test("the agent's base image is pinned too", () => {
    expect(readFileSync(`${folder}Dockerfile.agent`, "utf8")).toMatch(/^FROM oven\/bun@sha256:[0-9a-f]{64}$/m)
  })

  test("the agent's image leaves out the auditor, but keeps its manifest for the lockfile", () => {
    const rules = readFileSync(`${folder}Dockerfile.agent.dockerignore`, "utf8").split("\n").map((line) => line.trim())
    expect(rules).toContain("apps/auditor/*")
    expect(rules).toContain("!apps/auditor/package.json")
    for (const file of readdirSync(new URL("../src", import.meta.url), { recursive: true }).map(String).filter((name) => name.endsWith(".ts"))) {
      expect(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).not.toMatch(/from "[^"]*(apps\/auditor|\.\.\/auditor)/)
    }
  })

  test("the example's arguments fit its manifest, which is the tested fixture", () => {
    assertRecipe(example.models[0]!, manifest.recipe)
    expect(manifestDigest(manifest)).toBe(DIGEST)
  })
})
