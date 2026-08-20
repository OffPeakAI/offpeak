import { execFile } from "node:child_process"
import { DEV_ONLY_GPU_CLASS, GPU_CLASSES, gpuClassOf, type GpuClassName, type Hex } from "@offpeak/shared"

/** Names as `nvidia-smi` prints them. The memory band keeps a 40 GB A100 or a 94 GB H100 NVL out of the 80 GB classes. */
const TABLE: { pattern: RegExp; minMiB: number; maxMiB: number; cls: GpuClassName }[] = [
  { pattern: /H100.*PCIe/i, minMiB: 75_000, maxMiB: 90_000, cls: "h100-80g-pcie" },
  { pattern: /H100.*(SXM|HBM3)/i, minMiB: 75_000, maxMiB: 90_000, cls: "h100-80g-sxm" },
  { pattern: /H200/i, minMiB: 130_000, maxMiB: 150_000, cls: "h200-141g" },
  { pattern: /A100/i, minMiB: 75_000, maxMiB: 90_000, cls: "a100-80g" },
  { pattern: /L40S/i, minMiB: 42_000, maxMiB: 50_000, cls: "l40s-48g" },
  { pattern: /RTX 4090/i, minMiB: 22_000, maxMiB: 26_000, cls: "rtx4090-24g" },
]

export type GpuRow = { name: string; memoryMiB: number; uuid: string }

/** The header line and blank lines drop out. Any other line must hold a full row. */
export function parseNvidiaSmi(csv: string): GpuRow[] {
  return csv
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("name"))
    .map((line) => {
      const match = /^(.+), (\d+) MiB, (GPU-[0-9a-fA-F-]+)$/.exec(line)
      if (!match) throw new Error(`cannot read nvidia-smi row: ${line}`)
      return { name: match[1]!, memoryMiB: Number(match[2]), uuid: match[3]! }
    })
}

/** A machine has one class. A mix of cards has none, because a request could land on either. */
export function classifyGpu(rows: { name: string; memoryMiB: number }[]): GpuClassName | null {
  const classes = rows.map((row) => TABLE.find((entry) => entry.pattern.test(row.name) && row.memoryMiB >= entry.minMiB && row.memoryMiB <= entry.maxMiB)?.cls ?? null)
  const first = classes[0] ?? null
  return classes.every((cls) => cls === first) ? first : null
}

export function assertGpuClass(expected: string, smiCsv: string | null, allowDev: boolean) {
  if (!GPU_CLASSES.includes(expected as GpuClassName)) throw new Error(`unknown gpu class ${expected}`)
  if (expected === DEV_ONLY_GPU_CLASS) {
    if (!allowDev) throw new Error(`${DEV_ONLY_GPU_CLASS} is not routable outside local`)
    return
  }
  if (!smiCsv) throw new Error("nvidia-smi produced no output")
  const found = classifyGpu(parseNvidiaSmi(smiCsv))
  if (found !== expected) throw new Error(`gpu class mismatch: saw ${found ?? "none"} expected ${expected}`)
}

export function assertRegisteredGpu(expected: string, registered: Hex) {
  if (gpuClassOf(expected).toLowerCase() !== registered.toLowerCase()) throw new Error("gpu class differs from the registration")
}

export function readNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total,uuid", "--format=csv"], { timeout: 15_000 }, (err, stdout) => (err ? reject(new Error("nvidia-smi failed")) : resolve(stdout)))
  })
}
