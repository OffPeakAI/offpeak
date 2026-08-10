// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuditCourt} from "../../src/AuditCourt.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "../../src/interfaces/IOffpeakVault.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// @notice An EIP-1271 panel that accepts whatever its reviewers approved.
contract MockPanel {
    mapping(bytes32 => bool) public approved;

    function approve(bytes32 digest) external {
        approved[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? bytes4(0x1626ba7e) : bytes4(0);
    }
}

abstract contract CourtFixture is VaultFixture {
    uint256 internal constant BOND = 2_000e6;
    uint256 internal constant CHALLENGE_BOND = 100e6;
    bytes32 internal constant GPU = keccak256("h100-80g-sxm");
    bytes32 internal constant MODEL = keccak256("model-a");
    bytes32 internal constant TEST_ID = keccak256("llr-mix-v1");

    AuditCourt internal auditCourt;
    MockPanel internal panel;
    address[3] internal rulers;
    uint256[3] internal rulerKeys;
    address internal challenger = makeAddr("challenger");

    function _courtAddress() internal override returns (address) {
        for (uint256 i; i < 3; ++i) {
            (rulers[i], rulerKeys[i]) = makeAddrAndKey(string.concat("ruler-", vm.toString(i)));
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (rulers[j] < rulers[i]) {
                    (rulers[i], rulers[j]) = (rulers[j], rulers[i]);
                    (rulerKeys[i], rulerKeys[j]) = (rulerKeys[j], rulerKeys[i]);
                }
            }
        }
        panel = new MockPanel();
        auditCourt = new AuditCourt(
            owner,
            IERC20(address(usdg)),
            IHostRegistry(address(registry)),
            IOffpeakVault(address(vault)),
            rulers,
            address(panel),
            treasury
        );
        return address(auditCourt);
    }

    function _allowGpuClass() internal {
        vm.prank(owner);
        registry.setGpuClass(GPU, true);
    }

    function _activeHost(address operator) internal {
        usdg.mint(operator, BOND);
        bytes32[] memory digests = new bytes32[](1);
        digests[0] = MODEL;
        uint32[] memory maxTps = new uint32[](1);
        maxTps[0] = 100;
        RegisterParams memory p = RegisterParams({
            modelDigests: digests,
            maxTps: maxTps,
            imageDigest: keccak256("image"),
            gpuClass: GPU,
            endpointHash: keccak256("endpoint"),
            attestationRef: keccak256("attestation"),
            bondUsdg: BOND,
            bondOfpk: 0
        });
        vm.startPrank(operator);
        usdg.approve(address(registry), BOND);
        registry.register(p);
        vm.stopPrank();
        vm.warp(block.timestamp + 72 hours);
        registry.activate(operator);
    }
