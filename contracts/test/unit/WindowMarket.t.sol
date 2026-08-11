// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WindowMarket} from "../../src/WindowMarket.sol";
import {IWindowMarket} from "../../src/interfaces/IWindowMarket.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {WindowFixture} from "../helpers/WindowFixture.sol";

contract WindowMarketTest is WindowFixture {
    uint256 internal id;
    uint256 internal constant FEE = 40_000; // 4% of the 1 USDG start price

    function setUp() public override {
        super.setUp();
        _setUpWindows();
        id = _createWindow();
    }

    /// Claims and moves after the start wait for the Window's hours to settle.
    function _finish() private {
        vm.warp(t1);
        _settleEmptyThrough(uint64(t1 / 3600) - 1);
    }

    function _buyerCost(uint256 units) private pure returns (uint256) {
        return units * (START_PRICE + FEE);
    }

    function _finalGood() private {
        _finish();
        _post(id, 3600, 0);
        vm.warp(block.timestamp + 24 hours);
    }

    function _finalFailed() private {
        _finish();
        _post(id, 3600, 721);
        vm.warp(block.timestamp + 24 hours);
    }

    // Creating

    function test_createPullsCollateralAndRecordsTheWindow() public {
        assertEq(usdg.balanceOf(address(windows)), _collateral());
        WindowView memory w = windows.windowView(id);
        assertEq(w.host, host);
        assertEq(w.units, UNITS);
        assertEq(w.hostPricePerUnit, START_PRICE);
        assertEq(w.buyerPricePerUnit, START_PRICE + FEE);
    }

    function test_onlyARoutableHostCreates() public {
        WindowParams memory p = _params();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotRoutable.selector, alice));
        windows.create(p, _collateral());
    }

    function test_aHostThatStoppedBeingRoutableCannotCreate() public {
        WindowParams memory p = _params();
        vm.prank(host);
        registry.exit();
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotRoutable.selector, host));
        windows.create(p, _collateral());
    }

    function test_theHostMustServeTheModel() public {
        WindowParams memory p = _params();
        p.modelDigest = keccak256("other");
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotRoutable.selector, host));
        windows.create(p, _collateral());
    }

    function test_hoursMustAlign() public {
        WindowParams memory p = _params();
        p.t0 += 1;
        vm.prank(host);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.create(p, _collateral());
    }

    function test_endMustFollowStart() public {
        WindowParams memory p = _params();
        p.t1 = p.t0;
        vm.prank(host);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.create(p, _collateral());
    }

    function test_aWindowCannotExceedAWeek() public {
        WindowParams memory p = _params();
        p.t1 = p.t0 + 169 hours;
        vm.prank(host);
        vm.expectRevert(WindowMarket.WindowTooLong.selector);
        windows.create(p, _collateral());
    }

    function test_theAuctionMustEndByTheStart() public {
        WindowParams memory p = _params();
        p.auctionEnd = p.t0 + 1;
        vm.prank(host);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.create(p, _collateral());
    }

    function test_pricesMustDeclineAndStayPositive() public {
        WindowParams memory p = _params();
        p.endPricePerUnit = p.startPricePerUnit + 1;
        vm.prank(host);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.create(p, _collateral());
        p.endPricePerUnit = 0;
        vm.prank(host);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.create(p, _collateral());
    }

    function test_collateralIsAtLeastTwentyPercent() public {
        WindowParams memory p = _params();
        uint256 required = _collateral();
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.CollateralTooLow.selector, required - 1, required));
        windows.create(p, required - 1);
    }

    function test_hostsKeepThirtyPercentOfEveryHour() public {
        uint256 limit = uint256(MAX_TPS) * 3600 * 7_000 / 10_000;
        WindowParams memory p = _params();
        uint256 reserved = windows.reservedTokensPerHour(host, uint64(t0 / 3600));
        p.units = uint64((limit - reserved) * 2 / 1_000_000);
        vm.prank(host);
        windows.create(p, uint256(p.units) * START_PRICE);
        p.units = 1;
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.MarketShareExceeded.selector, uint64(t0 / 3600)));
        windows.create(p, uint256(p.units) * START_PRICE);
    }

    // Buying

    function test_theDutchPriceDeclinesLinearly() public {
        WindowParams memory p = _params();
        vm.warp((uint256(p.auctionStart) + p.auctionEnd) / 2);
        (uint256 mid,) = windows.priceNow(id);
        assertApproxEqAbs(mid, (uint256(START_PRICE) + END_PRICE) / 2, 1);
        vm.warp(p.auctionEnd);
        (uint256 last,) = windows.priceNow(id);
        assertEq(last, END_PRICE);
    }

    function test_buyEscrowsHostPriceAndFee() public {
        vm.expectEmit(address(windows));
        emit IWindowMarket.WindowBought(id, alice, 3, START_PRICE, 3 * FEE);
        _buy(alice, id, 3);
        assertEq(windows.balanceOf(alice, id), 3);
        assertEq(usdg.balanceOf(address(windows)), _collateral() + _buyerCost(3));
        WindowMarket.Window memory w = windows.windowState(id);
        assertEq(w.escrowHost, 3 * uint256(START_PRICE));
        assertEq(w.escrowFees, 3 * FEE);
        assertEq(windows.holderView(id, alice).costBasis, START_PRICE + FEE);
    }

    function test_cannotBuyPastTheMaxPrice() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PriceAboveMax.selector, START_PRICE + FEE, START_PRICE));
        windows.buy(id, 1, START_PRICE);
    }

    function test_cannotBuyMoreThanRemain() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.InsufficientUnits.selector, UNITS, UNITS + 1));
        windows.buy(id, UNITS + 1, type(uint256).max);
    }

    function test_cannotBuyZero() public {
        vm.prank(alice);
        vm.expectRevert(WindowMarket.ZeroUnits.selector);
        windows.buy(id, 0, type(uint256).max);
    }

    function test_cannotBuyAfterTheAuction() public {
        vm.warp(t0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.AuctionClosed.selector, id));
        windows.buy(id, 1, type(uint256).max);
    }

    function test_cannotBuyAnUnknownWindow() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.UnknownWindow.selector, 99));
        windows.buy(99, 1, type(uint256).max);
    }

    function test_earlyAccessIsOffWhileTokenHooksAreOff() public {
        assertFalse(splitter.tokenHooksEnabled());
        _buy(alice, id, 1);
        assertEq(windows.balanceOf(alice, id), 1);
    }

    function test_earlyAccessAppliesOnceHooksAreOn() public {
        vm.prank(owner);
        splitter.setTokenHooksEnabled(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.EarlyAccessOnly.selector, alice));
        windows.buy(id, 1, type(uint256).max);

        ofpk.mint(bob, 1_000e18);
        vm.startPrank(bob);
        ofpk.approve(address(hooks), type(uint256).max);
        hooks.lock(1_000e18);
        windows.buy(id, 1, type(uint256).max);
        vm.stopPrank();
        assertEq(windows.balanceOf(bob, id), 1);

        vm.warp(block.timestamp + 2 hours);
        _buy(alice, id, 1);
        assertEq(windows.balanceOf(alice, id), 1);
    }

    function test_aTierDiscountLowersTheFeeOnlyWithHooksOn() public {
        ofpk.mint(bob, 1_000e18);
        vm.prank(owner);
        splitter.setTokenHooksEnabled(true);
        vm.startPrank(bob);
        ofpk.approve(address(hooks), type(uint256).max);
        hooks.lock(1_000e18);
        (, uint256 discounted) = windows.priceNow(id);
        vm.stopPrank();
        assertEq(discounted, uint256(START_PRICE) + 37_500);
    }

    // Cancelling

    function test_cancelRefunds95PercentAndTheWholeFee() public {
        _buy(alice, id, 2);
        uint256 before = usdg.balanceOf(alice);
        uint256 expected = 2 * uint256(START_PRICE) * 95 / 100 + 2 * FEE;
        vm.expectEmit(address(windows));
        emit IWindowMarket.WindowCancelled(id, alice, 2, expected);
        vm.prank(alice);
        windows.cancel(id, 2);
        assertEq(usdg.balanceOf(alice) - before, expected);
        assertEq(windows.balanceOf(alice, id), 0);
        assertEq(usdg.balanceOf(address(registry)) - 2_000e6, 2 * uint256(START_PRICE) * 5 / 100);
        assertEq(windows.windowState(id).sold, 0);
    }

    function test_cannotCancelOnceStarted() public {
        _buy(alice, id, 1);
        vm.warp(t0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.WindowStarted.selector, id));
        windows.cancel(id, 1);
    }

    function test_cancelNeedsUnits() public {
        vm.prank(alice);
        vm.expectRevert(WindowMarket.ZeroUnits.selector);
        windows.cancel(id, 0);
    }

    // Transfers

    function test_aGiftCarriesTheSendersBasis() public {
        _buy(alice, id, 2);
        vm.warp(t0 - 1);
        _buy(bob, id, 2);
        vm.prank(alice);
        windows.safeTransferFrom(alice, bob, id, 2, "");
        WindowMarket.Holding memory h = windows.holdingState(id, bob);
        assertGt(h.hostBasis, END_PRICE);
        assertLt(h.hostBasis, START_PRICE);
    }

    function test_thePartlyUsedUnitCannotMove() public {
        _buy(alice, id, 2);
        vm.warp(t0);
        _draw(id, alice, 1);
        _finish();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.InsufficientUnits.selector, 1, 2));
        windows.safeTransferFrom(alice, bob, id, 2, "");
        windows.safeTransferFrom(alice, bob, id, 1, "");
        vm.stopPrank();
        assertEq(windows.balanceOf(alice, id), 1);
    }

    function test_aSpentUnitCannotLiftTheBasisOfACheapOne() public {
        _buy(alice, id, 1);
        vm.warp(t0 - 1);
        (uint256 cheap,) = windows.priceNow(id);
        _buy(bob, id, 1);
        vm.warp(t0);
        _draw(id, alice, 999_999);
        _finish();
        vm.prank(bob);
        windows.safeTransferFrom(bob, alice, id, 1, "");
        assertApproxEqAbs(windows.holdingState(id, alice).hostBasis, cheap, 2);
    }
