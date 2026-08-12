// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OffpeakVault} from "../../src/OffpeakVault.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {HourMath} from "../../src/lib/HourMath.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

contract OffpeakVaultFuzzTest is VaultFixture {
    address internal buyer = address(0x1000);
    address internal other = address(0x2000);

    function testFuzz_reserveMatchesTheFormula(uint256 balance, uint128 hourly, uint128 daily, uint16 hoursLate) public {
        balance = bound(balance, 1, 500e6);
        hourly = uint128(bound(hourly, 1, 1_000e6));
        daily = uint128(bound(daily, hourly, 10_000e6));
        hoursLate = uint16(bound(hoursLate, 0, 2_000));
        _fund(buyer, balance);
        vm.prank(buyer);
        vault.setCaps(hourly, daily);
        vm.warp(block.timestamp + uint256(hoursLate) * 1 hours);

        uint256 openHours = block.timestamp / 3600 - vault.lastSettledHour();
        uint256 openDays = block.timestamp / 86_400 - (uint256(vault.lastSettledHour()) + 1) / 24 + 1;
        uint256 expected = _min(_min(balance, uint256(hourly) * openHours), uint256(daily) * openDays);
        assertEq(vault.reserveOf(buyer), expected);
    }

    function testFuzz_withdrawingEverythingAvailableAlwaysWorks(uint256 balance, uint128 hourly, uint16 hoursLate) public {
        balance = bound(balance, 1, 500e6);
        hourly = uint128(bound(hourly, 0, 1_000e6));
        _fund(buyer, balance);
        vm.prank(buyer);
        vault.setCaps(hourly, 0);
        vm.warp(block.timestamp + uint256(hoursLate) * 1 hours);

        uint256 available = balance - vault.reserveOf(buyer);
        vm.prank(buyer);
        vault.withdraw(available);
        assertEq(usdg.balanceOf(buyer), available);
        assertEq(_balance(buyer), balance - available);
        assertEq(vault.reserveOf(buyer), balance - available, "the reserve is what stays behind");
    }

    function testFuzz_reserveNeverOverflowsAtExtremeCaps(uint128 hourly, uint128 daily, uint32 hoursLate) public {
        hourly = uint128(bound(hourly, 1, type(uint128).max / 4));
        _fund(buyer, 1);
        vm.prank(buyer);
        vault.setCaps(hourly, daily);
        vm.warp(block.timestamp + uint256(hoursLate) * 1 hours);
        assertLe(vault.reserveOf(buyer), 1);
    }

    function testFuzz_decreaseHoldsTheOldCapUntilItsHourSettles(uint128 oldCap, uint128 newCap) public {
        oldCap = uint128(bound(oldCap, 2, 400e6));
        newCap = uint128(bound(newCap, 0, oldCap - 1));
        uint64 hour = uint64(block.timestamp / 3600);
        _fundWithCaps(buyer, 500e6, oldCap);
        vm.prank(buyer);
        vault.setCaps(newCap, 0);

        (uint128 inRequestHour,) = vault.effectiveCaps(buyer, hour);
        (uint128 afterRequestHour,) = vault.effectiveCaps(buyer, hour + 1);
        assertEq(inRequestHour, oldCap);
        assertEq(afterRequestHour, newCap);
        assertEq(vault.reserveOf(buyer), oldCap);

        _settleEmptyThrough(hour);
        assertEq(vault.buyerState(buyer).hourlyCap, newCap);
    }

    function testFuzz_noDebitAfterTheRequestTime(uint16 requestOffset, uint16 debitOffset) public {
        uint64 hour = uint64(block.timestamp / 3600);
        _fundWithCaps(buyer, 50e6, 10e6);
        _settleEmptyThrough(hour - 1);
        uint256 requestAt = uint256(hour) * 3600 + bound(requestOffset, 0, 3598);
        uint256 debitAt = bound(uint256(debitOffset), requestAt + 1, uint256(hour) * 3600 + 3599);
        vm.warp(requestAt);
        vm.prank(buyer);
        vault.requestWithdrawAll();

        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(buyer, 1e6, uint64(debitAt)), 1e6);
        _warpPast(hour);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(
            abi.encodeWithSelector(OffpeakVault.DebitAfterRequest.selector, buyer, uint64(debitAt), uint64(requestAt))
        );
        vault.settle(b, t, sig);
    }

    struct SettleSeeds {
        uint96 balanceA;
        uint96 balanceB;
        uint96 debitA;
        uint96 debitB;
        uint96 pool;
        uint96 reserve;
        uint96 poolDraw;
        uint96 reserveDraw;
        uint96 fees;
        uint96 splitToB;
    }

    /// Any mix of clamped debits, agent draws and reserve draws keeps the vault's books equal to its USDG.
    function testFuzz_settleConserves(SettleSeeds memory s) public {
        uint128 cap = 200e6;
        _fundWithCaps(buyer, bound(s.balanceA, 1, 300e6), cap);
        _fundWithCaps(other, bound(s.balanceB, 1, 300e6), cap);
        uint256 pool = bound(s.pool, 0, 1_000e6);
        uint256 reserve = bound(s.reserve, 0, 1_000e6);
        uint256 supply = _balance(buyer) + _balance(other) + pool + reserve;
        if (pool > 0) _fundAgentPool(pool);
        if (reserve > 0) _fundReserve(reserve);

        (SettleBatch memory b, RootTotals memory t) = _clampableBatch(s, cap, pool, reserve);
        _settle(b, t);

        uint256 books = _balance(buyer) + _balance(other) + vault.agentPool() + vault.protocolReserve();
        assertEq(usdg.balanceOf(address(vault)), books, "vault USDG equals its liabilities");
        assertEq(
            usdg.balanceOf(address(registry)) + usdg.balanceOf(address(splitter)) + books,
            supply,
            "no USDG is created or lost"
        );
    }

    function _clampableBatch(SettleSeeds memory s, uint128 cap, uint256 pool, uint256 reserve)
        private
        view
        returns (SettleBatch memory b, RootTotals memory t)
    {
        uint64 hour = _nextHour();
        Debit[] memory debits = new Debit[](2);
        uint64 lastTs = uint64(uint256(hour) * 3600);
        debits[0] = Debit({buyer: buyer, amount: uint128(bound(s.debitA, 1, cap)), lastTs: lastTs});
        debits[1] = Debit({buyer: other, amount: uint128(bound(s.debitB, 1, cap)), lastTs: lastTs});
        (b, t) = _batch(hour, debits, 0);
        b.agentPoolDraw = uint128(bound(s.poolDraw, 0, pool));
        b.reserveDraw = uint128(bound(s.reserveDraw, 0, reserve));
        uint256 total = uint256(debits[0].amount) + debits[1].amount + b.agentPoolDraw + b.reserveDraw;
        b.fees = uint128(bound(s.fees, 0, total));
        uint256 credit = total - b.fees;
        uint256 toB = bound(s.splitToB, 0, credit);
        b.credits = new Credit[](2);
        b.credits[0] = Credit({host: hostA, amount: uint128(credit - toB)});
        b.credits[1] = Credit({host: hostB, amount: uint128(toB)});
    }

    function testFuzz_hourMathMatchesTheInterface(uint64 ts) public pure {
        uint64 hour = HourMath.hourOf(ts);
        assertEq(hour, ts / 3600);
        assertEq(HourMath.hourEnd(hour), (uint256(ts) / 3600 + 1) * 3600);
        assertEq(HourMath.dayOf(hour), ts / 86_400);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
