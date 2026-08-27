import type { Stack } from "../pipeline.ts"

export function serviceStatus(stack: Stack) {
  return { features: stack.flags, health: { router: "ok", hosts: stack.probesOk.size } }
}
