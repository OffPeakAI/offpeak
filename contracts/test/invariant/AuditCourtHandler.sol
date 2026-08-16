// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditCourt} from "../../src/AuditCourt.sol";
import {CourtFixture} from "../helpers/CourtFixture.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

/// @notice Drives challenges through every path, and mirrors what each host's bond should be.
contract AuditCourtHandler is CourtFixture {
    uint8 internal constant CONFIRM = 0;
    uint8 internal constant DOWNGRADE = 1;
    uint8 internal constant PANEL_DISMISS = 2;

    address[] public hosts;
    uint256[] public ids;
    bool public attackAccepted;
    bool public dismissalUnderpaid;
    uint256 public fullSlashes;
    uint256 public breaches;
    uint256 public dismissals;
    uint256 public panelReviews;
    uint256 public timeouts;
    uint8 internal constant DELISTED_NOW = 5;
    mapping(address => uint256) public mirroredBond;
    mapping(address => uint256) public confirms;

    constructor() {
        VaultFixture.setUp();
        _allowGpuClass();
        for (uint256 i; i < 3; ++i) {
            _spawnHost();
        }
    }

    function setUp() public override {}

    function hostCount() external view returns (uint256) {
        return hosts.length;
    }

    function courtAddress() external view returns (address) {
        return address(auditCourt);
    }

    function registryAddress() external view returns (address) {
        return address(registry);
    }

    function usdgBalanceOf(address who) external view returns (uint256) {
        return usdg.balanceOf(who);
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function file(uint256 hostSeed, uint8 kind) external {
        address host = hosts[hostSeed % hosts.length];
        (uint8 status,) = registry.standing(host);
        if (status == 0) return;
        ids.push(_file(host, kind % 4));
    }

    function accrueCredits(uint256 hostSeed, uint128 amount) external {
        _accrue(hosts[hostSeed % hosts.length], uint128(bound(amount, 1, 1_000e6)));
    }

    /// Delisting ends a host's story, so runs keep getting fresh ones.
    function spawnHost() external {
        if (hosts.length < 12) _spawnHost();
    }

    /// Walks one challenge through a whole panel path, because random steps rarely finish one.
    function cycle(uint256 hostSeed, uint8 pathSeed) external {
        address host = hosts[hostSeed % hosts.length];
        uint8 path = pathSeed % 5;
        uint256 id = _file(host, 0);
        ids.push(id);
        if (path == 4) {
            vm.warp(block.timestamp + 14 days);
            auditCourt.finalize(id);
            ++timeouts;
            return;
        }
        vm.prank(host);
        auditCourt.respond(id, keccak256("response"));
        _rule(id, 2, 10_000, bytes32(0));
        ++panelReviews;
        vm.warp(auditCourt.challengeView(id).reviewEndsAt);
        if (path == 3) {
            vm.warp(block.timestamp + 14 days);
            auditCourt.finalize(id);
            ++timeouts;
            return;
        }
        uint16 bps = path == CONFIRM ? 10_000 : path == DOWNGRADE ? 2_000 : 0;
        _decide(id, path, bps, bytes32(0));
        _applyDecision(auditCourt.challengeView(id));
        auditCourt.finalize(id);
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 days));
    }

    function respond(uint256 idSeed) external {
        (uint256 id, AuditCourt.Challenge memory c) = _pick(idSeed);
        if (id == 0 || c.state != AuditCourt.State.Filed || block.timestamp > c.filedAt + 24 hours) return;
        vm.prank(c.host);
        auditCourt.respond(id, keccak256("response"));
    }

    function rule(uint256 idSeed, uint8 outcomeSeed) external {
        (uint256 id, AuditCourt.Challenge memory c) = _pick(idSeed);
        if (id == 0 || c.state != AuditCourt.State.Filed) return;
        if (!c.responded && block.timestamp < c.filedAt + 24 hours) return;
        uint8 outcome = outcomeSeed % 3;
        if (outcome == 2 && c.kind != 0) outcome = 1;
        if (outcome == 0) _dismiss(id, c.host);
        else if (outcome == 1) _breach(id, c.host);
        else {
            _rule(id, 2, 10_000, bytes32(0));
            ++panelReviews;
        }
    }

    /// The ruling keys try to reach a full slash without the panel. It must never work.
    function attackFullSlashByRuling(uint256 idSeed) external {
        (uint256 id, AuditCourt.Challenge memory c) = _pick(idSeed);
        if (id == 0 || c.state == AuditCourt.State.Filed) return;
        try this.tryRule(id) {
            attackAccepted = true;
        } catch {}
    }

    function tryRule(uint256 id) external {
        if (msg.sender != address(this)) return;
        _rule(id, 2, 10_000, bytes32(0));
    }

    function decide(uint256 idSeed, uint8 decisionSeed) external {
        (uint256 id, AuditCourt.Challenge memory c) = _pick(idSeed);
        if (id == 0 || c.state != AuditCourt.State.PanelReview) return;
        uint8 decision = decisionSeed % 3;
        if (decision != PANEL_DISMISS && block.timestamp < c.reviewEndsAt) return;
        uint16 bps = decision == CONFIRM ? 10_000 : decision == DOWNGRADE ? 2_000 : 0;
        _decide(id, decision, bps, bytes32(0));
    }

    function finalize(uint256 idSeed) external {
        (uint256 id, AuditCourt.Challenge memory c) = _pick(idSeed);
        if (id == 0) return;
        if (c.state == AuditCourt.State.Decided) {
            _applyDecision(c);
            auditCourt.finalize(id);
        } else if (
            (c.state == AuditCourt.State.Filed || c.state == AuditCourt.State.PanelReview)
                && block.timestamp >= _timeoutAt(c)
        ) {
            auditCourt.finalize(id);
            ++timeouts;
        }
    }

    function _spawnHost() private {
        address host = address(uint160(0xA000 + hosts.length));
        hosts.push(host);
        _activeHost(host);
        mirroredBond[host] = BOND;
    }

    function _timeoutAt(AuditCourt.Challenge memory c) private pure returns (uint256) {
        return c.reviewEndsAt > 0 ? uint256(c.reviewEndsAt) + 7 days : uint256(c.filedAt) + 14 days;
    }

    function _applyDecision(AuditCourt.Challenge memory c) private {
        if (c.decision == CONFIRM) {
            mirroredBond[c.host] = 0;
            ++confirms[c.host];
            ++fullSlashes;
        } else if (c.decision == DOWNGRADE) {
            _mirrorBreach(c.host);
        }
    }

    /// A delisted host has taken its strikes, so a further Breach takes nothing.
    function _mirrorBreach(address host) private {
        (uint8 status,) = registry.standing(host);
        if (status != DELISTED_NOW) mirroredBond[host] -= mirroredBond[host] * 2_000 / 10_000;
    }

    function _dismiss(uint256 id, address host) private {
        uint256 before = usdg.balanceOf(host);
        _rule(id, 0, 0, bytes32(0));
        if (usdg.balanceOf(host) - before != CHALLENGE_BOND / 2) dismissalUnderpaid = true;
        ++dismissals;
    }

    function _breach(uint256 id, address host) private {
        _mirrorBreach(host);
        _rule(id, 1, 2_000, bytes32(0));
        ++breaches;
    }

    function _pick(uint256 seed) private view returns (uint256 id, AuditCourt.Challenge memory c) {
        if (ids.length == 0) return (0, c);
        id = ids[seed % ids.length];
        c = auditCourt.challengeView(id);
    }
}
