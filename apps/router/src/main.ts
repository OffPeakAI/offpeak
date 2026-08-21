import { bootRouter } from "./boot.ts"

const { server } = await bootRouter()
console.log(JSON.stringify({ service: "router", event: "listening", port: server.port }))
