// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../../src/interfaces/OffpeakTypes.sol";
import {HourMath} from "../../src/lib/HourMath.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

/// @notice Models a router that obeys the on-chain state, then lets the buyer withdraw everything allowed.
contract ReserveHandler is VaultFixture {
    uint256 internal constant ACTORS = 3;

    address[ACTORS] public actors = [address(0x1000), address(0x2000), address(0x3000)];
    bool public unexpectedClamp;
    uint256 public settleCount;
    uint256 public servedTotal;
    uint256 public fullCapWithdrawals;
    uint256 public midnightCrossings;
    mapping(address => bool) public exitedLate;
    mapping(address => uint256) public unsettled;

    mapping(address => mapping(uint64 => uint128)) internal _hourSpend;
    mapping(address => mapping(uint64 => uint64)) internal _hourLastTs;
    mapping(address => mapping(uint64 => uint128)) internal _daySpend;

    /// Starts three hours before UTC midnight with hourly cap equal to daily cap, the shape that needs one
    /// daily cap per day touched, so every run crosses a day boundary with usage open on both sides.
    constructor() {
        VaultFixture.setUp();
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        _settleEmptyThrough(HourMath.hourOf(midnight - 3 hours) - 1);
        vm.warp(midnight - 3 hours);
        for (uint256 i; i < ACTORS; ++i) {
            _fund(actors[i], 300e6);
            vm.prank(actors[i]);
            vault.setCaps(30e6, 30e6);
        }
    }

    function setUp() public override {}

    function vaultAddress() external view returns (address) {
        return address(vault);
    }

    function reserveOf(address actor) external view returns (uint256) {
        return vault.reserveOf(actor);
    }

    function balanceOf(address actor) external view returns (uint256) {
        return vault.buyerState(actor).balance;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        BuyerView memory v = vault.buyerState(actor);
        if (v.withdrawRequestedAt != 0 || v.balance >= vault.BETA_CAP()) return;
        _fund(actor, bound(amount, 1, vault.BETA_CAP() - v.balance));
    }

    function setCaps(uint256 actorSeed, uint128 hourly, uint128 daily) external {
        hourly = hourly % 8 == 0 ? 0 : uint128(bound(hourly, 1e6, 100e6));
        if (daily % 3 == 0) daily = 0;
        else if (daily % 3 == 1) daily = hourly;
        else daily = uint128(bound(daily, hourly, 200e6));
        vm.prank(_actor(actorSeed));
        vault.setCaps(hourly, daily);
    }

    /// Admission from the router spec: lower of current and pending caps, and never beyond the balance.
    function serve(uint256 actorSeed, uint128 amount) external {
        address actor = _actor(actorSeed);
        BuyerView memory v = vault.buyerState(actor);
        if (v.withdrawRequestedAt != 0 || v.usagePaused) return;
        uint64 hour = HourMath.hourOf(block.timestamp);
        uint64 day = HourMath.dayOf(hour);
        uint128 hourlyCap = v.hourlyCap;
        uint128 dailyCap = v.dailyCap;
        if (v.capsEffectiveAfterHour != 0) {
            hourlyCap = _lesser(hourlyCap, v.pendingHourlyCap);
            dailyCap = _lesser(dailyCap, v.pendingDailyCap);
        }
        uint256 room = _lesser256(_room(hourlyCap, _hourSpend[actor][hour]), _room(dailyCap, _daySpend[actor][day]));
        if (v.balance > unsettled[actor]) room = _lesser256(room, v.balance - unsettled[actor]);
        else room = 0;
        if (room == 0) return;
        uint128 served = uint128(bound(amount, room * 9 / 10, room));
        if (served == 0) return;
        _hourSpend[actor][hour] += served;
        _hourLastTs[actor][hour] = uint64(block.timestamp);
        _daySpend[actor][day] += served;
        unsettled[actor] += served;
        servedTotal += served;
    }

    function withdrawEverythingAllowed(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        BuyerView memory v = vault.buyerState(actor);
        uint256 available = v.balance - v.reserve;
        vm.prank(actor);
        vault.withdraw(available);
        if (available > 0 && v.reserve > 0) ++fullCapWithdrawals;
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
        bool settled = vault.lastSettledHour() >= HourMath.hourOf(v.withdrawRequestedAt);
        if (!settled && block.timestamp < v.withdrawDueAt) return;
        if (!settled) exitedLate[actor] = true;
        vault.executeWithdrawAll(actor);
    }

    function warp(uint256 secondsAhead) external {
        uint256 before = block.timestamp / 1 days;
        vm.warp(block.timestamp + bound(secondsAhead, 1, 2 hours));
        if (block.timestamp / 1 days != before) ++midnightCrossings;
    }

    function settleNext(uint256 feeShare) external {
        uint64 hour = _nextHour();
        if (block.timestamp < HourMath.hourEnd(hour) + vault.HOUR_CLOSE_GRACE()) return;
        Debit[] memory debits = _debitsFor(hour);
        uint256 total;
        for (uint256 i; i < debits.length; ++i) {
            total += debits[i].amount;
            address actor = debits[i].buyer;
            if (debits[i].amount > vault.buyerState(actor).balance && !exitedLate[actor]) unexpectedClamp = true;
            unsettled[actor] -= debits[i].amount;
        }
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, debits, uint128(total * (100 - feeShare % 100) / 100));
        if (debits.length == 0) {
            t.records = 0;
            _seal(b, t);
        }
        _settle(b, t);
        ++settleCount;
    }

    function _debitsFor(uint64 hour) private view returns (Debit[] memory debits) {
        Debit[] memory all = new Debit[](ACTORS);
        uint256 count;
        for (uint256 i; i < ACTORS; ++i) {
            address actor = actors[i];
            uint128 amount = _hourSpend[actor][hour];
            if (amount == 0) continue;
            all[count++] = Debit({buyer: actor, amount: amount, lastTs: _hourLastTs[actor][hour]});
        }
        debits = new Debit[](count);
        for (uint256 i; i < count; ++i) {
            debits[i] = all[i];
        }
    }

    function _room(uint128 cap, uint128 spent) private pure returns (uint256) {
        return cap > spent ? cap - spent : 0;
    }

    function _lesser(uint128 a, uint128 b) private pure returns (uint128) {
        return a < b ? a : b;
    }

    function _lesser256(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % ACTORS];
    }
}
