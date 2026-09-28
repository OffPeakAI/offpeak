import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const router = process.env.OFFPEAK_ROUTER_URL ?? "http://127.0.0.1:8787"

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/v1": router, "/trpc": router } },
  build: { chunkSizeWarningLimit: 900 },
})
