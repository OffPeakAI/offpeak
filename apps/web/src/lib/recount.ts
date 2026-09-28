import { rest } from "./api.ts"
import type { UsageRecordJson } from "./shared.ts"
import type { Line } from "./verify.ts"

export type Material = { prompt: Record<string, unknown>; output: string; tool_calls?: unknown[]; finish?: string }

export type Pasted = { body: string; output: string; toolCalls: string; finish: string }

export type Published = { context_length: number; tokenizer: unknown }

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** What the buyer pasted, or the sentence that says what is wrong with it. */
export function readMaterial(pasted: Pasted): Material | string {
  const prompt = parsed(pasted.body)
  if (typeof prompt !== "object" || prompt === null || Array.isArray(prompt)) return "The request body must be the JSON you sent."
  const toolCalls = pasted.toolCalls.trim() === "" ? [] : parsed(pasted.toolCalls)
  if (!Array.isArray(toolCalls)) return "Tool calls must be a JSON array."
  const finish = pasted.finish.trim()
  return { prompt: prompt as Record<string, unknown>, output: pasted.output, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(finish ? { finish } : {}) }
}

/**
 * Runs in the browser, and nothing pasted leaves it. The tokenizer files come from the router, but they
 * are used only if they hash to the record's model digest, which the host registered on chain.
 */
export async function recount(record: UsageRecordJson, material: Material, publish: (digest: string) => Promise<Published> = (digest) => rest<Published>(`/v1/tokenizers/${digest}`)) {
  const [{ recountRecord, tokenizerFromFiles }, published] = await Promise.all([import("../../../../packages/shared/src/recount.ts"), publish(record.modelDigest)])
  const tokenizer = published.tokenizer ? tokenizerFromFiles(published.tokenizer, record.modelDigest) : undefined
  return recountRecord(record, { prompt: material.prompt, output: { text: material.output, toolCalls: material.tool_calls, finish: material.finish }, tokenizer, contextLength: published.context_length })
}

export type Recounted = Awaited<ReturnType<typeof recount>>

export function recountLines(report: Recounted, record: Pick<UsageRecordJson, "tokensIn" | "tokensOut">): Line[] {
  const line = (label: string, pass: boolean | null, good: string, bad: string): Line => ({ label, tone: pass ? "ok" : "fail", detail: pass ? good : bad })
  const counted = `You counted ${report.tokensIn} in and ${report.tokensOut} out. The record bills ${record.tokensIn} in and ${record.tokensOut} out.`
  return [
    line("Prompt hash", report.promptOk, "Matches the body the host received.", "Does not match. Check you pasted the exact body you sent."),
    line("Output hash", report.outputOk, "Matches the output on the record.", "Does not match. Check you pasted the whole output."),
    report.countsOk === null ? { label: "Tokens", tone: "wait" as const, detail: "Not checked. This model publishes no tokenizer, so nothing could be counted." } : line("Tokens", report.countsOk, counted, `${counted} That is more than the tolerance allows.`),
  ]
}
