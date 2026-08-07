// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library ThresholdSig {
    error BadThresholdSig();

    /// signers: the 3-member set (sorted ascending), digest: EIP-712 digest, sig: 130 bytes = two 65-byte sigs,
    /// recovered addresses strictly ascending, both members, low-s enforced via OZ ECDSA.
    function verify2of3(address[3] memory signers, bytes32 digest, bytes calldata sig) internal pure {
        if (sig.length != 130) revert BadThresholdSig();
        address first = _recover(digest, sig[:65]);
        address second = _recover(digest, sig[65:]);
        if (first >= second || !_isMember(signers, first) || !_isMember(signers, second)) revert BadThresholdSig();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError) revert BadThresholdSig();
        return signer;
    }

    function _isMember(address[3] memory signers, address who) private pure returns (bool) {
        return who == signers[0] || who == signers[1] || who == signers[2];
    }
}
