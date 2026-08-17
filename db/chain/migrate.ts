import { applySchemas, openDatabase } from "../../services/common/src/index.ts"

const db = await openDatabase(process.env.OFFPEAK_DATABASE_URL ?? "pglite://memory")
await applySchemas(db, { shared: false })
console.log("applied chain schema")
process.exit(0)
