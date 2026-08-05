import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex } from "viem"
import { z } from "zod"
import { manifestSha256, modelDigestOf, outputHashOf, promptHashOf } from "./hash.ts"
import { askedTokens, hostChatBody, hostEmbeddingsBody, isEmbeddingsBody, outputLimit, type BuyerBody } from "./sent-body.ts"
import { ModelTokenizer, countChat, countInputs, countOutput, modelTokenizerFrom, type ChatMessage, type TokenCounter } from "./tokenizer.ts"
import { countsWithinTolerance } from "./tolerance.ts"

const fileRow = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })

/** A model's pinned tokenizer as the router publishes it: the manifest, and the text of the files counting needs. */
export const publishedTokenizerSchema = z.object({
  weights: z.array(fileRow),
  tokenizer: z.array(fileRow).min(1),
  chatTemplate: z.array(fileRow),
  files: z.record(z.string(), z.string()),
})

export type PublishedTokenizer = z.infer<typeof publishedTokenizerSchema>

const textEncoder = new TextEncoder()

/**
 * Builds the tokenizer from published files, trusting nothing about who sent them: the manifest must
 * hash to the record's model digest, which the host registered on chain, and every file to the manifest.
 * How content reaches the template follows from the template, so no claim about it is read from the reply.
 */
export function tokenizerFromFiles(raw: unknown, modelDigest: string): ModelTokenizer {
  const published = publishedTokenizerSchema.parse(raw)
  const digest = modelDigestOf(manifestSha256(published.weights), manifestSha256(published.tokenizer), manifestSha256(published.chatTemplate))
  if (digest.toLowerCase() !== modelDigest.toLowerCase()) throw new Error("tokenizer manifest does not match the model digest")
  const pinned = new Map([...published.tokenizer, ...published.chatTemplate].map((file) => [file.path, file.sha256]))
  const read = (path: string) => {
    const hash = pinned.get(path)
    const text = published.files[path]
    if (!hash || text === undefined) return null
    if (bytesToHex(sha256(textEncoder.encode(text))).slice(2) !== hash) throw new Error(`${path} does not match its pinned hash`)
    return text
  }
  return modelTokenizerFrom(read)
}

export type RecountOutput = { text: string; toolCalls?: unknown[]; finish?: string | null }

export type Recount = {
  /** The request body as you sent it. The body the router sent the host, with its output limit, is rebuilt from this. */
  prompt: BuyerBody
  output: string | RecountOutput
  /** The model's real tokenizer. Without one nothing is counted and the report says so, because a byte count passes a 4x overbill. */
  tokenizer?: TokenCounter
  /** The model's context. The router lowers `max_tokens` near it, so a request close to the limit needs this. */
  contextLength?: number
}

/** `countsOk` is null when nothing could be counted. That is "not checked", never a pass. */
export type RecountReport = { promptOk: boolean; outputOk: boolean; countsOk: boolean | null; tokensIn: number; tokensOut: number; tokenizer: "model" | "byte" | "none" }

type HashedCounts = { promptHash: string; outputHash: string; tokensIn: number; tokensOut: number }

/** Billing can stop short of the full output, so only a record above your own count fails. */
function notOvercounted(billed: number, local: number) {
  return billed <= local || countsWithinTolerance(billed, local)
}

export function recountRecord(record: HashedCounts, recount: Recount): RecountReport {
  const { tokenizer, prompt } = recount
  const kind = !tokenizer ? "none" : tokenizer instanceof ModelTokenizer ? "model" : "byte"
  if (isEmbeddingsBody(prompt)) {
    const sent = hostEmbeddingsBody(prompt)
    const tokensIn = tokenizer ? countInputs(tokenizer, (sent.input as unknown[]).map(String)) : 0
    return { promptOk: promptHashOf(sent) === record.promptHash, outputOk: true, countsOk: tokenizer ? notOvercounted(record.tokensIn, tokensIn) : null, tokensIn, tokensOut: 0, tokenizer: kind }
  }
  const { text, toolCalls, finish } = typeof recount.output === "string" ? ({ text: recount.output } as RecountOutput) : recount.output
  const calls = toolCalls && toolCalls.length > 0 ? toolCalls : undefined
  const tokensIn = tokenizer ? countChat(tokenizer, (prompt.messages ?? []) as ChatMessage[], prompt.tools) : 0
  const tokensOut = tokenizer ? countOutput(tokenizer, text, calls, finish) : 0
  const room = !tokenizer || recount.contextLength === undefined ? undefined : recount.contextLength - tokensIn
  return {
    promptOk: promptHashOf(hostChatBody(prompt, outputLimit(askedTokens(prompt), room))) === record.promptHash,
    outputOk: outputHashOf(text, calls ?? []) === record.outputHash,
    countsOk: tokenizer ? notOvercounted(record.tokensIn, tokensIn) && notOvercounted(record.tokensOut, tokensOut) : null,
    tokensIn,
    tokensOut,
    tokenizer: kind,
  }
}
