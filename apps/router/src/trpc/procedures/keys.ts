import { z } from "zod"
import { issueKey } from "../../auth/keys.ts"
import { authed, missing, router } from "../init.ts"

const label = z.string().trim().min(1).max(64)

export const keys = router({
  list: authed.query(async ({ ctx }) => {
    const rows = await ctx.stack.db.query<{ key_hash: string; account_id: string; label: string; rpm_limit: number; audit_opt_in: boolean; created_at: string }>(
      `SELECT k.key_hash, k.account_id, k.label, k.rpm_limit, a.audit_opt_in, k.created_at FROM serving.api_keys k JOIN serving.accounts a ON a.id = k.account_id
       WHERE a.wallet = $1 AND k.revoked_at IS NULL ORDER BY k.created_at DESC`,
      [ctx.wallet],
    )
    return rows.rows.map((row) => ({
      id: row.key_hash,
      accountId: row.account_id,
      label: row.label,
      rpm: row.rpm_limit,
      audit: row.audit_opt_in,
      createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
    }))
  }),
  /** The token is shown once and stored only as a hash. Making a key leaves the audit choice as it was. */
  create: authed.input(z.strictObject({ label })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const created = await issueKey(stack, wallet, input.label)
    return { token: created.token, label: input.label }
  }),
  revoke: authed.input(z.strictObject({ id: z.string().regex(/^[0-9a-f]{64}$/) })).mutation(async ({ ctx, input }) => {
    const rows = await ctx.stack.db.query(
      `UPDATE serving.api_keys k SET revoked_at = now() FROM serving.accounts a
       WHERE k.account_id = a.id AND a.wallet = $1 AND k.key_hash = $2 AND k.revoked_at IS NULL RETURNING k.key_hash`,
      [ctx.wallet, input.id],
    )
    if (rows.rows.length === 0) throw missing()
    return { revoked: true }
  }),
})
