import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getAddress } from "viem"
import { createSiweMessage } from "viem/siwe"
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain } from "wagmi"
import { explain, rest, trpcMutation, trpcQuery } from "../lib/api.ts"
import { shortHex } from "../lib/format.ts"
import { sessionStore } from "../lib/session.ts"
import { CHAIN_ID } from "../lib/shared.ts"

export type Stage = "disconnected" | "wrong-chain" | "signed-out" | "ready"

type Value = {
  stage: Stage
  address: string | undefined
  token: string | null
  wallet: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  busy: boolean
  error: string | null
}

const SessionContext = createContext<Value | null>(null)

export function useSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession needs SessionProvider")
  return value
}

/** Reads one tRPC query as the signed-in wallet. Stays idle until there is a session. */
export function useAuthed<T>(path: string, input?: unknown, opts?: { refetchInterval?: number; enabled?: boolean }) {
  const { token, stage } = useSession()
  return useQuery({
    queryKey: [path, input, token],
    queryFn: () => trpcQuery<T>(path, input, token),
    enabled: stage === "ready" && Boolean(token) && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchInterval,
  })
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get)
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lower = address?.toLowerCase()
  const current = session && session.wallet === lower ? session : null

  const stage: Stage = !isConnected ? "disconnected" : chainId !== CHAIN_ID ? "wrong-chain" : current ? "ready" : "signed-out"

  const signIn = useCallback(async () => {
    if (!address) return
    setBusy(true)
    setError(null)
    try {
      const post = (path: string, body: unknown) => rest<Record<string, string>>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const { nonce } = await post("/v1/auth/nonce", { wallet: address })
      const message = createSiweMessage({
        address: getAddress(address),
        chainId: CHAIN_ID,
        domain: location.host,
        nonce: nonce!,
        uri: location.origin,
        version: "1",
        statement: "Sign in to Offpeak. This moves no funds.",
      })
      const signature = await signMessageAsync({ message })
      const login = await post("/v1/auth/login", { message, signature })
      sessionStore.set({ token: login.session!, wallet: login.wallet! })
    } catch (failure) {
      setError(explain(failure))
    } finally {
      setBusy(false)
    }
  }, [address, signMessageAsync])

  const signOut = useCallback(async () => {
    const token = sessionStore.get()?.token
    sessionStore.set(null)
    client.clear()
    if (token) await trpcMutation("account.signOut", undefined, token).catch(() => undefined)
  }, [client])
