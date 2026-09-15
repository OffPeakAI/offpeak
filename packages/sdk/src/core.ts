import { localDeployment, mainnetDeployment } from "@offpeak/abis"
import { CHAIN_ID, PERMIT2, type UsageEnvelope } from "@offpeak/shared"
import { createPublicClient, createWalletClient, http, publicActions, zeroAddress, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import type { VerifyOptions, VerifyReport } from "./verify.ts"

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Address)
export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex)
export const hexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/)
  .transform((value) => value as Hex)
export const digitsSchema = z.string().regex(/^\d+$/)

export class OffpeakError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "OffpeakError"
  }
}

const errorBody = z.object({ error: z.looseObject({ message: z.string().optional(), code: z.string().optional() }) })

/** Reads an OpenAI-shaped error. A body that is not one still gives a usable error. */
export async function errorFrom(res: Response): Promise<OffpeakError> {
  const raw = await res
    .clone()
    .json()
    .catch(() => null)
  const parsed = errorBody.safeParse(raw)
  if (!parsed.success) return new OffpeakError("http_error", `Router answered ${res.status}`, res.status)
  const { message, code, ...detail } = parsed.data.error
  const accepts = (raw as { accepts?: unknown }).accepts
  return new OffpeakError(code ?? "http_error", message ?? `Router answered ${res.status}`, res.status, accepts ? { ...detail, accepts } : detail)
}

/** Whole seconds, UTC. */
export const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Micro USDG as a decimal USD string, built without floats. */
export function microToUsd(micro: bigint): string {
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`
}

/** A decimal USD string as micro USDG, built without floats. */
export function usdToMicro(usd: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim())
  if (!match) throw new OffpeakError("bad_price", "Prices are decimal USD with up to 6 places")
  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"))
}

export type Deployment = { contracts: Record<string, string>; roles?: { router?: string } }

export type ContractName = "UsageLedger" | "ChannelManager" | "OffpeakVault" | "X402Escrow" | "USDG" | "Permit2" | "HostRegistry"

const DEPLOYMENTS: Record<"local" | "4663", Deployment> = { local: localDeployment, "4663": mainnetDeployment }

/** Addresses signatures bind to. Nothing is signed against an address that is not published. */
export class AddressBook {
  private deployment: Deployment

  constructor(
    deployment: "local" | "4663" | Deployment = "4663",
    private router?: string,
  ) {
    this.deployment = typeof deployment === "string" ? DEPLOYMENTS[deployment] : deployment
  }

  contract(name: ContractName): Address {
    const { contracts } = this.deployment
    const value = name === "USDG" ? (contracts.USDG ?? contracts.MockUSDG) : name === "Permit2" ? (contracts.Permit2 ?? PERMIT2) : contracts[name]
    return this.published(name, value)
  }

  routerSigner(): Address {
    return this.published("the router signer", this.router ?? this.deployment.roles?.router)
  }

  private published(name: string, value: string | undefined): Address {
    if (!value || value === zeroAddress) throw new OffpeakError("not_deployed", `No published address for ${name}. Pass a deployment that has one.`)
    return value.toLowerCase() as Address
  }
}

export type WalletLike = WalletClient | LocalAccount

/** The two signing calls this SDK needs. Keys stay wherever the wallet keeps them. */
export type Signer = {
  address: Address
  signMessage(args: { message: string }): Promise<Hex>
  signTypedData(args: { domain: unknown; types: unknown; primaryType: string; message: unknown }): Promise<Hex>
}

export function toSigner(wallet: WalletLike): Signer {
  if ("address" in wallet) {
    return {
      address: wallet.address.toLowerCase() as Address,
      signMessage: ({ message }) => wallet.signMessage({ message }),
      signTypedData: (args) => wallet.signTypedData(args as never),
    }
  }
  const account = wallet.account
  if (!account) throw new OffpeakError("no_wallet", "The wallet client has no account")
  return {
    address: account.address.toLowerCase() as Address,
    signMessage: ({ message }) => wallet.signMessage({ account, message }),
    signTypedData: (args) => wallet.signTypedData({ account, ...(args as object) } as never),
  }
}

/** A signing-only wallet from a raw key. The key stays inside this process. */
export function localWallet(privateKey: Hex): LocalAccount {
  return privateKeyToAccount(privateKey)
}

export type ChainAccess = {
  reader: () => PublicClient | null
  writer: () => WalletClient | null
}

export function chainAccess(wallet: WalletLike | undefined, rpcUrl: string | undefined, publicClient: PublicClient | undefined): ChainAccess {
  const client = wallet && !("address" in wallet) ? wallet : null
  return {
    reader: () => publicClient ?? (rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : client ? (client.extend(publicActions) as unknown as PublicClient) : null),
    writer: () => client ?? (rpcUrl && wallet ? createWalletClient({ account: wallet as LocalAccount, transport: http(rpcUrl) }) : null),
  }
}

export async function assertChain(client: WalletClient) {
  const id = await client.getChainId()
  if (id !== CHAIN_ID) throw new OffpeakError("wrong_chain", `Wallet is on chain ${id}, expected ${CHAIN_ID}`)
}

/** What the payment helpers need from the client. */
export type ClientContext = {
  baseURL: string
  fetch: typeof fetch
  signer: Signer | null
  book: AddressBook
  chain: ChainAccess
  verify: (env: UsageEnvelope, opts?: VerifyOptions) => Promise<VerifyReport>
}
