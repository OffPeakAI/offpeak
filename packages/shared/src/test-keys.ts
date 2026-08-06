import { mnemonicToAccount, type HDAccount } from "viem/accounts"

/**
 * Public anvil development mnemonic. These accounts are published test keys,
 * not credentials. Indices 1–9 are the interface-vector signers.
 */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"

export function anvilAccount(index: number): HDAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index })
}

export const ROLE = {
  router: 1,
  host: 2,
  buyer: 3,
  settlerA: 4,
  settlerB: 5,
  settlerC: 6,
  rulingA: 7,
  rulingB: 8,
  rulingC: 9,
} as const

export function roleAccount(role: keyof typeof ROLE): HDAccount {
  return anvilAccount(ROLE[role])
}
