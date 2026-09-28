import { describe, expect, test } from "bun:test"
import { encodeFunctionData, erc20Abi, type Hex } from "viem"
import { ChannelManagerAbi, OffpeakVaultAbi, localDeployment, mainnetDeployment } from "../../../../packages/abis/src/index.ts"
import { CHAIN_ID } from "./shared.ts"
import type { Network, Tx } from "./types.ts"
import { approvalProblem, bookOf, closeCallError, finalAmountProblem, permitProblem, pinNetwork, txProblem } from "./wallet-check.ts"

const book = bookOf(localDeployment)
const ATTACKER = `0x${"ab".repeat(20)}` as Hex
const NOW = 1_800_000_000

const tx = (to: Hex, data: Hex, over: Partial<Tx> = {}): Tx => ({ to, data, value: "0", chainId: CHAIN_ID, ...over })
const withdraw = (amount: bigint) => encodeFunctionData({ abi: OffpeakVaultAbi, functionName: "withdraw", args: [amount] })
const approve = (spender: Hex, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] })

describe("what the router writes", () => {
  test("a call the page asked for goes through", () => {
    expect(txProblem(tx(book.vault, withdraw(5n)), book, { fn: "withdraw", args: [5n] })).toBeNull()
  })

  test("a target the deployment does not name is refused, whatever the calldata says", () => {
    expect(txProblem(tx(ATTACKER, withdraw(5n)), book, { fn: "withdraw", args: [5n] })).toContain("does not know")
  })

  test("another chain, or any value, is refused", () => {
    expect(txProblem(tx(book.vault, withdraw(5n), { chainId: 1 }), book)).toContain("another chain")
    expect(txProblem({ ...tx(book.vault, withdraw(5n)), value: "1" as never }, book)).toContain("value")
  })

  test("calldata that cannot be read is refused", () => {
    expect(txProblem(tx(book.vault, "0xdeadbeef"), book)).toContain("cannot be read")
  })

  test("a different amount from the one asked for is refused", () => {
    expect(txProblem(tx(book.vault, withdraw(6n)), book, { fn: "withdraw", args: [5n] })).toContain("does not match")
  })

  test("a different call on the right contract is refused", () => {
    const data = encodeFunctionData({ abi: OffpeakVaultAbi, functionName: "requestWithdrawAll" })
    expect(txProblem(tx(book.vault, data), book, { fn: "withdraw", args: [5n] })).toContain("where you asked")
  })

  test("a token transfer is never a call this site makes", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 5n] })
    expect(txProblem(tx(book.usdg, data), book)).toContain("never sends")
  })

  test("an approval to an unknown spender is refused, even with no intent given", () => {
    expect(txProblem(tx(book.usdg, approve(ATTACKER, 5n)), book)).toContain("does not know")
  })

  test("an undeployed book sends nothing at all", () => {
    expect(txProblem(tx(`0x${"00".repeat(20)}`, withdraw(5n)), bookOf(mainnetDeployment))).toContain("does not know")
  })
})

describe("approvals", () => {
  const plan = { token: book.usdg, spender: book.vault, amount: "5", tx: tx(book.usdg, approve(book.vault, 5n)) }

  test("a plan that says what its calldata says passes", () => {
    expect(approvalProblem(plan, book, { spender: book.vault, amount: 5n })).toBeNull()
  })

  test("calldata that approves someone else is refused, though the plan names the vault", () => {
    expect(approvalProblem({ ...plan, tx: tx(book.usdg, approve(ATTACKER, 5n)) }, book)).toContain("does not know")
  })

  test("calldata that approves more than the plan says is refused", () => {
    expect(approvalProblem({ ...plan, tx: tx(book.usdg, approve(book.vault, 500n)) }, book)).toContain("does not match")
  })

  test("another token, spender or amount than the page asked for is refused", () => {
    expect(approvalProblem({ ...plan, token: ATTACKER }, book)).toContain("another token")
    expect(approvalProblem(plan, book, { spender: book.permit2 })).toContain("another spender")
    expect(approvalProblem(plan, book, { amount: 6n })).toContain("different amount")
  })
})

describe("the Permit2 message", () => {
  const permit = () => ({
    domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: book.permit2 },
    types: {},
    primaryType: "PermitTransferFrom" as const,
    message: { permitted: { token: book.usdg, amount: "5" }, spender: book.vault, nonce: "1", deadline: String(NOW + 1_800) },
  })

  test("the deposit asked for passes", () => {
    expect(permitProblem(permit(), book, 5n, NOW)).toBeNull()
  })

  test("any change to who gets what, or for how long, is refused", () => {
    const edits = [
      (p: ReturnType<typeof permit>) => (p.message.spender = ATTACKER),
      (p: ReturnType<typeof permit>) => (p.message.permitted.token = ATTACKER),
      (p: ReturnType<typeof permit>) => (p.message.permitted.amount = "500"),
      (p: ReturnType<typeof permit>) => (p.domain.verifyingContract = ATTACKER),
      (p: ReturnType<typeof permit>) => (p.domain.chainId = 1),
      (p: ReturnType<typeof permit>) => (p.message.deadline = String(NOW + 86_400 * 365)),
    ]
    for (const edit of edits) {
      const row = permit()
      edit(row)
      expect(permitProblem(row, book, 5n, NOW)).toContain("not the deposit")
    }
  })
})

describe("closing a channel", () => {
  const id = `0x${"11".repeat(32)}` as Hex
  const payerSig = `0x${"22".repeat(65)}` as Hex
  const routerSig = `0x${"33".repeat(65)}` as Hex
  const close = { id, finalCumulative: 5n, deadline: 900n, payerSig }
  const data = (over: Partial<{ channelId: Hex; finalCumulative: bigint; deadline: bigint }> = {}, sig = routerSig) => encodeFunctionData({ abi: ChannelManagerAbi, functionName: "cooperativeClose", args: [id, { channelId: id, finalCumulative: 5n, deadline: 900n, ...over }, payerSig, sig] })
  const reply = (over = {}) => ({ to: book.channelManager, data: data(), chainId: CHAIN_ID, routerSig, ...over })

  test("exactly the close you signed passes", () => {
    expect(closeCallError(reply(), book, close)).toBeNull()
  })

  test("what the SDK refuses is refused here too", () => {
    expect(closeCallError(reply({ to: ATTACKER }), book, close)).toContain("another contract")
    expect(closeCallError(reply({ chainId: 1 }), book, close)).toContain("another chain")
    expect(closeCallError(reply({ data: "0xdeadbeef" }), book, close)).toContain("cannot be read")
    expect(closeCallError(reply({ data: encodeFunctionData({ abi: ChannelManagerAbi, functionName: "requestClose", args: [id] }) }), book, close)).toContain("not a close")
    expect(closeCallError(reply({ data: data({ finalCumulative: 500n }) }), book, close)).toContain("does not match")
    expect(closeCallError(reply({ data: data({ deadline: 901n }) }), book, close)).toContain("does not match")
    expect(closeCallError(reply({ data: data({}, `0x${"44".repeat(65)}`) }), book, close)).toContain("does not match")
  })

  test("a final amount above the deposit is never signed", () => {
    expect(finalAmountProblem(5n, 5n)).toBeNull()
    expect(finalAmountProblem(6n, 5n)).toContain("above")
  })
})

describe("the router's view of the network", () => {
  const view = (): Network => ({ chainId: CHAIN_ID, deployed: true, vault: book.vault, usdg: book.usdg, permit2: book.permit2, registry: book.registry, usageLedger: book.usageLedger, channelManager: book.channelManager, windowMarket: book.windowMarket, routerSigner: ATTACKER, channelPayee: ATTACKER, serverTime: NOW })

  test("an address that disagrees is replaced, and named", () => {
    const pinned = pinNetwork({ ...view(), usageLedger: ATTACKER, channelManager: ATTACKER }, { ...book, routerSigner: null })
    expect(pinned.usageLedger).toBe(book.usageLedger)
    expect(pinned.channelManager).toBe(book.channelManager)
    expect(pinned.mismatch).toBe("usageLedger, channelManager")
  })

  test("a matching view has no mismatch", () => {
    expect(pinNetwork(view(), { ...book, routerSigner: null }).mismatch).toBeNull()
  })

  test("a router signer the deployment names is pinned too", () => {
    const signer = `0x${"cd".repeat(20)}` as Hex
    const pinned = pinNetwork(view(), { ...book, routerSigner: signer })
    expect(pinned.routerSigner).toBe(signer)
    expect(pinned.mismatch).toBe("routerSigner")
  })
})
