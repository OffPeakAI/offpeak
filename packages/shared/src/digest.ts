import { keccak256, type Hex } from "viem"
import { CHAIN_ID } from "./constants.ts"
import { hashStruct } from "./eip712.ts"

/** Pass `version: null` for a domain with no version field, such as Permit2's. */
export function domainSeparator(name: string, verifyingContract: Hex, version: string | null = "1"): Hex {
  if (version === null) {
    return hashStruct(
      "EIP712Domain",
      {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
      { name, chainId: BigInt(CHAIN_ID), verifyingContract },
    )
  }
  return hashStruct(
    "EIP712Domain",
    {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
    { name, version, chainId: BigInt(CHAIN_ID), verifyingContract },
  )
}

export function typedDataDigest(structHash: Hex, separator: Hex): Hex {
  return keccak256(`0x1901${separator.slice(2)}${structHash.slice(2)}` as Hex)
}
