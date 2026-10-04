import { readFileSync } from "node:fs"
import type { Address } from "viem"

const root = new URL("../../", import.meta.url).pathname

export type LocalChain = { rpcUrl: string; contracts: Record<string, Address>; stop: () => void }

/** Starts `chain:local` on its own port and resolves once every contract is deployed. */
export async function startLocalChain(port: number, opts?: { timestamp?: number }): Promise<LocalChain> {
  const start = opts?.timestamp ? ["--timestamp", String(opts.timestamp)] : []
  const chain = Bun.spawn(["bun", "run", "tools/chain-local.ts", "--port", String(port), ...start], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  })
  const decoder = new TextDecoder()
  let output = ""
  for await (const chunk of chain.stdout) {
    output += decoder.decode(chunk)
    if (output.includes("local chain ready")) break
  }
  if (!output.includes("local chain ready")) throw new Error(`chain did not start on port ${port}`)
  const { contracts } = JSON.parse(readFileSync(`${root}packages/abis/deployments/local.json`, "utf8"))
  return { rpcUrl: `http://127.0.0.1:${port}`, contracts, stop: () => chain.kill() }
}
