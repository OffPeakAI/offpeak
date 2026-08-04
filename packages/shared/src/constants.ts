/** Protocol constants. Integer money; ratios that are bps stay integers. */
export const CHAIN_ID = 4663

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const

export const FEE_BPS_DEFAULT = 400
export const FEE_BPS_AUDIT_OPT_IN = 296
export const FEE_BPS_MIN = 100

export const LOAD_FACTOR_MIN_BPS = 4000
export const LOAD_FACTOR_MAX_BPS = 12000
export const FLOOR_MAX_RATIO_BPS = 6000

export const HOUR_CLOSE_GRACE_S = 600
export const MAX_REQUEST_S = 600
export const SETTLE_TARGET_S = 3300
export const WITHDRAW_ALL_MAX_DELAY_S = 7200
export const HOST_CREDIT_DELAY_S = 86400

/** 2,000 USDG in µUSDG. */
export const HOST_MIN_BOND = 2_000_000_000n
export const PROBATION_S = 259_200
export const UNBONDING_S = 604_800

export const CHANNEL_CHALLENGE_S = 7_200
export const CHANNEL_MIN_LIFETIME_S = 21_600
export const CHANNEL_SETTLE_EVERY_S = 300
export const CHANNEL_SETTLE_EVERY_MICRO = 1_000_000n

export const UPTO_MIN_MAX_MICRO = 50_000n
export const UPTO_PRECONFIRM_BUDGET_MICRO = 20_000n
export const UPTO_PRECONFIRM_TOKENS = 256
export const X402_EXPIRY_GRACE_S = 900

export const CHALLENGE_BOND = 100_000_000n
export const HOST_RESPONSE_S = 86_400
export const PANEL_REVIEW_S = 604_800
export const SWAP_SLASH_BPS = 10_000
export const BREACH_SLASH_BPS = 2_000

export const WINDOW_CANCEL_REFUND_BPS = 9_500
export const WINDOW_EXPIRY_REFUND_BPS = 5_000
export const WINDOW_RESALE_SALE_BPS = 100
export const WINDOW_RESALE_MARKUP_BPS = 1_000
export const WINDOW_FAILURE_BELOW_BPS = 2_000
export const WINDOW_MAX_SHARE_BPS = 7_000
export const WINDOW_COLLATERAL_BPS = 2_000

export const DISPUTE_WINDOW_S = 604_800
export const AUDIT_BODY_RETENTION_S = 259_200

export const FEE_SPLIT_OPS_BPS = 8_000
export const FEE_SPLIT_TREASURY_BPS = 1_000
export const FEE_SPLIT_HOST_REWARDS_BPS = 500
export const FEE_SPLIT_BURN_BPS = 500

export const BETA_CAP_PER_BUYER_MICRO = 500_000_000n

export const GPU_CLASSES = [
  "h100-80g-sxm",
  "h100-80g-pcie",
  "h200-141g",
  "a100-80g",
  "l40s-48g",
  "rtx4090-24g",
  "cpu-tdx-dev",
] as const

export type GpuClassName = (typeof GPU_CLASSES)[number]

/** Local tests only. Never treated as routable when OFFPEAK_ENV=mainnet. */
export const DEV_ONLY_GPU_CLASS: GpuClassName = "cpu-tdx-dev"

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const

export const TOKENS_PER_MILLION = 1_000_000n

/** Default channel credit limit: min(0.25 USDG, 10% of deposit). */
export const CHANNEL_CREDIT_CAP_MICRO = 250_000n
export const CHANNEL_CREDIT_DEPOSIT_BPS = 1_000

export const HOLD_TTL_S = 15 * 60
export const METER_TOLERANCE_ABS = 2
export const METER_TOLERANCE_BPS = 50

export const BODY_MAX_BYTES = 4 * 1024 * 1024
export const DEFAULT_RPM = 600
export const PRICE_SNAPSHOT_TTL_S = 3600
export const MAX_SHEETS_PER_HOST_PER_WEEK = 24
export const SHEET_MIN_LEAD_S = 3600

export const AUDIT_MIN_SAMPLES = 200
export const AUDIT_CANARY_RATE = 0.005
export const AUDIT_SAMPLE_RATE = 0.02
export const LLR_EPSILON = 0.1
export const LLR_MIN_N = 200

export const DOMAIN_VERSION = "1" as const
