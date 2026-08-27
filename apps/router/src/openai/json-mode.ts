export function assertJsonOutput(text: string, responseFormat: { type?: string } | undefined, finish: string | undefined): string | null {
  if (!responseFormat || finish === "length") return null
  if (responseFormat.type !== "json_object" && responseFormat.type !== "json_schema") return null
  try {
    JSON.parse(text)
    return null
  } catch {
    return "JSON mode output did not parse"
  }
}
