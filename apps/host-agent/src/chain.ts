import { readFileSync } from "node:fs"
import { hostRegistryAbi, usageLedgerAbi } from "@offpeak/abis"
import { CHAIN_ID } from "@offpeak/shared"
import { createPublicClient, createWalletClient, http, type Hex, type PrivateKeyAccount } from "viem"
import { z } from "zod"

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value as Hex)

const deploymentSchema = z.object({ contracts: z.looseObject({ HostRegistry: address, UsageLedger: address }) })

export type Deployment = { HostRegistry: Hex; UsageLedger: Hex }

export function readDeployment(path: string): Deployment {
  const { contracts } = deploymentSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  if (/^0x0+$/.test(contracts.HostRegistry) || /^0x0+$/.test(contracts.UsageLedger)) throw new Error("deployment file has no contract addresses")
  return { HostRegistry: contracts.HostRegistry, UsageLedger: contracts.UsageLedger }
}

export type Registration = {
  status: number
  imageDigest: Hex
  gpuClass: Hex
  models: Hex[]
  bondUsdg: bigint
  bondOfpk: bigint
  releasableCredits: bigint
  pendingCredits: bigint
}

/** What the agent reads from the chain. */
export type HostChain = {
  chainId(): Promise<number>
  routerSigner(): Promise<Hex>
  registration(operator: Hex): Promise<Registration>
  bondTokens(): Promise<{ usdg: Hex; ofpk: Hex }>
}

export function hostChain(rpcUrl: string, deployment: Deployment): HostChain {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const registry = { address: deployment.HostRegistry, abi: hostRegistryAbi }
  return {
    chainId: () => client.getChainId(),
    routerSigner: () => client.readContract({ address: deployment.UsageLedger, abi: usageLedgerAbi, functionName: "routerSigner" }) as Promise<Hex>,
    registration: async (operator) => {
      const [view, models] = await Promise.all([
        client.readContract({ ...registry, functionName: "hostView", args: [operator] }),
        client.readContract({ ...registry, functionName: "modelsOf", args: [operator] }),
      ])
      return { ...view, imageDigest: view.imageDigest as Hex, gpuClass: view.gpuClass as Hex, models: [...models] as Hex[] }
    },
    bondTokens: async () => {
      const [usdg, ofpk] = await Promise.all([client.readContract({ ...registry, functionName: "usdg" }), client.readContract({ ...registry, functionName: "ofpk" })])
      return { usdg: usdg as Hex, ofpk: ofpk as Hex }
    },
  }
}

export type TxCall = { to: Hex; data: Hex }

/** Sends the operator's own transactions, one after the other, waiting for each to land. */
export async function sendCalls(rpcUrl: string, account: PrivateKeyAccount, calls: TxCall[]): Promise<Hex[]> {
  const chain = { id: CHAIN_ID, name: "offpeak", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const hashes: Hex[] = []
  for (const call of calls) {
    const hash = await wallet.sendTransaction(call)
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`transaction failed: ${hash}`)
    hashes.push(hash)
  }
  return hashes
}
