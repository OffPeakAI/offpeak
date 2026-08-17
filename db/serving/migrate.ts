import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createMemoryDb } from "../../packages/shared/src/migrate.ts"

const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8")

export async function migrateServing() {
  const url = process.env.OFFPEAK_DATABASE_URL ?? "pglite://memory"
  if (!url.startsWith("pglite")) {
    console.log("Apply packages/shared/sql/shared.sql and db/serving/schema.sql with psql against OFFPEAK_DATABASE_URL")
    return
  }
  const db = await createMemoryDb()
  await db.client.exec(sql)
  console.log("applied serving schema on pglite memory")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrateServing()
}
