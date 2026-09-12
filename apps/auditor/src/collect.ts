import { appendFileSync, readFileSync } from "node:fs"
import { randomInt } from "node:crypto"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import { openCanary, type Rng } from "./canaries.ts"
import type { SwapRow } from "./calibrate.ts"
import { readCorpus, type Corpus } from "./corpus.ts"
import type { TrafficShape } from "./sample.ts"
import { scoreOnReference, type Fetcher, type ScoreSigner } from "./score.ts"

/**
 * The GPU half of calibration: runs corpus prompts on real serving engines and has a reference host
 * score each reply, one JSON row per response for `calibrate.ts`. Honest targets cover at least two
 * GPU classes, two images and varied load. Stand-in targets serve int4, fp8, a smaller sibling or
 * another fine-tune, and carry that name as `kind`.
 */
const target = z.object({
  label: z.string().min(1),
  /** An OpenAI-compatible engine reached directly, so nothing here is billed or settled. */
  baseUrl: z.string().url(),
  model: z.string().min(1),
  gpuClass: z.string().min(1),
  imageDigest: z.string().min(1),
  hostWeek: z.string().min(1),
  kind: z.string().optional(),
  responses: z.number().int().positive(),
  /** Requests in flight at once, which is how a run varies batch load. */
  concurrency: z.number().int().positive().default(1),
  reference: z.object({ host: z.string().min(1), endpoint: z.string().url() }),
})

export type CollectTarget = z.infer<typeof target>

const TEMPERATURES = [0, 0.2, 0.4, 0.7, 1, 1.2]
const MAX_TOKENS = [32, 64, 128, 256, 512, 1024]

const pick = <T>(items: readonly T[], rng: Rng) => items[Math.floor(rng() * items.length)]!

const shapeOf = (rng: Rng): TrafficShape => ({ temperature: pick(TEMPERATURES, rng), topP: null, maxTokens: pick(MAX_TOKENS, rng), tools: 0, stream: false, system: rng() < 0.3, turns: 1 + Math.floor(rng() * 3), format: null, seed: false, stop: false })

const reply = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1), usage: z.object({ completion_tokens: z.number().int().nonnegative() }) })

async function oneRow(fetcher: Fetcher, signer: ScoreSigner, corpus: Corpus, spec: CollectTarget, rng: Rng): Promise<SwapRow | Omit<SwapRow, "kind"> | null> {
  const { body } = openCanary(corpus, spec.model, shapeOf(rng), rng)
  const res = await fetcher(`${spec.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${spec.label} answered ${res.status}`)
  const parsed = reply.parse(await res.json())
  const text = parsed.choices[0]!.message.content
  if (text.length === 0) return null
  const ll = await scoreOnReference(fetcher, signer, spec.reference, { model: spec.model, messages: body.messages, output: text })
  const row = { hostWeek: spec.hostWeek, gpuClass: spec.gpuClass, imageDigest: spec.imageDigest, temperature: Number(body.temperature), tokensOut: parsed.usage.completion_tokens, ll }
  return spec.kind ? { ...row, kind: spec.kind } : row
}

export async function collectRows(fetcher: Fetcher, signer: ScoreSigner, corpus: Corpus, specs: readonly CollectTarget[], rng: Rng, write: (row: object) => void) {
  let written = 0
  for (const spec of specs) {
    let left = spec.responses
    while (left > 0) {
      const batch = Math.min(left, spec.concurrency)
      const rows = await Promise.all(Array.from({ length: batch }, () => oneRow(fetcher, signer, corpus, spec, rng)))
      for (const row of rows) {
        if (!row) continue
        write(row)
        written++
      }
      left -= batch
    }
  }
  return written
}

/** `bun run apps/auditor/src/collect.ts --targets targets.json --corpus corpus.json --out rows.jsonl`, on a machine with the GPUs. */
async function main(argv: readonly string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const targetsFile = value("--targets")
  const corpusFile = value("--corpus")
  const out = value("--out")
  const key = process.env.OFFPEAK_AUDITOR_KEY
  if (!targetsFile || !corpusFile || !out || !key) throw new Error("usage: OFFPEAK_AUDITOR_KEY=… collect --targets <file.json> --corpus <file.json> --out <rows.jsonl>")
  const specs = z.array(target).min(1).parse(JSON.parse(readFileSync(targetsFile, "utf8")))
  const rng = () => randomInt(2 ** 47) / 2 ** 47
  const written = await collectRows((url, init) => fetch(url, init), { ...privateKeyToAccount(key as Hex), localKey: key as Hex }, readCorpus(corpusFile), specs, rng, (row) => appendFileSync(out, `${JSON.stringify(row)}\n`))
  console.log(JSON.stringify({ written, out }))
}

if (import.meta.main) await main(process.argv.slice(2))
