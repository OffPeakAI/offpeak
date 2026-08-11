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
