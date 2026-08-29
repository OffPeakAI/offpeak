import { describe, expect, test } from "bun:test"
import { gpuClassOf } from "@offpeak/shared"
import { assertGpuClass, assertRegisteredGpu, classifyGpu, parseNvidiaSmi } from "../src/gpu.ts"

const smi = (...rows: [string, number][]) => ["name, memory.total [MiB], uuid", ...rows.map(([name, memory], index) => `${name}, ${memory} MiB, GPU-0000000${index}-aaaa-bbbb-cccc-1234567890ab`)].join("\n") + "\n"

describe("nvidia-smi output", () => {
  test("reads rows and skips the header", () => {
    expect(parseNvidiaSmi(smi(["NVIDIA H100 80GB HBM3", 81559]))).toEqual([{ name: "NVIDIA H100 80GB HBM3", memoryMiB: 81559, uuid: "GPU-00000000-aaaa-bbbb-cccc-1234567890ab" }])
  })

  test("a row it cannot read stops the check", () => {
    expect(() => parseNvidiaSmi("name, memory.total [MiB], uuid\nNVIDIA H100 80GB HBM3, [N/A], GPU-1\n")).toThrow("cannot read")
    expect(() => parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toThrow("cannot read")
  })
})

describe("class mapping", () => {
  test.each([
    ["NVIDIA H100 80GB HBM3", 81559, "h100-80g-sxm"],
    ["NVIDIA H100 SXM5 80GB", 81559, "h100-80g-sxm"],
    ["NVIDIA H100 PCIe", 81559, "h100-80g-pcie"],
    ["NVIDIA H200 141GB HBM3e", 143771, "h200-141g"],
    ["NVIDIA A100-SXM4-80GB", 81920, "a100-80g"],
    ["NVIDIA A100 80GB PCIe", 81920, "a100-80g"],
    ["NVIDIA L40S", 46068, "l40s-48g"],
    ["NVIDIA GeForce RTX 4090", 24564, "rtx4090-24g"],
  ])("%s is %s MiB of %s", (name, memory, cls) => {
    expect(classifyGpu([{ name, memoryMiB: memory }])).toBe(cls as never)
  })

  test.each([
    ["a 40 GB A100", "NVIDIA A100-SXM4-40GB", 40960],
    ["an H100 NVL", "NVIDIA H100 NVL", 95830],
    ["a 4090 D", "NVIDIA GeForce RTX 4090 D", 48000],
    ["an unlisted card", "NVIDIA GeForce RTX 3090", 24576],
  ])("%s has no class", (_name, name, memory) => {
    expect(classifyGpu([{ name, memoryMiB: memory }])).toBeNull()
  })

  test("several cards of one class are that class", () => {
    expect(classifyGpu(parseNvidiaSmi(smi(["NVIDIA L40S", 46068], ["NVIDIA L40S", 46068])))).toBe("l40s-48g")
  })

  test("a mixed machine has no class", () => {
    expect(classifyGpu(parseNvidiaSmi(smi(["NVIDIA L40S", 46068], ["NVIDIA GeForce RTX 4090", 24564])))).toBeNull()
  })

  test("no cards is no class", () => {
    expect(classifyGpu([])).toBeNull()
  })
})

describe("refusing to start", () => {
  test("a match passes", () => {
    assertGpuClass("h100-80g-sxm", smi(["NVIDIA H100 80GB HBM3", 81559]), false)
  })

  test("a mismatch with host.yaml refuses", () => {
    expect(() => assertGpuClass("h100-80g-sxm", smi(["NVIDIA H100 PCIe", 81559]), false)).toThrow("gpu class mismatch")
    expect(() => assertGpuClass("h200-141g", smi(["NVIDIA GeForce RTX 4090", 24564]), false)).toThrow("gpu class mismatch")
  })

  test("an unknown class and empty output refuse", () => {
    expect(() => assertGpuClass("h100-80g-liquid", smi(), false)).toThrow("unknown gpu class")
    expect(() => assertGpuClass("h100-80g-sxm", null, false)).toThrow("no output")
    expect(() => assertGpuClass("h100-80g-sxm", smi(), false)).toThrow("gpu class mismatch")
  })

  test("the dev class needs no card, only local", () => {
    assertGpuClass("cpu-tdx-dev", null, true)
    expect(() => assertGpuClass("cpu-tdx-dev", null, false)).toThrow("not routable")
  })

  test("a class other than the registered one refuses", () => {
    assertRegisteredGpu("l40s-48g", gpuClassOf("l40s-48g"))
    expect(() => assertRegisteredGpu("l40s-48g", gpuClassOf("h200-141g"))).toThrow("differs from the registration")
  })
})
