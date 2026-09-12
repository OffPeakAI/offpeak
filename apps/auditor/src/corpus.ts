import { existsSync, readFileSync } from "node:fs"
import { z } from "zod"

const entrySchema = z.object({ id: z.string().min(1), template: z.string().min(1), vars: z.record(z.string(), z.array(z.string()).min(1)) })

/** Self-written prompts only, never customer data. */
export const corpusSchema = z.object({
  leads: z.array(z.string()).min(1),
  tails: z.array(z.string()).min(1),
  systems: z.array(z.string()).min(1),
  history: z.array(z.tuple([z.string(), z.string()])).min(1),
  open: z.array(entrySchema).min(1),
  deterministic: z.array(entrySchema).min(1),
  tools: z.array(z.record(z.string(), z.unknown())).min(1),
})

export type Corpus = z.infer<typeof corpusSchema>
export type CorpusEntry = z.infer<typeof entrySchema>

/**
 * This file is public, and hosts build from this repo, so a host holds every line of it. It exists
 * for tests. Anything sent to a real host comes from the operator's own file, and a corpus that
 * shares a template with this one is refused.
 */
export const SAMPLE_CORPUS_PATH = new URL("./corpus/sample.json", import.meta.url).pathname

/** A host sees each prompt it serves, so a small pool soon becomes a list of canaries. */
export const MIN_OPEN_TEMPLATES = 40
export const MIN_OPEN_VARIETY = 10_000
export const MIN_DETERMINISTIC_TEMPLATES = 20
export const MIN_DETERMINISTIC_VARIETY = 500

const GIVEAWAY = /canary|audit|offpeak|test prompt/i
const CUSTOMER_DATA = /[\w.+-]+@[\w-]+\.[\w.]+|\bsk-[A-Za-z0-9]{16,}|\b0x[0-9a-fA-F]{40}\b/

const placeholders = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")

/** How many different prompts one template can fill out to. */
function variety(entry: CorpusEntry) {
  return [...new Set(placeholders(entry.template))].reduce((product, name) => product * (entry.vars[name]?.length ?? 0), 1)
}

const sum = (entries: readonly CorpusEntry[]) => entries.reduce((total, entry) => total + variety(entry), 0)

export const corpusFigures = (corpus: Corpus) => ({ open: corpus.open.length, openVariety: sum(corpus.open), deterministic: corpus.deterministic.length, deterministicVariety: sum(corpus.deterministic) })

function shapeProblems(corpus: Corpus) {
  const problems: string[] = []
  const entries = [...corpus.open, ...corpus.deterministic]
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`${entry.id}: id is used twice`)
    seen.add(entry.id)
    const used = new Set(placeholders(entry.template))
    for (const name of used) if (!entry.vars[name]) problems.push(`${entry.id}: {${name}} has no values`)
    for (const name of Object.keys(entry.vars)) if (!used.has(name)) problems.push(`${entry.id}: ${name} is not in the template`)
  }
  const texts = [...corpus.leads, ...corpus.tails, ...corpus.systems, ...corpus.history.flat(), ...entries.flatMap((entry) => [entry.template, ...Object.values(entry.vars).flat()])]
  if (texts.some((text) => GIVEAWAY.test(text))) problems.push("a prompt names what it is, which a host could search for")
  if (texts.some((text) => CUSTOMER_DATA.test(text))) problems.push("a prompt holds an email address, key or wallet, so it may be customer data")
  return problems
}

/** Everything that stops a corpus going to real hosts. Empty means it can. */
export function corpusProblems(corpus: Corpus, published: Corpus | null) {
  const problems = shapeProblems(corpus)
  const figures = corpusFigures(corpus)
  if (figures.open < MIN_OPEN_TEMPLATES) problems.push(`needs ${MIN_OPEN_TEMPLATES} open templates, has ${figures.open}`)
  if (figures.openVariety < MIN_OPEN_VARIETY) problems.push(`open templates need to fill out to ${MIN_OPEN_VARIETY} prompts, they make ${figures.openVariety}`)
  if (figures.deterministic < MIN_DETERMINISTIC_TEMPLATES) problems.push(`needs ${MIN_DETERMINISTIC_TEMPLATES} deterministic templates, has ${figures.deterministic}`)
  if (figures.deterministicVariety < MIN_DETERMINISTIC_VARIETY) problems.push(`deterministic templates need to fill out to ${MIN_DETERMINISTIC_VARIETY} prompts, they make ${figures.deterministicVariety}`)
  if (published) {
    const known = new Set([...published.open, ...published.deterministic].map((entry) => norm(entry.template)))
    for (const entry of [...corpus.open, ...corpus.deterministic]) if (known.has(norm(entry.template))) problems.push(`${entry.id}: this template is in the public sample, so hosts already have it`)
  }
  return problems
}

export function readCorpus(path: string): Corpus {
  return corpusSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export const readPublishedSample = () => (existsSync(SAMPLE_CORPUS_PATH) ? readCorpus(SAMPLE_CORPUS_PATH) : null)

/**
 * The corpus this auditor sends. On mainnet it must come from the operator's file and pass every
 * check, or the auditor refuses to run canaries at all. Elsewhere, no file means no canaries.
 */
export function canaryCorpus(env: { OFFPEAK_ENV: string; OFFPEAK_CANARY_CORPUS_FILE?: string }): Corpus | null {
  const path = env.OFFPEAK_CANARY_CORPUS_FILE
  const mainnet = env.OFFPEAK_ENV === "mainnet"
  if (!path) {
    if (mainnet) throw new Error("mainnet needs OFFPEAK_CANARY_CORPUS_FILE: canaries from a public corpus can be spotted by any host")
    return null
  }
  const corpus = readCorpus(path)
  if (mainnet) {
    const problems = corpusProblems(corpus, readPublishedSample())
    if (problems.length > 0) throw new Error(`the canary corpus cannot go to real hosts: ${problems.join("; ")}`)
  }
  return corpus
}
