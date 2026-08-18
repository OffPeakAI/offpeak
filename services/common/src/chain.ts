import { readFileSync } from "node:fs"
import { createPublicClient, createWalletClient, http, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem"

export type Deployment = { contracts: Record<string, Address> }

const ZERO_ADDRESS = `0x${"00".repeat(20)}`

/** Contracts from later phases sit at zero in the file. Services see only what is deployed. */
export function readDeployment(path: string): Deployment {
  const { contracts } = JSON.parse(readFileSync(path, "utf8")) as Deployment
  return { contracts: Object.fromEntries(Object.entries(contracts).filter(([, address]) => address !== ZERO_ADDRESS)) }
}

function offpeakChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: "offpeak",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
}

export function makeClients(opts: { rpcUrl: string; chainId: number; account?: Account }): {
  reader: PublicClient
  writer: WalletClient | undefined
} {
  const chain = offpeakChain(opts.chainId, opts.rpcUrl)
  const transport = http(opts.rpcUrl, { retryCount: 3, retryDelay: 200, timeout: 10_000 })
  return {
    reader: createPublicClient({ chain, transport }) as PublicClient,
    writer: opts.account ? createWalletClient({ chain, transport, account: opts.account }) : undefined,
  }
}

/** The first block at or after `ts`, or null while the chain has not reached it. */
export async function firstBlockAtOrAfter(reader: PublicClient, ts: number): Promise<bigint | null> {
  const head = await reader.getBlock({ blockTag: "latest" })
  if (head.timestamp < BigInt(ts)) return null
  let low = 0n
  let high = head.number
  while (low < high) {
    const middle = (low + high) / 2n
    const block = await reader.getBlock({ blockNumber: middle })
    if (block.timestamp < BigInt(ts)) low = middle + 1n
    else high = middle
  }
  return low
}
