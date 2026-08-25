import { recoverPersonal, recoverTyped, type Hex } from "@offpeak/shared"
import { createPublicClient, encodeFunctionData, hashMessage, hashTypedData, http, parseAbi } from "viem"
import type { Stack } from "../context.ts"

export const WALLET_CHECK_MS = 250
const CODE_TTL_MS = 5 * 60_000
const CODE_CACHE_MAX = 50_000
const EIP1271_MAGIC = "0x1626ba7e00000000000000000000000000000000000000000000000000000000"
const WALLET_CALL_GAS = 500_000n
const eip1271Abi = parseAbi(["function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)"])

/** `eoa` needed no network. `contract` is a wallet's answer at this moment, which it can change later. */
export type SigVerdict = "eoa" | "contract" | "bad" | "unavailable"

/** What a contract wallet's signature needs from the chain. */
export type WalletChain = {
  hasCode(address: Hex): Promise<boolean>
  isValidSignature(address: Hex, digest: Hex, signature: Hex): Promise<boolean>
}

export function rpcWallets(url: string): WalletChain {
  const client = createPublicClient({ transport: http(url, { timeout: WALLET_CHECK_MS, retryCount: 0 }) })
  return {
    hasCode: async (address) => ((await client.getCode({ address })) ?? "0x") !== "0x",
    isValidSignature: async (address, digest, signature) => {
      const data = encodeFunctionData({ abi: eip1271Abi, functionName: "isValidSignature", args: [digest, signature] })
      const answer = await client.call({ to: address, data, gas: WALLET_CALL_GAS }).catch((err: Error) => {
        // A wallet that reverts has answered no. A failed call has not answered at all.
        if (/revert/i.test(err.message)) return null
        throw err
      })
      return answer?.data === EIP1271_MAGIC
    },
  }
}

const codeCaches = new WeakMap<Stack, Map<string, { code: boolean; at: number }>>()

function withinLimit<T>(work: Promise<T>): Promise<T> {
  let timer: Timer
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("wallet check timed out")), WALLET_CHECK_MS)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

/** A mismatch on an EOA costs one code read per address per five minutes, not one per bad signature. */
async function hasCode(stack: Stack, wallets: WalletChain, address: Hex) {
  const cache = codeCaches.get(stack) ?? new Map<string, { code: boolean; at: number }>()
  codeCaches.set(stack, cache)
  const hit = cache.get(address)
  if (hit && performance.now() - hit.at < CODE_TTL_MS) return hit.code
  const code = await withinLimit(wallets.hasCode(address))
  if (cache.size >= CODE_CACHE_MAX) cache.clear()
  cache.set(address, { code, at: performance.now() })
  return code
}

/** Never cached: an answer that changes must be seen, and a contract's signature is not reused anyway. */
async function askWallet(stack: Stack, payer: Hex, digest: () => Hex, signature: Hex): Promise<SigVerdict> {
  const wallets = stack.wallets
  if (!wallets) return "bad"
  try {
    if (!(await hasCode(stack, wallets, payer))) return "bad"
    return (await withinLimit(wallets.isValidSignature(payer, digest(), signature))) ? "contract" : "bad"
  } catch {
    return "unavailable"
  }
}

export async function verifyTyped(stack: Stack, payer: string, typed: Parameters<typeof hashTypedData>[0], signature: Hex): Promise<SigVerdict> {
  const signer = await recoverTyped(typed, signature).catch(() => null)
  if (signer?.toLowerCase() === payer.toLowerCase()) return "eoa"
  return askWallet(stack, payer.toLowerCase() as Hex, () => hashTypedData(typed), signature)
}

export async function verifyPersonal(stack: Stack, payer: string, message: string, signature: Hex): Promise<SigVerdict> {
  const signer = await recoverPersonal(message, signature).catch(() => null)
  if (signer?.toLowerCase() === payer.toLowerCase()) return "eoa"
  return askWallet(stack, payer.toLowerCase() as Hex, () => hashMessage(message), signature)
}
