import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import pg from "pg"

export type Rows<T> = { rows: T[] }

/** The surface every service uses, which PGlite and node-postgres both satisfy. */
export type Db = {
  query<T>(sql: string, params?: unknown[]): Promise<Rows<T>>
  exec(sql: string): Promise<unknown>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

const SHARED_SQL = new URL("../../../packages/shared/sql/shared.sql", import.meta.url)
const CHAIN_SQL = new URL("../../../db/chain/schema.sql", import.meta.url)

/** Wraps a PGlite handle, which is also how tests share one database with the router. */
export function wrapPglite(client: PGlite): Db {
  return {
    query: (sql, params) => client.query(sql, params as never) as never,
    exec: (sql) => client.exec(sql),
    transaction: (fn) =>
      client.transaction((tx) =>
        fn({
          query: (sql, params) => tx.query(sql, params as never) as never,
          exec: (sql) => tx.exec(sql),
          transaction: () => Promise.reject(new Error("nested transactions are not supported")),
        }),
      ) as never,
  }
}

function wrapPool(pool: pg.Pool): Db {
  return {
    query: (sql, params) => pool.query(sql, params as never) as never,
    exec: (sql) => pool.query(sql),
    transaction: async (fn) => {
      const client = await pool.connect()
      const tx: Db = {
        query: (sql, params) => client.query(sql, params as never) as never,
        exec: (sql) => client.query(sql),
        transaction: () => Promise.reject(new Error("nested transactions are not supported")),
      }
      try {
        await client.query("BEGIN")
        const result = await fn(tx)
        await client.query("COMMIT")
        return result
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      } finally {
        client.release()
      }
    },
  }
}

/** A pool on an existing database, for a service that owns its own schema steps. */
export function connectDatabase(url: string): Db {
  return wrapPool(openPool(url))
}

/** An idle client dropping must not take the process down; the pool replaces it on next use. */
function openPool(url: string) {
  const pool = new pg.Pool({ connectionString: url })
  pool.on("error", (err) => console.error(JSON.stringify({ service: "db", event: "idle_client_error", error: String(err) })))
  return pool
}

export async function applySchemas(db: Db, opts: { shared: boolean }) {
  if (opts.shared) await db.exec(readFileSync(SHARED_SQL, "utf8"))
  await db.exec(readFileSync(CHAIN_SQL, "utf8"))
}

/** Accepts `pglite://memory`, `pglite://<dir>` and `postgres://…`. */
export async function openDatabase(url: string): Promise<Db> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length)
    const db = wrapPglite(new PGlite(target === "memory" ? undefined : target))
    await applySchemas(db, { shared: true })
    return db
  }
  const db = wrapPool(openPool(url))
  await applySchemas(db, { shared: false })
  return db
}
