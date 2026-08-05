/** The router never lets a request ask for more output than this. */
export const MAX_OUTPUT_TOKENS = 4096

export const DEFAULT_EMBEDDINGS_MODEL = "ofm-embed"

export type BuyerBody = Record<string, unknown>

/** The output limit a buyer asked for, under either OpenAI name. */
export const askedTokens = (body: BuyerBody) => body.max_completion_tokens ?? body.max_tokens

/** The `max_tokens` a host receives. `room` is what is left of the model's context after the input. */
export function outputLimit(asked: unknown, room: number = MAX_OUTPUT_TOKENS) {
  return Math.min(typeof asked === "number" ? asked : MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, room)
}

/** A chat body exactly as the router sends it to a host. This is what `promptHash` covers. */
export function hostChatBody(body: BuyerBody, maxTokens: number): BuyerBody {
  const { max_completion_tokens: _ignored, ...forwarded } = body
  return { ...forwarded, stream: true, max_tokens: maxTokens, stream_options: { include_usage: true } }
}

export function hostEmbeddingsBody(body: BuyerBody): BuyerBody {
  const input = body.input
  return { model: body.model ?? DEFAULT_EMBEDDINGS_MODEL, input: Array.isArray(input) ? input : [input], encoding_format: body.encoding_format ?? "float" }
}

export const isEmbeddingsBody = (body: BuyerBody) => body.input !== undefined && body.messages === undefined
