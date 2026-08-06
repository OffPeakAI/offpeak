import { Template } from "@huggingface/jinja"
import { Tokenizer } from "@huggingface/tokenizers"

export type TokenizerSpec = {
  addedTokens: { id: number; content: string }[]
}

export type ChatPart = { type: "text"; text: string }

export type ChatMessage = { role: string; content?: string | ChatPart[] | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }

export type ChatBody = { messages?: ChatMessage[]; tools?: unknown }

/** A model's real tokenizer, or the byte-level one the mock engine and its fixtures run on. */
export type TokenCounter = TokenizerSpec | ModelTokenizer

type TemplateInput = Record<string, unknown>

const contentText = (content: ChatMessage["content"]) => (Array.isArray(content) ? content.map((part) => part.text).join("") : (content ?? ""))

const BOS = "<bos>"
const EOS = "<eos>"

export function renderChat(messages: ChatMessage[], tools?: unknown): string {
  const parts: string[] = []
  if (tools) parts.push(`<tool>${JSON.stringify(tools)}`)
  for (const message of messages) {
    const role = message.role === "system" ? "<system>" : message.role === "assistant" ? "<assistant>" : "<user>"
    parts.push(`${BOS}${role}\n${contentText(message.content)}${EOS}`)
  }
  parts.push(`${BOS}<assistant>\n`)
  return parts.join("")
}

const specialText = (token: unknown) => (typeof token === "string" ? token : (token as { content?: string } | null)?.content)

/** Tool call arguments reach a template as objects. vLLM turns anything else into an empty one. */
function toolArguments(raw: unknown): unknown {
  if (!raw) return {}
  if (typeof raw !== "string") return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toolCallForTemplate(call: unknown) {
  const row = call as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
  return { id: row.id, type: row.type ?? "function", function: { name: row.function?.name, arguments: toolArguments(row.function?.arguments) } }
}

/** The fields vLLM's tool model keeps, in its order, with its nulls. Templates print this object as JSON. */
function toolForTemplate(tool: unknown) {
  const fn = (tool as { function?: Record<string, unknown> }).function ?? {}
  const kept: TemplateInput = { name: fn.name, description: fn.description ?? null, parameters: fn.parameters ?? null }
  if (fn.strict !== undefined && fn.strict !== null) kept.strict = fn.strict
  return { type: "function", function: kept }
}

export type ModelTokenizerFiles = {
  tokenizerJson: object
  tokenizerConfig: Record<string, unknown>
  /** The template text when the model ships it as its own file. */
  chatTemplate?: string
  contentFormat?: "string" | "openai"
}

type AstNode = { type?: string; value?: unknown; property?: AstNode; iterable?: AstNode; assignee?: AstNode; lhs?: AstNode; operand?: AstNode }

/** `message.content`, `message["content"]`, a filter or `if` on one, or a name that was set from one. */
function namesContent(node: AstNode | undefined, aliases: ReadonlySet<string>): boolean {
  if (!node) return false
  if (node.type === "Identifier") return aliases.has(String(node.value))
  if (node.type === "SelectExpression") return namesContent(node.lhs, aliases)
  if (node.type === "FilterExpression") return namesContent(node.operand, aliases)
  return node.type === "MemberExpression" && node.property?.value === "content"
}

/** Walks a template in reading order, so a `set` is seen before the loop that uses it. */
function loopsOverContent(node: unknown, aliases: Set<string>): boolean {
  if (Array.isArray(node)) return node.some((child) => loopsOverContent(child, aliases))
  if (node === null || typeof node !== "object") return false
  const row = node as AstNode
  if (row.type === "Set" && row.assignee?.type === "Identifier" && namesContent(row.value as AstNode | undefined, aliases)) aliases.add(String(row.assignee.value))
  if (row.type === "For" && namesContent(row.iterable, aliases)) return true
  return Object.values(row).some((child) => loopsOverContent(child, aliases))
}

/**
 * What vLLM's own detection decides: a template that loops over a message's content takes OpenAI
 * parts, and any other takes one string. The two count differently, so nothing outside the pinned
 * template may choose: `contentFormat` sits outside the model digest, where a router could flip it.
 */
export function detectContentFormat(template: Template): "string" | "openai" {
  return loopsOverContent(template.parsed, new Set()) ? "openai" : "string"
}

/** One model's public tokenizer and chat template. The router and the host agent both count with this class. */
export class ModelTokenizer {
  private readonly tokenizer: Tokenizer
  private readonly template: Template | null
  private readonly toolTemplate: Template | null
  private readonly specials: TemplateInput
  private readonly contentFormat: "string" | "openai"

  constructor(files: ModelTokenizerFiles) {
    this.tokenizer = new Tokenizer(files.tokenizerJson, files.tokenizerConfig)
    const stored = files.chatTemplate ?? files.tokenizerConfig.chat_template
    const named = Array.isArray(stored) ? (stored as { name: string; template: string }[]) : []
    const plain = typeof stored === "string" ? stored : named.find((row) => row.name === "default")?.template
    const forTools = named.find((row) => row.name === "tool_use")?.template ?? plain
    this.template = plain ? new Template(plain) : null
    this.toolTemplate = forTools ? new Template(forTools) : null
    this.contentFormat = this.template ? detectContentFormat(this.template) : "string"
    if (files.contentFormat && this.template && files.contentFormat !== this.contentFormat) throw new Error(`manifest says ${files.contentFormat} content, but the pinned template takes ${this.contentFormat}`)
    this.specials = {}
    for (const name of ["bos_token", "eos_token", "unk_token", "pad_token", "sep_token", "cls_token", "mask_token"]) {
      const text = specialText(files.tokenizerConfig[name])
      if (text) this.specials[name] = text
    }
    const extra = files.tokenizerConfig.additional_special_tokens
    if (Array.isArray(extra)) this.specials.additional_special_tokens = extra.map(specialText)
  }

  /** Same reading of a message as vLLM's: text parts join with a newline, a null content is empty. */
  private message(message: ChatMessage): TemplateInput {
    const raw = message.content
    const parts = raw === null || raw === undefined ? [] : typeof raw === "string" ? [{ type: "text", text: raw }] : raw
    const text = parts.map((part) => part.text).join("\n")
    const out: TemplateInput = { role: message.role, content: this.contentFormat === "openai" && message.role !== "tool" ? parts : text }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) out.tool_calls = message.tool_calls.map(toolCallForTemplate)
    if (message.role === "tool" && message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id
    if (typeof message.name === "string") out.name = message.name
    return out
  }

  private apply(messages: ChatMessage[], tools: unknown[] | null, addGenerationPrompt: boolean): string {
    const template = tools && tools.length > 0 ? this.toolTemplate : this.template
    if (!template) throw new Error("this model has no chat template")
    return template.render({
      ...this.specials,
      messages: messages.map((message) => this.message(message)),
      tools: tools?.map(toolForTemplate),
      add_generation_prompt: addGenerationPrompt,
    })
  }

  /** The prompt exactly as vLLM renders it for this request, generation prompt included. */
  render(body: ChatBody): string {
    return this.apply(body.messages ?? [], Array.isArray(body.tools) ? body.tools : null, true)
  }

  /** Token ids of text that already holds its special tokens. Matches `add_special_tokens=False`. */
  encode(text: string): number[] {
    return this.tokenizer.encode(text, { add_special_tokens: false }).ids
  }

  decodeToken(id: number): string {
    return this.tokenizer.decode([id], { skip_special_tokens: false })
  }

  countText(text: string): number {
    return this.encode(text).length
  }

  countChat(body: ChatBody): number {
    return this.countText(this.render(body))
  }

  /** The assistant turn a tool call came from, as this model's template writes one. */
  private toolTurn(text: string, toolCalls: unknown[]): string | null {
    try {
      const question: ChatMessage[] = [{ role: "user", content: "x" }]
      const prefix = this.apply(question, null, true)
      const full = this.apply([...question, { role: "assistant", content: text, tool_calls: toolCalls }], null, false)
      return full.startsWith(prefix) ? full.slice(prefix.length).trimEnd() : null
    } catch {
      return null
    }
  }

  /**
   * vLLM's `completion_tokens` holds the end token when the model stopped on its own, though the text does not.
   * A tool turn from the template already ends in it.
   */
  countOutput(text: string, toolCalls?: unknown[] | null, finish?: string | null): number {
    const ended = finish === "stop" || finish === "tool_calls" ? 1 : 0
    if (!toolCalls || toolCalls.length === 0) return this.countText(text) + ended
    const turn = this.toolTurn(text, toolCalls)
    return turn === null ? this.countText(`${text}${JSON.stringify(toolCalls)}`) + ended : this.countText(turn)
  }

  /** vLLM's embeddings path keeps `add_special_tokens` on, input by input. */
  countInputs(inputs: string[]): number {
    return inputs.reduce((sum, input) => sum + this.tokenizer.encode(input).ids.length, 0)
  }
}

function countBytes(spec: TokenizerSpec, text: string): number {
  let rest = text
  let count = 0
  const specials = [...spec.addedTokens].sort((a, b) => b.content.length - a.content.length)
  while (rest.length > 0) {
    const hit = specials.find((token) => rest.startsWith(token.content))
    if (hit) {
      count += 1
      rest = rest.slice(hit.content.length)
      continue
    }
    const cp = rest.codePointAt(0)!
    const chars = cp > 0xffff ? 2 : 1
    count += new TextEncoder().encode(rest.slice(0, chars)).length
    rest = rest.slice(chars)
  }
  return count
}

/** Builds a model's tokenizer from its pinned files. `read` answers with a file's text, or `null` when the model has none. */
export function modelTokenizerFrom(read: (path: string) => string | null, contentFormat?: ModelTokenizerFiles["contentFormat"]) {
  const config = read("tokenizer_config.json")
  return new ModelTokenizer({
    tokenizerJson: JSON.parse(read("tokenizer.json") ?? "null"),
    tokenizerConfig: config ? JSON.parse(config) : {},
    chatTemplate: read("chat_template.jinja") ?? undefined,
    contentFormat,
  })
}

/** With a `TokenizerSpec`, byte-level counts plus one token per known special string. Matches the mock engine. */
export function countText(spec: TokenCounter, text: string): number {
  return spec instanceof ModelTokenizer ? spec.countText(text) : countBytes(spec, text)
}

export function countChat(spec: TokenCounter, messages: ChatMessage[], tools?: unknown): number {
  if (spec instanceof ModelTokenizer) return spec.countChat({ messages, tools })
  return countBytes(spec, renderChat(messages, tools))
}

export function countOutput(spec: TokenCounter, text: string, toolCalls?: unknown[] | null, finish?: string | null): number {
  if (spec instanceof ModelTokenizer) return spec.countOutput(text, toolCalls, finish)
  const extra = toolCalls && toolCalls.length > 0 ? `\u0000${JSON.stringify(toolCalls)}` : ""
  return countBytes(spec, `${text}${extra}`)
}

export function countInputs(spec: TokenCounter, inputs: string[]): number {
  if (spec instanceof ModelTokenizer) return spec.countInputs(inputs)
  return inputs.reduce((sum, input) => sum + countBytes(spec, input), 0)
}

export const LAUNCH_TOKENIZER: TokenizerSpec = {
  addedTokens: [
    { id: 256, content: "<bos>" },
    { id: 257, content: "<eos>" },
    { id: 258, content: "<user>" },
    { id: 259, content: "<assistant>" },
    { id: 260, content: "<system>" },
    { id: 261, content: "<tool>" },
  ],
}
