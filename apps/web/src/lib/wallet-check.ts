import { decodeFunctionData, erc20Abi, type Abi, type Hex } from "viem"
import { AuditCourtAbi, ChannelManagerAbi, HostRegistryAbi, OffpeakVaultAbi, WindowMarketAbi, localDeployment, mainnetDeployment } from "../../../../packages/abis/src/index.ts"
import { CHAIN_ID } from "./shared.ts"
import type { Approval, Network, PermitPlan, Tx } from "./types.ts"

/**
 * The addresses this build was shipped with. The router writes the calldata a wallet signs, so
 * nothing it sends can be the thing that says where money may go.
 */
export type Book = { vault: Hex; usdg: Hex; permit2: Hex; registry: Hex; usageLedger: Hex; channelManager: Hex; windowMarket: Hex; auditCourt: Hex; routerSigner: Hex | null }

type Deployment = { contracts: Record<string, string>; roles?: Record<string, string> }

const lower = (address: string | undefined) => (address ?? `0x${"00".repeat(20)}`).toLowerCase() as Hex

export function bookOf({ contracts, roles }: Deployment): Book {
  return {
    vault: lower(contracts.OffpeakVault),
    usdg: lower(contracts.USDG ?? contracts.MockUSDG),
    permit2: lower(contracts.Permit2),
    registry: lower(contracts.HostRegistry),
    usageLedger: lower(contracts.UsageLedger),
    channelManager: lower(contracts.ChannelManager),
    windowMarket: lower(contracts.WindowMarket),
    auditCourt: lower(contracts.AuditCourt),
    routerSigner: roles?.router ? lower(roles.router) : null,
  }
}

const NETWORK = (import.meta.env?.VITE_OFFPEAK_DEPLOYMENT as string | undefined) ?? "4663"

/** Set `VITE_OFFPEAK_DEPLOYMENT=local` for a local stack. Anything else pins the published mainnet file. */
export const deployedBook = bookOf(NETWORK === "local" ? localDeployment : mainnetDeployment)

const PINNED = ["vault", "usdg", "permit2", "registry", "usageLedger", "channelManager", "windowMarket"] as const

/** Addresses from the router's view stand in for nothing: the view keeps only what the build agrees with. */
export function pinNetwork(view: Network, book: Book = deployedBook): Network & { mismatch: string | null } {
  const differs = PINNED.filter((name) => view[name].toLowerCase() !== book[name])
  const pinned = Object.fromEntries(PINNED.map((name) => [name, book[name]]))
  const signerDiffers = book.routerSigner !== null && view.routerSigner.toLowerCase() !== book.routerSigner
  return {
    ...view,
    ...pinned,
    routerSigner: book.routerSigner ?? view.routerSigner,
    mismatch: differs.length > 0 || signerDiffers ? [...differs, ...(signerDiffers ? ["routerSigner"] : [])].join(", ") : null,
  }
}

type Target = { abi: Abi; calls: readonly string[] }

const zero = /^0x0{40}$/

/** The calls this app ever makes, by contract. Anything else from the router is refused. */
function targets(book: Book) {
  const rows: [Hex, Target][] = [
    [book.vault, { abi: OffpeakVaultAbi as Abi, calls: ["deposit", "depositWithPermit2", "withdraw", "setCaps", "requestWithdrawAll", "cancelWithdrawAll", "executeWithdrawAll"] }],
    [book.usdg, { abi: erc20Abi as Abi, calls: ["approve"] }],
    [book.channelManager, { abi: ChannelManagerAbi as Abi, calls: ["open", "topUp", "requestClose", "finalizeClose", "cooperativeClose"] }],
    [book.windowMarket, { abi: WindowMarketAbi as Abi, calls: ["buy", "cancel", "list", "delist", "buyListing", "claimFailure", "claimExpired"] }],
    [book.registry, { abi: HostRegistryAbi as Abi, calls: ["register", "activate", "withdrawCredits"] }],
    [book.auditCourt, { abi: AuditCourtAbi as Abi, calls: ["respond"] }],
  ]
  return new Map(rows.filter(([address]) => !zero.test(address)))
}

export type Want = { fn: string; args?: readonly unknown[] }

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()

/** What is wrong with a transaction the router wrote, or null when it is what the page asked for. */
export function txProblem(tx: Tx, book: Book, want?: Want): string | null {
  const target = targets(book).get(tx.to.toLowerCase() as Hex)
  if (!target) return "The router named a contract this site does not know, so nothing was sent."
  if (tx.chainId !== CHAIN_ID) return "The router named another chain, so nothing was sent."
  if (tx.value !== "0") return "The router asked to send value with this call, so nothing was sent."
  let call: { functionName: string; args?: readonly unknown[] }
  try {
    call = decodeFunctionData({ abi: target.abi, data: tx.data })
  } catch {
    return "The router's calldata cannot be read, so nothing was sent."
  }
  if (!target.calls.includes(call.functionName)) return `The router asked for ${call.functionName}, which this site never sends.`
  if (call.functionName === "approve" && !approvedSpender(call.args?.[0], book)) return "The router asked to approve an address this site does not know, so nothing was sent."
  if (!want) return null
  if (call.functionName !== want.fn) return `The router wrote ${call.functionName} where you asked for ${want.fn}, so nothing was sent.`
  const args = want.args ?? []
  const matches = args.every((value, index) => value === undefined || same(call.args?.[index], value))
  return matches ? null : "The router's calldata does not match what you asked for, so nothing was sent."
}

const approvedSpender = (spender: unknown, book: Book) => [book.vault, book.permit2, book.channelManager, book.windowMarket, book.registry].some((address) => same(address, spender))

/** The approve step of a plan: this token, a known spender, and calldata that says the same as the plan. */
export function approvalProblem(approval: Approval, book: Book, want: { spender?: Hex; amount?: bigint } = {}): string | null {
  if (approval.token.toLowerCase() !== book.usdg) return "The router named another token, so nothing was sent."
  if (want.spender && approval.spender.toLowerCase() !== want.spender.toLowerCase()) return "The router named another spender, so nothing was sent."
  if (want.amount !== undefined && BigInt(approval.amount) !== want.amount) return "The router asked to approve a different amount, so nothing was sent."
  return txProblem(approval.tx, book, { fn: "approve", args: [approval.spender, approval.amount] })
}

/** Written here, not taken from the router, so what the wallet signs has the meaning this page expects. */
export const permitTypes = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const

const PERMIT_MAX_TTL_S = 3_600

/** A Permit2 signature moves tokens with no further approval, so every field is checked before the wallet sees it. */
export function permitProblem(permit: NonNullable<PermitPlan["permit"]>, book: Book, amount: bigint, now: number): string | null {
  const { domain, message, primaryType } = permit
  const fits =
    primaryType === "PermitTransferFrom" &&
    domain.name === "Permit2" &&
    domain.chainId === CHAIN_ID &&
    domain.verifyingContract.toLowerCase() === book.permit2 &&
    message.spender.toLowerCase() === book.vault &&
    message.permitted.token.toLowerCase() === book.usdg &&
    BigInt(message.permitted.amount) === amount &&
    BigInt(message.deadline) <= BigInt(now + PERMIT_MAX_TTL_S)
  return fits ? null : "The router's Permit2 message is not the deposit you asked for, so nothing was signed."
}

export type CloseReply = { to: Hex; data: Hex; value?: unknown; chainId: number; routerSig: Hex }

/** The wallet is about to send what the router wrote, so it must be exactly the close the buyer signed. */
export function closeCallError(reply: CloseReply, book: Book, close: { id: Hex; finalCumulative: bigint; deadline: bigint; payerSig: Hex }): string | null {
  if (reply.to.toLowerCase() !== book.channelManager) return "The router named another contract, so nothing was sent."
  if (reply.chainId !== CHAIN_ID) return "The router named another chain, so nothing was sent."
  let call: ReturnType<typeof decodeFunctionData<typeof ChannelManagerAbi>>
  try {
    call = decodeFunctionData({ abi: ChannelManagerAbi, data: reply.data })
  } catch {
    return "The router's calldata cannot be read, so nothing was sent."
  }
  if (call.functionName !== "cooperativeClose") return "The router's calldata is not a close, so nothing was sent."
  const [channelId, terms, sentSig, routerSig] = call.args
  const id = close.id.toLowerCase()
  const matches = channelId.toLowerCase() === id && terms.channelId.toLowerCase() === id && terms.finalCumulative === close.finalCumulative && terms.deadline === close.deadline
  if (!matches || sentSig.toLowerCase() !== close.payerSig.toLowerCase() || routerSig.toLowerCase() !== reply.routerSig.toLowerCase()) return "The router's calldata does not match the close you signed, so nothing was sent."
  return null
}

/** A channel's final amount, which comes from the router, can never pass its deposit. */
export function finalAmountProblem(finalCumulative: bigint, deposit: bigint) {
  return finalCumulative > deposit ? "The router's total is above this channel's deposit, so nothing was signed." : null
}
