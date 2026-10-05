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

  const value = useMemo<Value>(() => ({ stage, address, token: current?.token ?? null, wallet: current?.wallet ?? null, signIn, signOut, busy, error }), [stage, address, current, signIn, signOut, busy, error])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function ConnectButtons() {
  const { connectors, connect, isPending, error } = useConnect()
  // wagmi lists the generic injected connector first. Named wallets that announced themselves read better.
  const named = connectors.filter((row) => row.type !== "injected" || row.id !== "injected")
  const shown = named.length > 0 ? named : connectors
  return (
    <>
      <div className="row">
        {shown.map((connector) => (
          <button key={connector.uid} type="button" className="btn" disabled={isPending} onClick={() => connect({ connector, chainId: CHAIN_ID })}>
            {isPending ? "Waiting for wallet" : named.length > 0 ? connector.name : "Connect wallet"}
          </button>
        ))}
      </div>
      {error && <p className="field-error">{explain(error)}</p>}
    </>
  )
}

export function SwitchChain() {
  const { switchChain, isPending, error } = useSwitchChain()
  return (
    <>
      <button type="button" className="btn" disabled={isPending} onClick={() => switchChain({ chainId: CHAIN_ID })}>
        {isPending ? "Waiting for wallet" : "Switch to Robinhood Chain"}
      </button>
      {error && <p className="field-error">{explain(error)}</p>}
    </>
  )
}

/** Shows the one next step a person needs, until the wallet is connected, on chain and signed in. */
export function Gate({ what, children }: { what: string; children: ReactNode }) {
  const { stage, signIn, busy, error, address } = useSession()
  const { disconnect } = useDisconnect()
  if (stage === "ready") return <>{children}</>
  return (
    <div className="gate">
      {stage === "disconnected" && (
        <>
          <p className="gate-step">Step 1 of 2</p>
          <h3>Connect a wallet to see {what}.</h3>
          <p className="note">
            Your balance is prepaid credit you can withdraw. Your wallet signs every transaction; Offpeak never holds a key. Read the <a href="/terms">terms</a> and <a href="/docs#limits">honest limits</a> first.
          </p>
          <ConnectButtons />
        </>
      )}
      {stage === "wrong-chain" && (
        <>
          <p className="gate-step">Wrong network</p>
          <h3>This wallet is on another chain.</h3>
          <p className="note">Offpeak settles on Robinhood Chain, id {CHAIN_ID}. Nothing can be signed until you switch.</p>
          <div className="row">
            <SwitchChain />
            <button type="button" className="btn ghost" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}
      {stage === "signed-out" && (
        <>
          <p className="gate-step">Step 2 of 2</p>
          <h3>Sign in as {address ? shortHex(address) : "this wallet"}.</h3>
          <p className="note">
            One signature proves the wallet is yours. It is free and moves no funds. By signing in you accept the <a href="/terms">terms</a>.
          </p>
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => void signIn()}>
              {busy ? "Check your wallet" : "Sign in with Ethereum"}
            </button>
            <button type="button" className="btn ghost" onClick={() => disconnect()}>
              Use another wallet
            </button>
          </div>
          {error && <p className="field-error">{error}</p>}
        </>
      )}
    </div>
  )
}

export function WalletChip() {
  const { stage, address, signOut } = useSession()
  const { disconnect } = useDisconnect()
  if (!address) return <a className="chip" href="/dashboard">Sign in</a>
  const leave = () => {
    void signOut()
    disconnect()
  }
  return (
    <button type="button" className={stage === "wrong-chain" ? "chip warn" : "chip"} onClick={leave} title="Sign out and disconnect">
      {stage === "wrong-chain" ? "Wrong network" : shortHex(address)}
    </button>
  )
}
