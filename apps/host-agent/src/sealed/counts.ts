import type { Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { countsMessage, type SealedCounts } from "../../../../packages/sdk/src/sealed/attest.ts"

/**
 * Signs this boot's counts. The key is made here and nothing writes it anywhere, unlike the operator
 * key, which arrives from outside the VM. So a proxy in front of the VM can sign a record but not a count.
 */
export class CountsKey {
  readonly #account = privateKeyToAccount(generatePrivateKey())
  readonly address = this.#account.address.toLowerCase() as Hex

  async sign(counts: Omit<SealedCounts, "sig">): Promise<SealedCounts> {
    return { ...counts, sig: await this.#account.signMessage({ message: countsMessage(counts) }) }
  }
}
