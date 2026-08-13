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
