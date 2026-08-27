export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }

export function toolCallsFrom(message: { tool_calls?: ToolCall[] } | undefined): ToolCall[] | undefined {
  const calls = message?.tool_calls
  return calls && calls.length > 0 ? calls : undefined
}

export function wantsTools(body: { tools?: unknown }): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0
}
