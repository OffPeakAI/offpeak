import "@fontsource-variable/manrope"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { defineChain } from "viem"
import { WagmiProvider, createConfig, http, injected } from "wagmi"
import { App } from "./App.tsx"
import { SessionProvider } from "./components/session.tsx"
import { TxProvider } from "./components/tx.tsx"
import { ApiError } from "./lib/api.ts"
import { sessionStore } from "./lib/session.ts"
import { CHAIN_ID } from "./lib/shared.ts"
import "./styles.css"

// Only used when a wallet has to add the chain. Reads and sends go through the wallet's own provider.
const rpc = (import.meta.env.VITE_OFFPEAK_RPC_URL as string | undefined) ?? "https://robinhood.drpc.org"

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
})

const wagmi = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [chain.id]: http(rpc) },
})

const query = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) sessionStore.set(null)
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status < 500),
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmi}>
      <QueryClientProvider client={query}>
        <SessionProvider>
          <TxProvider>
            <App />
          </TxProvider>
        </SessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
