// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ThresholdSig} from "../../src/lib/ThresholdSig.sol";

contract ThresholdSigTest is Test {
    bytes32 internal constant DIGEST = keccak256("digest");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address[3] internal signers;
    uint256[3] internal keys;

    function setUp() public {
        (address a, uint256 ka) = makeAddrAndKey("settler-a");
        (address b, uint256 kb) = makeAddrAndKey("settler-b");
        (address c, uint256 kc) = makeAddrAndKey("settler-c");
        signers = [a, b, c];
        keys = [ka, kb, kc];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (signers[j] < signers[i]) {
                    (signers[i], signers[j]) = (signers[j], signers[i]);
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
    }

    function verify(bytes calldata sig) external view {
        ThresholdSig.verify2of3(signers, DIGEST, sig);
    }

    function test_acceptsEveryAscendingPair() public view {
        this.verify(bytes.concat(_sign(keys[0]), _sign(keys[1])));
        this.verify(bytes.concat(_sign(keys[0]), _sign(keys[2])));
        this.verify(bytes.concat(_sign(keys[1]), _sign(keys[2])));
    }

    function test_rejectsUnsortedPair() public {
        _expectRejected(bytes.concat(_sign(keys[1]), _sign(keys[0])));
    }

    function test_rejectsDuplicateSigner() public {
        _expectRejected(bytes.concat(_sign(keys[0]), _sign(keys[0])));
    }

    function test_rejectsNonMember() public {
        (address outsider, uint256 key) = makeAddrAndKey("outsider");
        bytes memory theirs = _sign(key);
        bytes memory member = _sign(outsider < signers[0] ? keys[0] : keys[2]);
        _expectRejected(outsider < signers[0] ? bytes.concat(theirs, member) : bytes.concat(member, theirs));
    }

    function test_rejectsWrongLength() public {
        _expectRejected(_sign(keys[0]));
        _expectRejected(bytes.concat(_sign(keys[0]), _sign(keys[1]), hex"00"));
        _expectRejected("");
    }

    function test_rejectsMalleableSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[1], DIGEST);
        bytes memory malleable =
            abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        _expectRejected(bytes.concat(_sign(keys[0]), malleable));
    }

    function testFuzz_rejectsTamperedDigest(bytes32 digest) public {
        vm.assume(digest != DIGEST);
        bytes memory sig = bytes.concat(_sign(keys[0]), _sign(keys[1]));
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        this.verifyDigest(digest, sig);
    }

    function verifyDigest(bytes32 digest, bytes calldata sig) external view {
        ThresholdSig.verify2of3(signers, digest, sig);
    }

    function _expectRejected(bytes memory sig) private {
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        this.verify(sig);
    }

    function _sign(uint256 key) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, DIGEST);
        return abi.encodePacked(r, s, v);
    }
}
