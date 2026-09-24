import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { erc20Abi, publicActions, type Account, type Chain, type Hex, type PublicActions, type Transport, type WalletClient } from "viem"
import { useConfig } from "wagmi"
import { getWalletClient } from "wagmi/actions"
import { Refused, explain, trpcMutation } from "../lib/api.ts"
import { formatUsdg, shortHex } from "../lib/format.ts"
import { CHAIN_ID } from "../lib/shared.ts"
import type { Approval, Plan, Tx } from "../lib/types.ts"
import { approvalProblem, deployedBook, txProblem, type Want } from "../lib/wallet-check.ts"
import { useSession } from "./session.tsx"

type Line = { label: string; state: "doing" | "done" | "skipped"; hash?: Hex }
type Tray = { title: string; lines: Line[]; state: "running" | "done" | "failed"; error?: string }

type Client = WalletClient<Transport, Chain, Account> & PublicActions<Transport, Chain, Account>

export type Wallet = {
  address: Hex
  approve: (approval: Approval, want?: { spender?: Hex; amount?: bigint }) => Promise<void>
  send: (label: string, tx: Tx, want?: Want) => Promise<void>
  sign: <T>(label: string, work: () => Promise<T>) => Promise<T>
  client: Client
}

async function walletFor(config: Parameters<typeof getWalletClient>[0]) {
  return (await getWalletClient(config, { chainId: CHAIN_ID })).extend(publicActions) as unknown as Client
}

type Run = (title: string, work: (wallet: Wallet) => Promise<void>) => Promise<boolean>

const TxContext = createContext<{ run: Run; busy: boolean } | null>(null)

export function useTx() {
  const value = useContext(TxContext)
  if (!value) throw new Error("useTx needs TxProvider")
  return value
}

/**
 * Every write in the app goes through here. The router supplies calldata and the user's wallet signs
 * it, so each one is checked first against this build's addresses and what the page asked for. Each
 * transaction is simulated next, so a refusal costs nothing.
 */
export function TxProvider({ children }: { children: ReactNode }) {
  const config = useConfig()
  const queries = useQueryClient()
  const [tray, setTray] = useState<Tray | null>(null)
  const running = useRef(false)

  const run = useCallback<Run>(
    async (title, work) => {
      if (running.current) return false
      running.current = true
      const lines: Line[] = []
      const show = (state: Tray["state"], error?: string) => setTray({ title, lines: [...lines], state, ...(error ? { error } : {}) })
      const begin = (label: string) => {
        const line: Line = { label, state: "doing" }
        lines.push(line)
        show("running")
        return line
      }
      show("running")
      try {
        const client = await walletFor(config)
        const address = client.account.address
        const send = async (label: string, tx: Tx, want?: Want) => {
          const problem = txProblem(tx, deployedBook, want)
          if (problem) throw new Refused(problem)
          const line = begin(label)
          await client.call({ account: address, to: tx.to, data: tx.data })
          line.hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: 0n })
          show("running")
          const receipt = await client.waitForTransactionReceipt({ hash: line.hash, pollingInterval: 1_000 })
          if (receipt.status !== "success") throw new Error("reverted: the transaction failed on chain")
          line.state = "done"
          show("running")
        }
        const wallet: Wallet = {
          address,
          client,
          send,
          sign: async (label, step) => {
            const line = begin(label)
            const out = await step()
            line.state = "done"
            show("running")
            return out
          },
          approve: async (approval, want) => {
            const problem = approvalProblem(approval, deployedBook, want)
            if (problem) throw new Refused(problem)
            const allowance = await client.readContract({ address: approval.token, abi: erc20Abi, functionName: "allowance", args: [address, approval.spender] })
            if (allowance >= BigInt(approval.amount)) {
              lines.push({ label: "Allowance already covers this", state: "skipped" })
              show("running")
              return
            }
            await send(`Approve ${formatUsdg(approval.amount)} USDG`, approval.tx)
          },
        }
        await work(wallet)
        show("done")
        return true
      } catch (failure) {
        show("failed", explain(failure))
        return false
      } finally {
        running.current = false
        await queries.invalidateQueries()
      }
    },
    [config, queries],
  )
