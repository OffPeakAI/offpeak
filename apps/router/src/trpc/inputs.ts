import { z } from "zod"

const UINT128_LIMIT = 1n << 128n
const UINT64_LIMIT = 1n << 64n

/** µUSDG as a decimal string. Money never crosses the wire as a JSON number. */
export const micro = z
  .string()
  .regex(/^\d{1,39}$/)
  .transform((value) => BigInt(value))
  .refine((value) => value < UINT128_LIMIT)

export const pricePerUnit = micro.refine((value) => value < UINT64_LIMIT)

export const positiveMicro = micro.refine((value) => value > 0n)

export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`)

export const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/)
  .transform((value) => value as `0x${string}`)

/** Window, listing, challenge and nonce values are uint256 on chain. */
export const uint256 = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((value) => BigInt(value))

export const units = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .transform((value) => BigInt(value))
