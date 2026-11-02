import type { Hex } from "@offpeak/shared"
import { z } from "zod"

/** Every amount here lands in a Postgres bigint, which is narrower than the chain's uint128. */
const BIGINT_MAX = 2n ** 63n - 1n

const decimal = z
  .union([z.string().regex(/^\d{1,39}$/), z.number().int().nonnegative()])
  .transform((value) => BigInt(value))
  .refine((value) => value <= BIGINT_MAX)

export const channelId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex)

/** Contract wallets sign with more than 65 bytes, so only the size is bounded. */
export const signature = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2}){1,8192}$/)
  .transform((value) => value as Hex)

export const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const voucherBody = z.object({ seq: decimal, cumulative: decimal, sig: signature })

export const closeBody = z.object({ finalCumulative: decimal, deadline: decimal, payerSig: signature })

export const channelProof = z.object({ ts: z.number().int(), nonce: z.string().min(1).max(128), sig: signature })
