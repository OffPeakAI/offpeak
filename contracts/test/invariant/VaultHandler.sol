// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {OffpeakVault} from "../../src/OffpeakVault.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {HourMath} from "../../src/lib/HourMath.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

/// @notice Drives the vault with random but valid actions. Settles obey caps and the request-hour rule, so a
/// revert anywhere here fails the run; `attemptBadDebit` is the one action that must be refused.
contract VaultHandler is VaultFixture {
    uint256 internal constant ACTORS = 3;

    address[ACTORS] public actors = [address(0x1000), address(0x2000), address(0x3000)];
    bool public settlesHalted;
    bool public badDebitAccepted;
    uint64 public ghostLastSettled;
    uint256 public settleCount;
    uint256 public clampCount;
    uint256 public refundCount;
    mapping(address => mapping(uint64 => uint128)) internal _debitedOnDay;

    function usdgBalanceOf(address who) external view returns (uint256) {
        return usdg.balanceOf(who);
    }

    function registryAddress() external view returns (address) {
        return address(registry);
    }

    constructor() {
        VaultFixture.setUp();
        ghostLastSettled = vault.lastSettledHour();
        for (uint256 i; i < ACTORS; ++i) {
            _fundWithCaps(actors[i], 200e6, 20e6);
        }
    }

    function setUp() public override {}

    function vaultAddress() external view returns (OffpeakVault) {
        return vault;
    }

    function usdgBalanceOfVault() external view returns (uint256) {
        return usdg.balanceOf(address(vault));
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        BuyerView memory v = vault.buyerState(actor);
        if (v.withdrawRequestedAt != 0 || v.balance >= vault.BETA_CAP()) return;
        _fund(actor, bound(amount, 1, vault.BETA_CAP() - v.balance));
    }

    function setCaps(uint256 actorSeed, uint128 hourly, uint128 daily) external {
        hourly = uint128(bound(hourly, 0, 200e6));
        daily = uint128(bound(daily, 0, 1_000e6));
        vm.prank(_actor(actorSeed));
        vault.setCaps(hourly, daily);
    }

    function withdrawAvailable(uint256 actorSeed, uint256 share) external {
        address actor = _actor(actorSeed);
        uint256 available = vault.buyerState(actor).balance - vault.reserveOf(actor);
        vm.prank(actor);
        vault.withdraw(available * bound(share, 0, 100) / 100);
    }

    function requestExit(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (vault.buyerState(actor).withdrawRequestedAt != 0) return;
        vm.prank(actor);
        vault.requestWithdrawAll();
    }

    function cancelExit(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (vault.buyerState(actor).withdrawRequestedAt == 0) return;
        vm.prank(actor);
        vault.cancelWithdrawAll();
    }

    function executeExit(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        BuyerView memory v = vault.buyerState(actor);
        if (v.withdrawRequestedAt == 0) return;
        bool due = block.timestamp >= v.withdrawDueAt || vault.lastSettledHour() >= HourMath.hourOf(v.withdrawRequestedAt);
        if (due) vault.executeWithdrawAll(actor);
    }

    function warp(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 3 hours));
    }
