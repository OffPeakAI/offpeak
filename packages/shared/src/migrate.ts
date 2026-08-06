import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "./db.ts"

const here = dirname(fileURLToPath(import.meta.url))

export function sharedSql(): string {
  return readFileSync(join(here, "../sql/shared.sql"), "utf8")
}

export async function createMemoryDb() {
  const client = new PGlite()
  await client.exec(sharedSql())
  const db = drizzle(client, { schema })
  return { client, db, schema }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const url = process.env.OFFPEAK_DATABASE_URL ?? "pglite://memory"
  if (url.startsWith("pglite")) {
    await createMemoryDb()
    console.log("applied shared schema on pglite memory")
  } else {
    console.log("Apply packages/shared/sql/shared.sql with psql against OFFPEAK_DATABASE_URL")
  }
}
