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

    function toggleSettleHalt() external {
        settlesHalted = !settlesHalted;
        vm.prank(guardian);
        vault.setSettlesPaused(settlesHalted);
    }

    function fundReserve(uint256 amount) external {
        _fundReserve(bound(amount, 0, 100e6));
    }

    function fundAgentPool(uint256 amount) external {
        _fundAgentPool(bound(amount, 0, 100e6));
    }

    function refundFromReserve(uint256 actorSeed, uint256 amount) external {
        if (settlesHalted) return;
        RefundBatch memory r;
        r.batchId = uint64(settleCount);
        r.refunds = new Refund[](1);
        r.refunds[0] = Refund({
            payer: _actor(actorSeed),
            amount: uint128(bound(amount, 0, vault.protocolReserve())),
            refundId: keccak256(abi.encode("refund", ++refundCount))
        });
        vault.refund(r, _thresholdSig(_settlementDigest(Typehashes.hash(r))));
    }

    /// Settles the next hour with debits a router obeying caps and exits would produce.
    function settleNext(uint256 seed, uint256 poolDraw, uint256 reserveDraw, uint256 feeShare) external {
        if (settlesHalted) return;
        uint64 hour = _nextHour();
        _warpPast(hour);
        Debit[] memory debits = _honestDebits(hour, seed);
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, debits, 0);
        b.agentPoolDraw = uint128(bound(poolDraw, 0, vault.agentPool()));
        b.reserveDraw = uint128(bound(reserveDraw, 0, vault.protocolReserve()));
        uint256 total = uint256(t.prepaidDebit) + b.agentPoolDraw + b.reserveDraw;
        b.fees = uint128(total * bound(feeShare, 0, 100) / 100);
        uint256 credit = total - b.fees;
        if (credit > 0) {
            b.credits = new Credit[](2);
            b.credits[0] = Credit({host: hostA, amount: uint128(credit / 3)});
            b.credits[1] = Credit({host: hostB, amount: uint128(credit - credit / 3)});
        }
        if (debits.length == 0 && total == 0) {
            t.records = 0;
            _seal(b, t);
        }
        vm.recordLogs();
        _settle(b, t);
        _onSettled(vm.getRecordedLogs());
        ghostLastSettled = hour;
        ++settleCount;
    }

    function _onSettled(Vm.Log[] memory logs) internal virtual {}

    /// A debit dated after a pending exit must never be accepted, whatever else the batch gets right.
    function attemptBadDebit(uint256 actorSeed, uint256 offset) external {
        address actor = _actor(actorSeed);
        BuyerView memory v = vault.buyerState(actor);
        if (settlesHalted || v.withdrawRequestedAt == 0) return;
        uint64 hour = _nextHour();
        _warpPast(hour);
        uint256 hourStart = uint256(hour) * 3600;
        uint256 earliest = v.withdrawRequestedAt + 1 > hourStart ? v.withdrawRequestedAt + 1 : hourStart;
        if (earliest >= hourStart + 3600) return;
        uint64 lastTs = uint64(bound(offset, earliest, hourStart + 3599));
        (uint128 hourlyCap,) = vault.effectiveCaps(actor, hour);
        if (hourlyCap == 0) return;
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(actor, 1, lastTs), 0);
        bytes memory sig = _signBatch(b);
        try vault.settle(b, t, sig) {
            badDebitAccepted = true;
        } catch {}
    }

    function _honestDebits(uint64 hour, uint256 seed) private returns (Debit[] memory debits) {
        Debit[] memory all = new Debit[](ACTORS);
        uint256 count;
        uint64 day = HourMath.dayOf(hour);
        for (uint256 i; i < ACTORS; ++i) {
            address actor = _sorted(i);
            BuyerView memory v = vault.buyerState(actor);
            uint256 hourStart = uint256(hour) * 3600;
            if (v.withdrawRequestedAt != 0 && v.withdrawRequestedAt < hourStart) continue;
            (uint128 hourlyCap, uint128 dailyCap) = vault.effectiveCaps(actor, hour);
            uint128 room = dailyCap - _lesser(dailyCap, _debitedOnDay[actor][day]);
            uint128 limit = _lesser(hourlyCap, room);
            if (limit == 0) continue;
            uint128 amount = uint128(uint256(keccak256(abi.encode(seed, i))) % (uint256(limit) + 1));
            if (amount == 0) continue;
            if (amount > v.balance) ++clampCount;
            _debitedOnDay[actor][day] += amount;
            all[count++] = Debit({buyer: actor, amount: amount, lastTs: uint64(hourStart)});
        }
        debits = new Debit[](count);
        for (uint256 i; i < count; ++i) {
            debits[i] = all[i];
        }
    }

    function _lesser(uint128 a, uint128 b) private pure returns (uint128) {
        return a < b ? a : b;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % ACTORS];
    }

    /// `actors` is declared in ascending order, which batches require.
    function _sorted(uint256 i) private view returns (address) {
        return actors[i];
    }
}
