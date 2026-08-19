// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OffpeakVault} from "../../src/OffpeakVault.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "../../src/interfaces/IOffpeakVault.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {IUsageLedger} from "../../src/interfaces/IUsageLedger.sol";
import {IWindowMarket} from "../../src/interfaces/IWindowMarket.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {ThresholdSig} from "../../src/lib/ThresholdSig.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

contract OffpeakVaultTest is VaultFixture {
    address internal buyer = address(0x1000);
    address internal other = address(0x2000);
    uint128 internal constant CAP = 10e6;

    // Deposits

    function test_depositCreditsBalanceAndEmits() public {
        usdg.mint(buyer, 5e6);
        vm.startPrank(buyer);
        usdg.approve(address(vault), 5e6);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.Deposited(buyer, 5e6, 5e6);
        vault.deposit(5e6);
        vm.stopPrank();
        assertEq(_balance(buyer), 5e6);
        assertEq(usdg.balanceOf(address(vault)), 5e6);
    }

    function test_depositBlockedWhileWithdrawPending() public {
        _fund(buyer, 5e6);
        vm.startPrank(buyer);
        vault.requestWithdrawAll();
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WithdrawPending.selector, buyer));
        vault.deposit(1);
    }

    function test_cancelReopensDeposits() public {
        _fund(buyer, 5e6);
        vm.startPrank(buyer);
        vault.requestWithdrawAll();
        vault.cancelWithdrawAll();
        vm.stopPrank();
        _fund(buyer, 1e6);
        assertEq(_balance(buyer), 6e6);
    }

    function test_betaCapAllowsExactly500Usdg() public {
        _fund(buyer, 500e6);
        usdg.mint(buyer, 1);
        vm.startPrank(buyer);
        usdg.approve(address(vault), 1);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.BetaCapExceeded.selector, buyer, 500e6 + 1));
        vault.deposit(1);
    }

    function test_disableBetaCapIsOwnerOnlyAndLiftsTheCap() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.disableBetaCap();
        vm.prank(owner);
        vault.disableBetaCap();
        assertFalse(vault.betaCapEnabled());
        _fund(buyer, 1_000e6);
        assertEq(_balance(buyer), 1_000e6);
    }

    function test_depositWithPermit2UsesTheRealContract() public {
        (address signer, uint256 key) = makeAddrAndKey("permit-buyer");
        usdg.mint(signer, 7e6);
        vm.prank(signer);
        usdg.approve(PERMIT2, type(uint256).max);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(address(usdg), 7e6);
        bytes memory sig = _permitSig(key, p);

        vm.prank(signer);
        vault.depositWithPermit2(p, sig);
        assertEq(_balance(signer), 7e6);
        assertEq(usdg.balanceOf(address(vault)), 7e6);
    }

    function test_depositWithPermit2RejectsOtherTokens() public {
        ISignatureTransfer.PermitTransferFrom memory p = _permit(address(ofpk), 1);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WrongToken.selector, address(ofpk)));
        vault.depositWithPermit2(p, "");
    }

    // Caps

    function test_setCapsDefaultsDailyToFourTimesHourly() public {
        vm.prank(buyer);
        vault.setCaps(CAP, 0);
        BuyerView memory v = vault.buyerState(buyer);
        assertEq(v.hourlyCap, CAP);
        assertEq(v.dailyCap, 4 * CAP);
    }

    function test_increaseAppliesImmediately() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.CapsChanged(buyer, 2 * CAP, 8 * CAP);
        vm.prank(buyer);
        vault.setCaps(2 * CAP, 0);
        assertEq(vault.buyerState(buyer).hourlyCap, 2 * CAP);
        assertEq(vault.buyerState(buyer).capsEffectiveAfterHour, 0);
    }

    function test_decreaseStaysPendingUntilItsHourSettles() public {
        _fundWithCaps(buyer, 50e6, CAP);
        uint64 hour = uint64(block.timestamp / 3600);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.CapsChangeRequested(buyer, CAP / 2, 2 * CAP, hour);
        vm.prank(buyer);
        vault.setCaps(CAP / 2, 0);

        BuyerView memory v = vault.buyerState(buyer);
        assertEq(v.hourlyCap, CAP);
        assertEq(v.pendingHourlyCap, CAP / 2);
        assertEq(v.capsEffectiveAfterHour, hour);
        (uint128 hourly,) = vault.effectiveCaps(buyer, hour);
        assertEq(hourly, CAP);
        (hourly,) = vault.effectiveCaps(buyer, hour + 1);
        assertEq(hourly, CAP / 2);

        _settleEmptyThrough(hour);
        v = vault.buyerState(buyer);
        assertEq(v.hourlyCap, CAP / 2);
        assertEq(v.pendingHourlyCap, 0);
        assertEq(v.capsEffectiveAfterHour, 0);
    }

    function test_decreaseToZeroIsRepresentable() public {
        _fundWithCaps(buyer, 50e6, CAP);
        uint64 hour = uint64(block.timestamp / 3600);
        vm.prank(buyer);
        vault.setCaps(0, 0);
        assertEq(vault.buyerState(buyer).hourlyCap, CAP);
        assertEq(vault.buyerState(buyer).capsEffectiveAfterHour, hour);

        _settleEmptyThrough(hour);
        assertEq(vault.buyerState(buyer).hourlyCap, 0);
        assertEq(vault.buyerState(buyer).dailyCap, 0);
    }

    function test_mixedChangeRaisesOneCapAndHoldsTheOther() public {
        _fundWithCaps(buyer, 50e6, CAP);
        uint64 hour = uint64(block.timestamp / 3600);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.CapsChanged(buyer, CAP, 8 * CAP);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.CapsChangeRequested(buyer, CAP / 2, 8 * CAP, hour);
        vm.prank(buyer);
        vault.setCaps(CAP / 2, 8 * CAP);

        assertEq(vault.buyerState(buyer).hourlyCap, CAP);
        assertEq(vault.buyerState(buyer).dailyCap, 8 * CAP);
        _settleEmptyThrough(hour);
        assertEq(vault.buyerState(buyer).hourlyCap, CAP / 2);
        assertEq(vault.buyerState(buyer).dailyCap, 8 * CAP);
    }

    function test_raisingAgainClearsAPendingDecrease() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.startPrank(buyer);
        vault.setCaps(CAP / 2, 0);
        vault.setCaps(CAP, 0);
        vm.stopPrank();
        assertEq(vault.buyerState(buyer).capsEffectiveAfterHour, 0);
        assertEq(vault.buyerState(buyer).pendingHourlyCap, 0);
    }

    // Reserve and withdraw

    function test_reserveIsZeroWithNoBalance() public {
        vm.prank(buyer);
        vault.setCaps(CAP, 0);
        assertEq(vault.reserveOf(buyer), 0);
    }

    function test_reserveCountsEveryOpenHourIncludingTheCurrentOne() public {
        _fundWithCaps(buyer, 200e6, CAP);
        assertEq(vault.reserveOf(buyer), CAP);
        vm.warp(block.timestamp + 2 hours);
        assertEq(vault.reserveOf(buyer), 3 * CAP);
    }

    function test_reserveIsLimitedByBalance() public {
        _fundWithCaps(buyer, 5e6, CAP);
        assertEq(vault.reserveOf(buyer), 5e6);
    }

    function test_reserveIsLimitedByTheDailyCapPerOpenDay() public {
        _fund(buyer, 500e6);
        vm.prank(buyer);
        vault.setCaps(CAP, 2 * CAP);
        vm.warp(block.timestamp + 5 hours);
        assertEq(vault.reserveOf(buyer), 2 * CAP);
        vm.warp(block.timestamp + 24 hours);
        assertEq(vault.reserveOf(buyer), 4 * CAP);
    }

    function test_reserveHoldsOneDailyCapPerUtcDayTouched() public {
        uint64 lastBeforeMidnight = (uint64(block.timestamp / 3600) / 24 + 1) * 24 - 1;
        _settleEmptyThrough(lastBeforeMidnight - 1);
        _fund(buyer, 100e6);
        vm.prank(buyer);
        vault.setCaps(CAP, CAP);
        vm.warp(uint256(lastBeforeMidnight + 1) * 3600 + 60);
        assertEq(block.timestamp / 3600 - vault.lastSettledHour(), 2, "two open hours");
        assertEq(vault.reserveOf(buyer), 2 * CAP, "each hour can spend that day's whole cap");

        vm.prank(buyer);
        vault.withdraw(100e6 - 2 * CAP);
        (SettleBatch memory b, RootTotals memory t) =
            _batch(lastBeforeMidnight, _oneDebit(buyer, CAP, uint64(uint256(lastBeforeMidnight) * 3600)), CAP);
        _settle(b, t);
        uint64 firstOfDay = lastBeforeMidnight + 1;
        (b, t) = _batch(firstOfDay, _oneDebit(buyer, CAP, uint64(uint256(firstOfDay) * 3600)), CAP);
        _settle(b, t);
        assertEq(_balance(buyer), 0);
        assertEq(usdg.balanceOf(address(registry)), 2 * CAP, "both days settle in full");
    }

    function test_withdrawUpToAvailable() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.prank(buyer);
        vault.withdraw(40e6);
        assertEq(_balance(buyer), 10e6);
        assertEq(usdg.balanceOf(buyer), 40e6);
    }

    function test_withdrawAboveAvailableReverts() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WithdrawExceedsAvailable.selector, 40e6 + 1, 40e6));
        vault.withdraw(40e6 + 1);
    }

    function test_withdrawWorksWhilePaused() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.startPrank(guardian);
        vault.setUsagePaused(true);
        vault.setSettlesPaused(true);
        vm.stopPrank();
        vm.prank(buyer);
        vault.withdraw(40e6);
        assertEq(usdg.balanceOf(buyer), 40e6);
    }

    // Withdraw-all

    function test_requestEmitsTheTwoHourDueTime() public {
        vm.expectEmit(address(vault));
        emit IOffpeakVault.WithdrawAllRequested(buyer, uint64(START), uint64(START + 7200));
        vm.prank(buyer);
        vault.requestWithdrawAll();
        assertEq(vault.buyerState(buyer).withdrawDueAt, START + 7200);
    }

    function test_requestTwiceReverts() public {
        vm.startPrank(buyer);
        vault.requestWithdrawAll();
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WithdrawAlreadyRequested.selector, buyer));
        vault.requestWithdrawAll();
    }

    function test_cancelWithoutRequestReverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.NoWithdrawRequest.selector, buyer));
        vault.cancelWithdrawAll();
    }

    function test_executeWithoutRequestReverts() public {
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.NoWithdrawRequest.selector, buyer));
        vault.executeWithdrawAll(buyer);
    }

    function test_executeRevertsOneSecondBeforeDue() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.prank(buyer);
        vault.requestWithdrawAll();
        vm.warp(START + 7199);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WithdrawNotDue.selector, buyer, uint64(START + 7200)));
        vault.executeWithdrawAll(buyer);
    }

    function test_executeAtExactlyTwoHoursWhileEverythingIsPaused() public {
        _fundWithCaps(buyer, 50e6, CAP);
        vm.prank(buyer);
        vault.requestWithdrawAll();
        vm.startPrank(guardian);
        vault.setUsagePaused(true);
        vault.setSettlesPaused(true);
        vm.stopPrank();
        vm.warp(START + 7200);
        vm.prank(other);
        vault.executeWithdrawAll(buyer);
        assertEq(usdg.balanceOf(buyer), 50e6);
        assertEq(_balance(buyer), 0);
        assertEq(vault.buyerState(buyer).withdrawRequestedAt, 0);
    }

    function test_executeAsSoonAsTheRequestHourSettles() public {
        _fundWithCaps(buyer, 50e6, CAP);
        uint64 hour = uint64(block.timestamp / 3600);
        vm.prank(buyer);
        vault.requestWithdrawAll();
        _settleEmptyThrough(hour);
        assertLt(block.timestamp, START + 7200);
        vault.executeWithdrawAll(buyer);
        assertEq(usdg.balanceOf(buyer), 50e6);
    }

    // Section 4.1 required scenarios

    function test_requestHourRule() public {
        uint64 hour = uint64(block.timestamp / 3600);
        _fundWithCaps(buyer, 50e6, CAP);
        _settleEmptyThrough(hour - 1);
        uint256 requestAt = uint256(hour) * 3600 + 3540;
        vm.warp(requestAt);
        vm.prank(buyer);
        vault.requestWithdrawAll();

        (SettleBatch memory late, RootTotals memory lateTotals) =
            _batch(hour, _oneDebit(buyer, CAP, uint64(requestAt + 1)), CAP - 1);
        _warpPast(hour);
        bytes memory lateSig = _signBatch(late);
        vm.expectRevert(
            abi.encodeWithSelector(
                OffpeakVault.DebitAfterRequest.selector, buyer, uint64(requestAt + 1), uint64(requestAt)
            )
        );
        vault.settle(late, lateTotals, lateSig);

        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(buyer, CAP, uint64(requestAt)), CAP - 1);
        _settle(b, t);
        assertEq(_balance(buyer), 50e6 - CAP);

        (SettleBatch memory next, RootTotals memory nextTotals) =
            _batch(hour + 1, _oneDebit(buyer, 1, uint64((uint256(hour) + 1) * 3600)), 0);
        _warpPast(hour + 1);
        bytes memory nextSig = _signBatch(next);
        vm.expectRevert(
            abi.encodeWithSelector(
                OffpeakVault.DebitAfterRequest.selector, buyer, uint64((uint256(hour) + 1) * 3600), uint64(requestAt)
            )
        );
        vault.settle(next, nextTotals, nextSig);

        vault.executeWithdrawAll(buyer);
        assertEq(usdg.balanceOf(buyer), 50e6 - CAP);
    }

    function test_lateSettlementClampsAndFeesThenReserveCover() public {
        uint64 hour = uint64(block.timestamp / 3600);
        _fundWithCaps(buyer, 50e6, CAP);
        _settleEmptyThrough(hour - 1);
        _fundReserve(CAP);
        vm.prank(buyer);
        vault.requestWithdrawAll();
        uint256 requestedAt = block.timestamp;

        vm.prank(guardian);
        vault.setSettlesPaused(true);
        vm.warp(requestedAt + 7200);
        vault.executeWithdrawAll(buyer);
        assertEq(usdg.balanceOf(buyer), 50e6);
        vm.prank(guardian);
        vault.setSettlesPaused(false);

        uint128 credit = CAP - 1e6;
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(buyer, CAP, uint64(requestedAt)), credit);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.DebitClamped(hour, buyer, CAP, 0);
        _settle(b, t);

        assertEq(usdg.balanceOf(address(registry)), credit);
        assertEq(usdg.balanceOf(address(splitter)), 0, "fees go first");
        assertEq(vault.protocolReserve(), CAP - credit, "the reserve covers the rest");
        assertEq(usdg.balanceOf(address(vault)), vault.protocolReserve(), "vault conservation");
    }

    function test_capDecreaseThenWithdrawCannotLeaveUnpaidUsage() public {
        uint64 hour = uint64(block.timestamp / 3600);
        _fundWithCaps(buyer, 50e6, CAP);
        _settleEmptyThrough(hour - 1);

        vm.startPrank(buyer);
        vault.setCaps(1e6, 0);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WithdrawExceedsAvailable.selector, 49e6, 40e6));
        vault.withdraw(49e6);
        vault.withdraw(40e6);
        vm.stopPrank();
        assertEq(_balance(buyer), CAP, "the reserve still holds the old cap");

        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(buyer, CAP, uint64(block.timestamp)), CAP);
        vm.recordLogs();
        _settle(b, t);
        assertEq(_balance(buyer), 0);
        assertEq(usdg.balanceOf(address(registry)), CAP, "served usage at the old cap settles in full");
        assertEq(vault.buyerState(buyer).hourlyCap, 1e6);
    }

    // settle: authorisation and batch shape

    function test_settleRejectsWhilePaused() public {
        vm.prank(guardian);
        vault.setSettlesPaused(true);
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _warpPast(b.hour);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(OffpeakVault.SettlesPaused.selector);
        vault.settle(b, t, sig);
    }

    function test_settleRejectsAnotherChainOrVault() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _warpPast(b.hour);
        b.chainId = 1;
        bytes memory sig = _signBatch(b);
        vm.expectRevert(OffpeakVault.WrongBatchTarget.selector);
        vault.settle(b, t, sig);

        b.chainId = CHAIN_ID;
        b.vault = address(1);
        sig = _signBatch(b);
        vm.expectRevert(OffpeakVault.WrongBatchTarget.selector);
        vault.settle(b, t, sig);
    }

    function test_settleIsStrictlySequential() public {
        uint64 next = _nextHour();
        (SettleBatch memory skip, RootTotals memory t) = _emptyBatch(next + 1);
        _warpPast(next + 1);
        bytes memory sig = _signBatch(skip);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WrongHour.selector, next + 1, next));
        vault.settle(skip, t, sig);

        (SettleBatch memory b, RootTotals memory totals) = _emptyBatch(next);
        _settle(b, totals);
        sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.WrongHour.selector, next, next + 1));
        vault.settle(b, totals, sig);
    }

    function test_settleWaitsForTheCloseGrace() public {
        uint64 next = _nextHour();
        uint256 readyAt = (uint256(next) + 1) * 3600 + 600;
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(next);
        bytes memory sig = _signBatch(b);
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.HourNotReady.selector, next, readyAt));
        vault.settle(b, t, sig);
        vm.warp(readyAt);
        vault.settle(b, t, sig);
        assertEq(vault.lastSettledHour(), next);
    }

    function test_settleRejectsBadSignatures() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _warpPast(b.hour);
        bytes32 digest = _settlementDigest(Typehashes.hash(b));

        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        vault.settle(b, t, _sig(settlerKeys[0], digest));

        (, uint256 outsider) = makeAddrAndKey("outsider");
        bytes memory two = bytes.concat(_sig(settlerKeys[0], digest), _sig(outsider, digest));
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        vault.settle(b, t, two);

        bytes memory sig = _signBatch(b);
        b.fees = 1;
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        vault.settle(b, t, sig);
    }

    function test_settleRejectsTotalsThatDoNotHashToTheBatch() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _warpPast(b.hour);
        bytes memory sig = _signBatch(b);
        bytes32 expected = b.totalsHash;
        t.tokensIn = 1;
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.TotalsHashMismatch.selector, expected, Typehashes.hash(t)));
        vault.settle(b, t, sig);
    }

    function test_settleEnforcesBatchLimits() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _warpPast(b.hour);
        b.debits = new Debit[](2001);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.BatchTooLarge.selector, 2001, 2000));
        vault.settle(b, t, sig);
    }

    function test_settleChecksDebitsAgainstTotals() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 1e6, _inHour(next)), 1e6);
        t.prepaidDebit = 2e6;
        t.hostCredit = 2e6;
        b.credits[0].amount = 2e6;
        _seal(b, t);
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.DebitTotalMismatch.selector, 1e6, uint128(2e6)));
        vault.settle(b, t, sig);
    }

    function test_settleRequiresSortedUniqueDebits() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        _fundWithCaps(other, 50e6, CAP);
        Debit[] memory debits = new Debit[](2);
        debits[0] = Debit({buyer: other, amount: 1e6, lastTs: _inHour(next)});
        debits[1] = Debit({buyer: buyer, amount: 1e6, lastTs: _inHour(next)});
        (SettleBatch memory b, RootTotals memory t) = _batch(next, debits, 2e6);
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(OffpeakVault.NotSorted.selector);
        vault.settle(b, t, sig);

        debits[0] = Debit({buyer: buyer, amount: 1e6, lastTs: _inHour(next)});
        (b, t) = _batch(next, debits, 2e6);
        sig = _signBatch(b);
        vm.expectRevert(OffpeakVault.NotSorted.selector);
        vault.settle(b, t, sig);
    }

    function test_settleRequiresSortedUniqueCredits() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 2e6, _inHour(next)), 2e6);
        b.credits = new Credit[](2);
        b.credits[0] = Credit({host: hostB, amount: 1e6});
        b.credits[1] = Credit({host: hostA, amount: 1e6});
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(OffpeakVault.NotSorted.selector);
        vault.settle(b, t, sig);
    }

    function test_settleRejectsZeroDebits() public {
        uint64 next = _nextHour();
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 0, _inHour(next)), 0);
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.ZeroDebit.selector, buyer));
        vault.settle(b, t, sig);
    }

    function test_settleRejectsDebitsFromAnotherHour() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        uint64 wrong = _inHour(next + 1);
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 1e6, wrong), 1e6);
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.DebitOutsideHour.selector, buyer, wrong, next));
        vault.settle(b, t, sig);
    }

    function test_settleEnforcesTheHourlyCap() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, CAP + 1, _inHour(next)), CAP + 1);
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.CapExceeded.selector, buyer, next, CAP + 1, CAP));
        vault.settle(b, t, sig);
    }

    function test_settleEnforcesTheDailyCapAndRollsItOver() public {
        uint64 dayStart = (_nextHour() / 24 + 1) * 24;
        _settleEmptyThrough(dayStart - 1);
        _fund(buyer, 100e6);
        vm.prank(buyer);
        vault.setCaps(CAP, CAP + 1e6);

        (SettleBatch memory b, RootTotals memory t) = _batch(dayStart, _oneDebit(buyer, CAP, _inHour(dayStart)), CAP);
        _settle(b, t);

        uint64 second = dayStart + 1;
        (b, t) = _batch(second, _oneDebit(buyer, 2e6, _inHour(second)), 2e6);
        _warpPast(second);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(
            abi.encodeWithSelector(OffpeakVault.DailyCapExceeded.selector, buyer, dayStart / 24, CAP + 2e6, CAP + 1e6)
        );
        vault.settle(b, t, sig);

        _settleEmptyThrough(dayStart + 23);
        uint64 nextDay = dayStart + 24;
        (b, t) = _batch(nextDay, _oneDebit(buyer, CAP, _inHour(nextDay)), CAP);
        _settle(b, t);
        assertEq(_balance(buyer), 100e6 - 2 * CAP);
    }

    function test_settleEnforcesConservation() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 1e6, _inHour(next)), 1e6);
        b.fees = 1;
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.ConservationBroken.selector, 1e6, 1e6 + 1));
        vault.settle(b, t, sig);
    }

    function test_settleCannotOverdrawTheAgentPool() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _fundAgentPool(1e6 - 1);
        b.agentPoolDraw = 1e6;
        b.fees = 1e6;
        _warpPast(b.hour);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.InsufficientAgentPool.selector, 1e6 - 1, uint128(1e6)));
        vault.settle(b, t, sig);
    }

    function test_settleCannotOverdrawTheReserve() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        b.reserveDraw = 1e6;
        b.fees = 1e6;
        _warpPast(b.hour);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.InsufficientProtocolReserve.selector, 0, uint256(1e6)));
        vault.settle(b, t, sig);
    }

    // settle: effects

    function test_settleMovesEverythingAndPostsTheRoot() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 50e6, CAP);
        _fundAgentPool(3e6);
        _fundReserve(1e6);

        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 4e6, _inHour(next)), 4e6);
        b.credits[0].amount = 7e6;
        b.fees = 1e6;
        b.agentPoolDraw = 3e6;
        b.reserveDraw = 1e6;
        _warpPast(next);
        bytes memory sig = _signBatch(b);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.Settled(next, b.root, b.totalsHash, 4e6, 7e6, 1e6);
        vault.settle(b, t, sig);

        assertEq(vault.lastSettledHour(), next);
        assertEq(_balance(buyer), 46e6);
        assertEq(vault.agentPool(), 0);
        assertEq(vault.protocolReserve(), 0);
        assertEq(usdg.balanceOf(address(registry)), 7e6);
        assertEq(usdg.balanceOf(address(splitter)), 1e6);
        assertEq(usdg.balanceOf(address(vault)), 46e6);
        (bytes32 root, bytes32 totalsHash) = ledger.rootOf(next);
        assertEq(root, b.root);
        assertEq(totalsHash, b.totalsHash);
    }

    function test_everyDebitEmitsThePerBuyerResult() public {
        uint64 next = _nextHour();
        _fundWithCaps(buyer, 6e6, CAP);
        (SettleBatch memory b, RootTotals memory t) = _batch(next, _oneDebit(buyer, 4e6, _inHour(next)), 4e6);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.Debited(next, buyer, 4e6, 4e6, 2e6);
        _settle(b, t);
        (uint64 day, uint128 debited) = vault.dayDebit(buyer);
        assertEq(day, next / 24);
        assertEq(debited, 4e6);
    }

    function test_emptyHourStillSettles() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _settle(b, t);
        assertEq(vault.lastSettledHour(), b.hour);
    }

    function test_windowDrawsReachTheMarket() public {
        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        b.windowDraws = new WindowDraw[](1);
        b.windowDraws[0] = WindowDraw({windowId: 9, holder: buyer, tokens: 42});
        // No such Window exists, so the market draws nothing, and the hour still lands.
        vm.expectEmit(address(windows));
        emit IWindowMarket.Drawn(9, buyer, 0, 0);
        _settle(b, t);
    }

    function test_shortfallBeyondFeesAndReserveReducesCreditsProRata() public {
        uint64 hour = uint64(block.timestamp / 3600);
        _fundWithCaps(buyer, 10e6, CAP);
        _settleEmptyThrough(hour - 1);
        vm.prank(buyer);
        vault.requestWithdrawAll();
        uint256 requestedAt = block.timestamp;
        vm.warp(requestedAt + 7200);
        vault.executeWithdrawAll(buyer);

        _fundReserve(1e6);
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(buyer, 10e6, uint64(requestedAt)), 9e6);
        b.credits = new Credit[](2);
        b.credits[0] = Credit({host: hostA, amount: 3e6});
        b.credits[1] = Credit({host: hostB, amount: 6e6});
        _warpPast(hour);
        bytes memory sig = _signBatch(b);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.CreditShortfall(hour, 8e6);
        vm.expectEmit(address(registry));
        emit IHostRegistry.CreditsAccrued(hostA, hour, 333_333, uint64(block.timestamp + 1 days));
        vm.expectEmit(address(registry));
        emit IHostRegistry.CreditsAccrued(hostB, hour, 666_666, uint64(block.timestamp + 1 days));
        vault.settle(b, t, sig);
        assertEq(usdg.balanceOf(address(registry)), 999_999);
        assertEq(vault.protocolReserve(), 1, "dust stays in the reserve");
        assertEq(usdg.balanceOf(address(vault)), 1);
    }

    // refund

    function test_refundPaysFromTheReserveIntoAWithdrawableBalance() public {
        _fundReserve(5e6);
        RefundBatch memory r = _refund(other, 2e6, "r1");
        vm.expectEmit(address(vault));
        emit IOffpeakVault.Refunded(other, 2e6, keccak256("r1"));
        vault.refund(r, _signRefund(r));
        assertEq(_balance(other), 2e6);
        assertEq(vault.protocolReserve(), 3e6);
        vm.prank(other);
        vault.withdraw(2e6);
        assertEq(usdg.balanceOf(other), 2e6);
    }

    function test_refundIdsPayOnce() public {
        _fundReserve(5e6);
        RefundBatch memory r = _refund(other, 2e6, "r1");
        bytes memory sig = _signRefund(r);
        vault.refund(r, sig);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.RefundAlreadyPaid.selector, keccak256("r1")));
        vault.refund(r, sig);
    }

    function test_refundCannotExceedTheReserve() public {
        RefundBatch memory r = _refund(other, 1, "r1");
        bytes memory sig = _signRefund(r);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.InsufficientProtocolReserve.selector, 0, uint256(1)));
        vault.refund(r, sig);
    }

    function test_refundNeedsTwoSigners() public {
        RefundBatch memory r = _refund(other, 1, "r1");
        bytes memory one = _sig(settlerKeys[0], _settlementDigest(Typehashes.hash(r)));
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        vault.refund(r, one);
    }

    function test_refundStopsWhenSettlesArePaused() public {
        _fundReserve(5e6);
        vm.prank(guardian);
        vault.setSettlesPaused(true);
        RefundBatch memory r = _refund(other, 1, "r1");
        bytes memory sig = _signRefund(r);
        vm.expectRevert(OffpeakVault.SettlesPaused.selector);
        vault.refund(r, sig);
    }

    function test_refundEnforcesTheBatchLimit() public {
        RefundBatch memory r;
        r.refunds = new Refund[](501);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.BatchTooLarge.selector, 501, 500));
        vault.refund(r, "");
    }

    // Roles

    function test_onlyPaymentContractsCreditTheAgentPool() public {
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.NotAgentPayer.selector, address(this)));
        vault.creditAgentPool(1, bytes32(0));
        vm.prank(channels);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.AgentPoolCredited(bytes32("id"), 1);
        vault.creditAgentPool(1, bytes32("id"));
        assertEq(vault.agentPool(), 1);
    }

    function test_onlyGuardianPauses() public {
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.NotGuardian.selector, address(this)));
        vault.setUsagePaused(true);
        vm.expectRevert(abi.encodeWithSelector(OffpeakVault.NotGuardian.selector, owner));
        vm.prank(owner);
        vault.setSettlesPaused(true);

        vm.expectEmit(address(vault));
        emit IOffpeakVault.Paused(true, false);
        vm.prank(guardian);
        vault.setUsagePaused(true);
        assertTrue(vault.buyerState(buyer).usagePaused);
    }

    function test_rotatedSignersReplaceTheOldSet() public {
        address[3] memory next = [address(0x11), address(0x22), address(0x33)];
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setSettlers(next);
        vm.prank(owner);
        vault.setSettlers(next);

        (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
        _warpPast(b.hour);
        bytes memory sig = _signBatch(b);
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        vault.settle(b, t, sig);
    }

    function test_signerSetsMustBeSortedAndDistinct() public {
        vm.startPrank(owner);
        vm.expectRevert(OffpeakVault.UnsortedSigners.selector);
        vault.setSettlers([address(0x22), address(0x11), address(0x33)]);
        vm.expectRevert(OffpeakVault.UnsortedSigners.selector);
        vault.setSettlers([address(0x11), address(0x11), address(0x33)]);
        vm.expectRevert(OffpeakVault.UnsortedSigners.selector);
        vault.setSettlers([address(0), address(0x11), address(0x33)]);
    }

    function test_constructorRejectsUnsortedSigners() public {
        vm.expectRevert(OffpeakVault.UnsortedSigners.selector);
        new OffpeakVault(
            owner,
            IERC20(address(usdg)),
            ISignatureTransfer(PERMIT2),
            IUsageLedger(address(ledger)),
            IHostRegistry(address(registry)),
            [address(0x22), address(0x11), address(0x33)],
            guardian
        );
    }

    function test_setPeersOnce() public {
        vm.prank(owner);
        vm.expectRevert(OffpeakVault.AlreadySet.selector);
        vault.setPeers(address(1), address(2), address(3), address(4));
    }

    function test_peersArriveWithTheirLaunchPhase() public {
        OffpeakVault fresh = new OffpeakVault(
            owner,
            IERC20(address(usdg)),
            ISignatureTransfer(PERMIT2),
            IUsageLedger(address(ledger)),
            IHostRegistry(address(registry)),
            settlers,
            guardian
        );
        vm.startPrank(owner);
        fresh.setPeers(address(0), address(2), address(0), address(0));
        assertEq(address(fresh.feeSplitter()), address(2));
        assertEq(fresh.x402Escrow(), address(0));

        fresh.setPeers(address(0), address(0), address(3), address(4));
        assertEq(fresh.x402Escrow(), address(3));
        assertEq(fresh.channelManager(), address(4));
        assertEq(address(fresh.feeSplitter()), address(2), "an empty slot in a later call changes nothing");

        vm.expectRevert(OffpeakVault.AlreadySet.selector);
        fresh.setPeers(address(0), address(9), address(0), address(0));
    }

    function test_setGuardianIsOwnerOnly() public {
        address next = makeAddr("next-guardian");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setGuardian(next);
        vm.prank(owner);
        vault.setGuardian(next);
        assertEq(vault.guardian(), next);
    }

    function _inHour(uint64 hour) private pure returns (uint64) {
        return uint64(uint256(hour) * 3600 + 5);
    }

    function _refund(address payer, uint128 amount, string memory id) private pure returns (RefundBatch memory r) {
        r.batchId = 1;
        r.refunds = new Refund[](1);
        r.refunds[0] = Refund({payer: payer, amount: amount, refundId: keccak256(bytes(id))});
    }

    function _signRefund(RefundBatch memory r) private view returns (bytes memory) {
        return _thresholdSig(_settlementDigest(Typehashes.hash(r)));
    }

    function _permit(address token, uint256 amount) private view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
    }

    function _permitSig(uint256 key, ISignatureTransfer.PermitTransferFrom memory p) private view returns (bytes memory) {
        bytes32 tokenHash = keccak256(
            abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), p.permitted.token, p.permitted.amount)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                ),
                tokenHash,
                address(vault),
                p.nonce,
                p.deadline
            )
        );
        bytes32 separator = ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR();
        return _sig(key, keccak256(abi.encodePacked("\x19\x01", separator, structHash)));
    }
}
