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

    function _evidence(address host, uint8 kind) internal pure returns (Evidence memory) {
        return Evidence({
            host: host,
            kind: kind,
            modelDigest: MODEL,
            samplesRoot: keccak256("samples"),
            sampleCount: 200,
            testId: TEST_ID,
            statistic: 9e6,
            threshold: 5e6,
            uri: "offpeak://evidence/sample"
        });
    }

    function _file(address host, uint8 kind) internal returns (uint256 id) {
        usdg.mint(challenger, CHALLENGE_BOND);
        vm.startPrank(challenger);
        usdg.approve(address(auditCourt), CHALLENGE_BOND);
        id = auditCourt.challenge(_evidence(host, kind));
        vm.stopPrank();
    }

    function _auditDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OffpeakAudit"),
                keccak256("1"),
                block.chainid,
                address(auditCourt)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _rulingSig(Ruling memory r) internal view returns (bytes memory) {
        bytes32 digest = _auditDigest(Typehashes.hash(r));
        return bytes.concat(_sig(rulerKeys[0], digest), _sig(rulerKeys[1], digest));
    }

    function _ruling(uint256 id, uint8 outcome, uint16 slashBps, bytes32 refundRoot) internal pure returns (Ruling memory) {
        return Ruling({
            challengeId: id,
            outcome: outcome,
            slashBps: slashBps,
            refundRoot: refundRoot,
            reasonHash: keccak256("reason")
        });
    }

    function _rule(uint256 id, uint8 outcome, uint16 slashBps, bytes32 refundRoot) internal {
        Ruling memory r = _ruling(id, outcome, slashBps, refundRoot);
        auditCourt.postRuling(r, _rulingSig(r));
    }

    function _decision(uint256 id, uint8 decision, uint16 bps, bytes32 refundRoot) internal pure returns (PanelDecision memory) {
        return PanelDecision({
            challengeId: id,
            decision: decision,
            finalSlashBps: bps,
            refundRoot: refundRoot,
            reasonHash: keccak256("panel")
        });
    }

    function _decide(uint256 id, uint8 decision, uint16 bps, bytes32 refundRoot) internal {
        PanelDecision memory d = _decision(id, decision, bps, refundRoot);
        panel.approve(_auditDigest(Typehashes.hash(d)));
        auditCourt.postPanelDecision(d, "");
    }

    function _accrue(address host, uint128 amount) internal {
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({host: host, amount: amount});
        usdg.mint(address(registry), amount);
        vm.prank(address(vault));
        registry.accrueCredits(uint64(block.timestamp / 3600), credits);
    }
}
