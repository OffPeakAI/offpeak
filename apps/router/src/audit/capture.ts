import { weekIndex } from "@offpeak/shared"
import { drawsSample, parseKek, storeSample, trafficShape, type SampleInput } from "../../../auditor/src/sample.ts"
import type { Stack } from "../context.ts"

const FLUSH_EVERY_S = 60
const FLUSH_AT = 500

type Tally = { counts: Map<string, number>; flushedAt: number }

const tallies = new WeakMap<object, Tally>()

/** Counts per model, week and shape. Only the shape is kept, never any content. */
function tallyShape(stack: Stack, input: Pick<SampleInput, "modelDigest" | "ts" | "body">) {
  const tally = tallies.get(stack.db) ?? { counts: new Map<string, number>(), flushedAt: stack.clock() }
  tallies.set(stack.db, tally)
  const key = JSON.stringify([input.modelDigest, weekIndex(input.ts), trafficShape(input.body)])
  tally.counts.set(key, (tally.counts.get(key) ?? 0) + 1)
  if (tally.counts.size < FLUSH_AT && stack.clock() - tally.flushedAt < FLUSH_EVERY_S) return null
  const rows = [...tally.counts]
  tally.counts = new Map()
  tally.flushedAt = stack.clock()
  return rows
}

async function flushShapes(stack: Stack, rows: [string, number][]) {
  for (const [key, n] of rows) {
    const [modelDigest, week, shape] = JSON.parse(key) as [string, number, string]
    await stack.db.query(
      `INSERT INTO serving.audit_traffic (model_digest, week, shape, n) VALUES ($1,$2,$3,$4)
       ON CONFLICT (model_digest, week, shape) DO UPDATE SET n = serving.audit_traffic.n + EXCLUDED.n`,
      [modelDigest, week, shape, n],
    )
  }
}

/**
 * The whole router side of auditing. It runs after a record is final, and it can only ever log. `input.body` is
 * the body as sent, which is what the record's hash covers. `asked` is the buyer's own, which the traffic shape reads.
 */
export async function noteForAudit(stack: Stack, input: SampleInput, asked: SampleInput["body"] = input.body) {
  try {
    const flush = tallyShape(stack, { ...input, body: asked })
    const kek = parseKek(process.env.OFFPEAK_AUDIT_SAMPLE_KEK)
    await Promise.all([...(flush ? [flushShapes(stack, flush)] : []), ...(kek && drawsSample() ? [storeSample(stack.db, kek, input)] : [])])
  } catch (err) {
    console.error(JSON.stringify({ service: "router", event: "audit_note_failed", reqId: input.reqId, error: String(err) }))
  }
}
