#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import { corpusFigures, corpusProblems, corpusSchema, readPublishedSample } from "../apps/auditor/src/corpus.ts"

/**
 * Checks a canary corpus before it goes anywhere near an auditor: `bun run corpus:check <file>`.
 * A mainnet auditor runs the same checks at boot. The file holds the prompts hosts must not see, so
 * it stays with the operator and nothing here prints a line of it.
 */
function check(path: string) {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { ok: false, problems: ["the file cannot be read as JSON"] }
  }
  const parsed = corpusSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }
  const problems = corpusProblems(parsed.data, readPublishedSample())
  return { ok: problems.length === 0, ...corpusFigures(parsed.data), problems }
}

const path = process.argv[2]
if (!path) {
  console.error("usage: bun run corpus:check <corpus.json>")
  process.exit(2)
}
const report = check(path)
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
