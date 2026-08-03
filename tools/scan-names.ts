#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const listPath = `${process.env.HOME}/.offpeak-denylist`
let patterns: string[] = []
try {
  patterns = readFileSync(listPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
} catch {
  console.error(`missing denylist at ${listPath}`)
  process.exit(1)
}
const allow = new Set(["tools/lint-claims.ts", "docs/product-rules.md", "docs/BUILD_B.md"])
const lintSrc = readFileSync(new URL("./lint-claims.ts", import.meta.url), "utf8")
const quoted = [...lintSrc.matchAll(/"([^"\\]+)"/g)].map((m) => m[1]!.toLowerCase())
const tree = spawnSync(
  "git",
  ["grep", "-n", "-i", "-E", patterns.join("|"), "--", ".", ":(exclude)bun.lock", ":(exclude)*.lock"],
  { encoding: "utf8" },
)
const hits = (tree.stdout || "")
  .split("\n")
  .filter(Boolean)
  .filter((line) => {
    const file = line.split(":")[0] ?? ""
    if (!allow.has(file)) return true
    const lower = line.toLowerCase()
    return !quoted.some((phrase) => phrase.length > 3 && lower.includes(phrase))
  })
if (tree.status !== 0 && tree.status !== 1 && hits.length === 0) {
  console.error(tree.stderr)
  process.exit(tree.status ?? 1)
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".data", "out", "cache", "broadcast"].includes(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|md|json|sql|css|html|lua|yml|yaml|toml|example)$/.test(name)) out.push(path)
  }
  return out
}
const root = new URL("..", import.meta.url).pathname
for (const file of walk(root)) {
  const rel = file.slice(root.length).replace(/^\//, "")
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  lines.forEach((line, i) => {
    const lower = line.toLowerCase()
    for (const pattern of patterns) {
      if (!lower.includes(pattern.toLowerCase())) continue
      if (allow.has(rel) && quoted.some((phrase) => phrase.length > 3 && lower.includes(phrase))) continue
      hits.push(`${rel}:${i + 1}`)
    }
  })
}
if (hits.length) {
  console.error([...new Set(hits)].join("\n"))
  process.exit(1)
}
console.log("scan:names ok")
