#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const banned = [
  "Claude/GPT at a discount",
  "guaranteed cheapest",
  "staking rewards",
  "APY",
  "yield",
  "passive income",
  /\breturns\b/i,
]
const features: { flag: string; pattern: RegExp }[] = [
  { flag: "channels", pattern: /channels are (live|available)/i },
  { flag: "upto", pattern: /upto is (live|available)/i },
  { flag: "night_jobs", pattern: /night jobs are (live|available)/i },
  { flag: "windows", pattern: /windows are (live|available)/i },
  { flag: "sealed", pattern: /sealed tier is (live|available)/i },
  { flag: "token_hooks", pattern: /token hooks are (live|available)/i },
]
const qualified = /not switched on yet|coming in P2|coming in P3/i

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(md|tsx|ts|html)$/.test(name)) out.push(path)
  }
  return out
}

const files = [
  ...walk(join(root, "apps/web")),
  ...walk(join(root, "docs")).filter((p) => !p.endsWith("BUILD_B.md") && !p.endsWith("product-rules.md")),
  ...walk(join(root, "packages")).filter((p) => p.endsWith("README.md") || p.includes(`${join("packages", "mcp")}`)),
]
const status = JSON.parse(readFileSync(new URL("./status-fixture.json", import.meta.url), "utf8")) as { features: Record<string, boolean> }
const hits: string[] = []
for (const file of files) {
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  lines.forEach((line, i) => {
    for (const phrase of banned) {
      const found = typeof phrase === "string" ? line.includes(phrase) : phrase.test(line)
      if (found) hits.push(`${file}:${i + 1}: banned phrase`)
    }
    for (const feature of features) {
      if (feature.pattern.test(line) && !status.features[feature.flag] && !qualified.test(line)) {
        hits.push(`${file}:${i + 1}: ${feature.flag} claimed while off`)
      }
    }
    if (/\b(openrouter|together)\b/i.test(line) && /\d/.test(line) && !/\d{4}-\d{2}-\d{2}/.test(line)) {
      hits.push(`${file}:${i + 1}: competitor figure needs a date`)
    }
  })
}
if (hits.length) {
  console.error(hits.join("\n"))
  process.exit(1)
}
console.log(`lint:claims ok (${files.length} files)`)
