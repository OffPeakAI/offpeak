import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MIN_DETERMINISTIC_TEMPLATES, MIN_OPEN_TEMPLATES, SAMPLE_CORPUS_PATH, canaryCorpus, corpusFigures, corpusProblems, readCorpus, type Corpus } from "./corpus.ts"

const sample = readCorpus(SAMPLE_CORPUS_PATH)
const root = new URL("../../../", import.meta.url).pathname

const entry = (id: string, values = 20) => ({ id, template: `Template ${id} about {a} and {b}.`, vars: { a: Array.from({ length: values }, (_v, i) => `alpha ${i}`), b: Array.from({ length: values }, (_v, i) => `beta ${i}`) } })

/** Made up here, so nothing about a real corpus sits in this file. */
const operatorCorpus = (): Corpus => ({
  leads: ["", "Please: "],
  tails: ["", " Thanks."],
  systems: ["You help a small team."],
  history: [["Morning.", "Morning. What do you need?"]],
  open: Array.from({ length: MIN_OPEN_TEMPLATES }, (_v, i) => entry(`open-${i}`)),
  deterministic: Array.from({ length: MIN_DETERMINISTIC_TEMPLATES }, (_v, i) => entry(`fixed-${i}`, 5)),
  tools: [{ type: "function", function: { name: "lookup" } }],
})

function inFolder<T>(contents: unknown, run: (path: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "offpeak-corpus-"))
  const path = join(folder, "corpus.json")
  writeFileSync(path, JSON.stringify(contents))
  try {
    return run(path)
  } finally {
    rmSync(folder, { recursive: true })
  }
}

describe("the production corpus", () => {
  test("nothing the auditor runs reads the public sample", () => {
    for (const file of ["canaries.ts", "main.ts", "collect.ts", "run.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/corpus\/(sample|prompts)\.json|SAMPLE_CORPUS_PATH/)
    }
  })

  test("mainnet refuses to run canaries with no operator file", () => {
    expect(() => canaryCorpus({ OFFPEAK_ENV: "mainnet" })).toThrow("OFFPEAK_CANARY_CORPUS_FILE")
  })

  test("mainnet refuses the public sample, or anything built on it", () => {
    expect(() => canaryCorpus({ OFFPEAK_ENV: "mainnet", OFFPEAK_CANARY_CORPUS_FILE: SAMPLE_CORPUS_PATH })).toThrow("cannot go to real hosts")
    const copied = operatorCorpus()
    copied.open[0] = sample.open[0]!
    inFolder(copied, (path) => expect(() => canaryCorpus({ OFFPEAK_ENV: "mainnet", OFFPEAK_CANARY_CORPUS_FILE: path })).toThrow("public sample"))
  })

  test("mainnet takes an operator's corpus that passes", () => {
    inFolder(operatorCorpus(), (path) => expect(canaryCorpus({ OFFPEAK_ENV: "mainnet", OFFPEAK_CANARY_CORPUS_FILE: path })?.open).toHaveLength(MIN_OPEN_TEMPLATES))
  })

  test("elsewhere, no file means no canaries rather than the sample", () => {
    expect(canaryCorpus({ OFFPEAK_ENV: "local" })).toBeNull()
    expect(canaryCorpus({ OFFPEAK_ENV: "testnet-fork" })).toBeNull()
  })

  test("the sample stays small enough that it could never pass", () => {
    expect(corpusProblems(sample, null).length).toBeGreaterThan(0)
    expect(corpusFigures(sample).open).toBeLessThan(MIN_OPEN_TEMPLATES)
  })
})

describe("corpus checks", () => {
  const problems = (edit: (corpus: Corpus) => void) => {
    const corpus = operatorCorpus()
    edit(corpus)
    return corpusProblems(corpus, sample).join("; ")
  }

  test("a clean corpus has no problems", () => {
    expect(corpusProblems(operatorCorpus(), sample)).toEqual([])
  })

  test("too few templates, or too little variety, is refused", () => {
    expect(problems((c) => void c.open.pop())).toContain("open templates")
    expect(problems((c) => void c.deterministic.pop())).toContain("deterministic templates")
    expect(problems((c) => (c.open = c.open.map((row) => ({ ...row, vars: { a: ["x"], b: ["y"] } }))))).toContain("fill out to")
  })

  test("a placeholder with no values, or values with no placeholder, is refused", () => {
    expect(problems((c) => (c.open[0]!.template = "Now with {c}."))).toContain("{c} has no values")
    expect(problems((c) => (c.open[0]!.vars.extra = ["x"]))).toContain("extra is not in the template")
  })

  test("a repeated id is refused", () => {
    expect(problems((c) => (c.open[1]!.id = c.open[0]!.id))).toContain("used twice")
  })

  test("a prompt that names itself is refused", () => {
    expect(problems((c) => (c.systems[0] = "This is a canary."))).toContain("names what it is")
  })

  test("anything that looks like customer data is refused", () => {
    expect(problems((c) => (c.open[0]!.vars.a![0] = "write to pat@example.com"))).toContain("customer data")
  })
})

describe("tools/validate-corpus.ts", () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", "run", "tools/validate-corpus.ts", ...args], { cwd: root, env: process.env })

  test("passes a good file and prints none of its prompts", () => {
    inFolder(operatorCorpus(), (path) => {
      const done = run(path)
      expect(done.exitCode).toBe(0)
      expect(done.stdout.toString()).toContain('"ok": true')
      expect(done.stdout.toString()).not.toContain("alpha")
    })
  })

  test("fails the sample, and a file that is not a corpus", () => {
    expect(run(SAMPLE_CORPUS_PATH).exitCode).toBe(1)
    inFolder({ open: [] }, (path) => expect(run(path).exitCode).toBe(1))
    expect(run("/no/such/file").exitCode).toBe(1)
  })

  test("asks for a file when given none", () => {
    expect(run().exitCode).toBe(2)
  })
})
