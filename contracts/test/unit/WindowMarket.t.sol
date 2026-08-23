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

    function test_batchTransfersAreOff() public {
        _buy(alice, id, 3);
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id;
        uint256[] memory values = new uint256[](2);
        values[0] = 2;
        values[1] = 1;
        vm.prank(alice);
        vm.expectRevert(WindowMarket.BatchTransfersOff.selector);
        windows.safeBatchTransferFrom(alice, bob, ids, values, "");
    }

    function test_unitsCannotLeaveWhileUsedTokensAreUnsettled() public {
        _buy(alice, id, 2);
        vm.warp(t0);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.UnitsLocked.selector, id));
        windows.safeTransferFrom(alice, bob, id, 1, "");
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.UnitsLocked.selector, id));
        windows.list(id, 1, 1);
        vm.stopPrank();
    }

    function test_unitsListedBeforeTheStartCanStillSell() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 1, 1_000_000);
        vm.warp(t0 + 1);
        vm.prank(bob);
        windows.buyListing(listingId, 1, 1_000_000);
        assertEq(windows.balanceOf(bob, id), 1);
    }

    function test_aListingPriceMustFit() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PriceAboveMax.selector, uint256(type(uint64).max) + 1, type(uint64).max));
        windows.list(id, 1, uint256(type(uint64).max) + 1);
    }

    function test_theMarketRefusesStrayTransfers() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        vm.expectRevert();
        windows.safeTransferFrom(alice, address(windows), id, 1, "");
    }

    // Resale

    function test_resaleFeeIsOnePercentPlusTenPercentOfMarkup() public {
        _buy(alice, id, 2);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 2, 2_000_000);
        uint256 sale = 2 * 2_000_000;
        uint256 markup = 2 * (2_000_000 - (START_PRICE + FEE));
        uint256 fee = sale / 100 + markup / 10;
        uint256 sellerBefore = usdg.balanceOf(alice);
        uint256 splitterBefore = usdg.balanceOf(address(splitter));
        vm.expectEmit(address(windows));
        emit IWindowMarket.ListingFilled(listingId, bob, 2, fee);
        vm.prank(bob);
        windows.buyListing(listingId, 2, 2_000_000);
        assertEq(usdg.balanceOf(alice) - sellerBefore, sale - fee);
        assertEq(usdg.balanceOf(address(splitter)) - splitterBefore, fee);
        assertEq(windows.balanceOf(bob, id), 2);
        assertEq(windows.holderView(id, bob).costBasis, 2_000_000);
        assertEq(windows.holdingState(id, bob).hostBasis, START_PRICE);
    }

    function test_noMarkupMeansOnlyTheOnePercent() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 1, 500_000);
        vm.expectEmit(address(windows));
        emit IWindowMarket.ListingFilled(listingId, bob, 1, 5_000);
        vm.prank(bob);
        windows.buyListing(listingId, 1, 500_000);
    }

    function test_partialFillsLeaveTheRest() public {
        _buy(alice, id, 3);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 3, 1_000_000);
        vm.prank(bob);
        windows.buyListing(listingId, 1, 1_000_000);
        vm.prank(alice);
        windows.delist(listingId);
        assertEq(windows.balanceOf(alice, id), 2);
        assertEq(windows.balanceOf(bob, id), 1);
    }

    function test_listingHoldsTheUnitsInTheMarket() public {
        _buy(alice, id, 2);
        vm.prank(alice);
        windows.list(id, 2, 1_000_000);
        assertEq(windows.balanceOf(alice, id), 0);
        assertEq(windows.balanceOf(address(windows), id), 2);
    }

    function test_aUnitInUseCannotBeListed() public {
        _buy(alice, id, 1);
        vm.warp(t0);
        _draw(id, alice, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.UnitsLocked.selector, id));
        windows.list(id, 1, 1);
    }

    function test_cannotListAfterTheEnd() public {
        _buy(alice, id, 1);
        vm.warp(t1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.WindowEnded.selector, id));
        windows.list(id, 1, 1);
    }

    function test_cannotBuyAListingAfterTheEnd() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 1, 1);
        vm.warp(t1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.WindowEnded.selector, id));
        windows.buyListing(listingId, 1, 1);
    }

    function test_listingBounds() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 1, 7);
        vm.startPrank(bob);
        vm.expectRevert(WindowMarket.ZeroUnits.selector);
        windows.buyListing(listingId, 0, 7);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.InsufficientUnits.selector, 1, 2));
        windows.buyListing(listingId, 2, 7);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PriceAboveMax.selector, 7, 6));
        windows.buyListing(listingId, 1, 6);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotSeller.selector, bob));
        windows.delist(listingId);
        vm.stopPrank();
        vm.prank(alice);
        windows.delist(listingId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.ListingClosed.selector, listingId));
        windows.buyListing(listingId, 1, 7);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.ListingClosed.selector, listingId));
        windows.delist(listingId);
    }

    // Draws

    function test_drawsPayTheHostAndForwardTheFee() public {
        _buy(alice, id, 2);
        vm.warp(t0);
        uint256 registryBefore = usdg.balanceOf(address(registry));
        uint256 splitterBefore = usdg.balanceOf(address(splitter));
        vm.expectEmit(address(windows));
        emit IWindowMarket.Drawn(id, alice, 500_000, 0);
        _draw(id, alice, 500_000);
        assertEq(usdg.balanceOf(address(registry)) - registryBefore, START_PRICE / 2);
        assertEq(usdg.balanceOf(address(splitter)) - splitterBefore, FEE / 2);
        assertEq(windows.holderView(id, alice).drawnTokens, 500_000);
    }

    function test_crossingAWholeUnitBurnsIt() public {
        _buy(alice, id, 2);
        vm.warp(t0);
        _draw(id, alice, 1_500_000);
        assertEq(windows.balanceOf(alice, id), 1);
        assertEq(windows.holderView(id, alice).drawnTokens, 500_000);
    }

    function test_onlyTheVaultApplies() public {
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotVault.selector, address(this)));
        windows.applyDraws(1, new WindowDraw[](0));
    }

    function test_claimsWaitForTheWindowsHoursToSettle() public {
        _buy(alice, id, 1);
        vm.warp(t1);
        _settleEmptyThrough(uint64(t1 / 3600) - 2);
        _post(id, 3600, 0);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotClaimable.selector, id));
        windows.claimExpired(id);
    }

    function test_aLatePostCannotFollowTheFallback() public {
        _buy(alice, id, 1);
        vm.warp(uint256(t1) + 30 days);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PerformanceClosed.selector, id));
        _post(id, 3600, 3600);
    }

    function test_onlyASettlerAnswersADispute() public {
        _finish();
        WindowPerformance memory p = WindowPerformance({windowId: id, measuredSeconds: 3600, belowMinSeconds: 0, evidenceRoot: bytes32(0)});
        bytes memory sig = _thresholdSig(_windowsDigest(p));
        windows.postPerformance(p, sig);
        vm.prank(host);
        windows.disputePerformance(id);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PerformanceClosed.selector, id));
        windows.postPerformance(p, sig);
        vm.prank(settlers[0]);
        windows.postPerformance(p, sig);
    }

    function test_aFrozenHostCannotBlockTheLastClaim() public {
        _buy(alice, id, 1);
        _finalGood();
        vm.mockCallRevert(address(usdg), abi.encodeWithSelector(usdg.transfer.selector, host, _collateral()), "frozen");
        vm.prank(alice);
        windows.claimExpired(id);
        vm.clearMockedCalls();
        assertEq(windows.owed(host), _collateral());
        uint256 before = usdg.balanceOf(host);
        vm.prank(host);
        windows.claimOwed();
        assertEq(usdg.balanceOf(host) - before, _collateral());
    }

    function test_theStartMustBeWithinAYear() public {
        WindowParams memory p = _params();
        p.t0 = uint64(block.timestamp / 3600 + 24 * 366) * 3600;
        p.t1 = p.t0 + 3600;
        p.auctionEnd = p.t0;
        vm.prank(host);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.create(p, _collateral());
    }

    function test_aWindowNeedsAMinimumRate() public {
        WindowParams memory p = _params();
        p.minTps = 0;
        vm.prank(host);
        vm.expectRevert(WindowMarket.ZeroUnits.selector);
        windows.create(p, _collateral());
    }

    function test_earlyAccessIsBounded() public {
        vm.prank(owner);
        vm.expectRevert(WindowMarket.BadTiming.selector);
        windows.setEarlyAccessSeconds(7 days + 1);
    }

    function test_aDrawPastTheBalanceShrinksInsteadOfStallingTheHour() public {
        _buy(alice, id, 1);
        vm.warp(t0);
        vm.expectEmit(address(windows));
        emit IWindowMarket.Drawn(id, alice, 1_000_000, 1);
        _draw(id, alice, 5_000_000);
        assertEq(windows.balanceOf(alice, id), 0);
        assertEq(windows.holderView(id, alice).drawnTokens, 0);
    }

    function test_aDrawOutsideTheWindowDoesNothing() public {
        _buy(alice, id, 1);
        vm.warp(t0 - 1);
        vm.expectEmit(address(windows));
        emit IWindowMarket.Drawn(id, alice, 0, 0);
        _draw(id, alice, 1);
        assertEq(windows.holderView(id, alice).drawnTokens, 0);
        vm.warp(t1);
        _draw(id, alice, 1);
        assertEq(windows.holderView(id, alice).drawnTokens, 0);
    }

    // Performance

    function test_performancePostsAfterTheEndAndWaitsADay() public {
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.WindowNotEnded.selector, id));
        _post(id, 3600, 0);
        _finish();
        vm.expectEmit(address(windows));
        emit IWindowMarket.PerformancePosted(id, 3600, 720, false, uint64(block.timestamp + 24 hours));
        _post(id, 3600, 720);
        assertFalse(windows.windowView(id).failed);
    }

    function test_justOverTwentyPercentFails() public {
        _buy(alice, id, 1);
        _finish();
        _post(id, 3600, 721);
        assertTrue(windows.windowView(id).failed);
    }

    function test_aBadSignatureIsRefused() public {
        _finish();
        WindowPerformance memory p = WindowPerformance({windowId: id, measuredSeconds: 1, belowMinSeconds: 0, evidenceRoot: bytes32(0)});
        bytes32 wrong = keccak256("wrong");
        vm.expectRevert();
        windows.postPerformance(p, _thresholdSig(wrong));
    }

    function test_settlementCannotPostTwiceWithoutADispute() public {
        _finish();
        _post(id, 3600, 0);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PerformanceClosed.selector, id));
        _post(id, 3600, 0);
    }

    function test_aDisputeReopensAndTheRepostIsFinal() public {
        _buy(alice, id, 1);
        _finish();
        _post(id, 3600, 3600);
        vm.prank(host);
        windows.disputePerformance(id);
        _post(id, 3600, 0);
        vm.warp(block.timestamp + 1);
        assertFalse(windows.windowView(id).failed);
        vm.prank(alice);
        windows.claimExpired(id);
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PerformanceClosed.selector, id));
        windows.disputePerformance(id);
    }

    function test_onlyTheHostDisputesAndOnlyInTime() public {
        _finish();
        _post(id, 3600, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotHost.selector, alice));
        windows.disputePerformance(id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.PerformanceClosed.selector, id));
        windows.disputePerformance(id);
    }

    function test_aPauseHoldsPerformance() public {
        _finish();
        vm.prank(guardian);
        vault.setSettlesPaused(true);
        WindowPerformance memory p = WindowPerformance({windowId: id, measuredSeconds: 1, belowMinSeconds: 0, evidenceRoot: bytes32(0)});
        vm.expectRevert(WindowMarket.SettlesPaused.selector);
        windows.postPerformance(p, "");
    }

    // Claims

    function test_expiredHalfRefundsUnusedAndPaysTheHostHalf() public {
        _buy(alice, id, 2);
        vm.warp(t0);
        _draw(id, alice, 500_000);
        _finalGood();
        uint256 unusedHost = uint256(START_PRICE) * 3 / 2;
        uint256 unusedFee = FEE * 3 / 2;
        uint256 before = usdg.balanceOf(alice);
        uint256 registryBefore = usdg.balanceOf(address(registry));
        vm.expectEmit(address(windows));
        emit IWindowMarket.Claimed(id, alice, 0, unusedHost / 2 + unusedFee);
        vm.prank(alice);
        windows.claimExpired(id);
        assertEq(usdg.balanceOf(alice) - before, unusedHost / 2 + unusedFee);
        assertEq(usdg.balanceOf(address(registry)) - registryBefore, unusedHost - unusedHost / 2);
        assertEq(windows.balanceOf(alice, id), 0);
    }

    function test_theLastClaimReturnsCollateralAndLeavesTheMarketEmpty() public {
        _buy(alice, id, 1);
        _buy(bob, id, 1);
        _finalGood();
        uint256 before = usdg.balanceOf(host);
        vm.prank(alice);
        windows.claimExpired(id);
        assertEq(usdg.balanceOf(host), before);
        vm.prank(bob);
        windows.claimExpired(id);
        assertEq(usdg.balanceOf(host) - before, _collateral());
        assertEq(usdg.balanceOf(address(windows)), 0);
    }

    function test_collateralComesBackAfterThirtyDaysEvenIfSomeoneNeverClaims() public {
        _buy(alice, id, 1);
        _finalGood();
        vm.warp(uint256(t1) + 30 days);
        uint256 before = usdg.balanceOf(host);
        vm.prank(host);
        windows.claimExpired(id);
        assertEq(usdg.balanceOf(host) - before, _collateral());
        vm.prank(alice);
        windows.claimExpired(id);
        assertEq(usdg.balanceOf(host) - before, _collateral());
        assertEq(usdg.balanceOf(address(windows)), 0);
    }

    function test_anUnsoldWindowReturnsCollateralAtTheEnd() public {
        _finish();
        uint256 before = usdg.balanceOf(host);
        vm.prank(host);
        windows.claimExpired(id);
        assertEq(usdg.balanceOf(host) - before, _collateral());
    }

    function test_aHostCannotTakeCollateralBeforePerformance() public {
        _buy(alice, id, 1);
        vm.warp(t0);
        _draw(id, alice, 1_000_000);
        _finish();
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotClaimable.selector, id));
        windows.claimExpired(id);
    }

    function test_claimsWaitForTheDisputeDay() public {
        _buy(alice, id, 1);
        _finish();
        _post(id, 3600, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotClaimable.selector, id));
        windows.claimExpired(id);
    }

    function test_claimsOpenAfterThirtyDaysIfNothingWasPosted() public {
        _buy(alice, id, 1);
        vm.warp(uint256(t1) + 30 days);
        vm.prank(alice);
        windows.claimExpired(id);
        assertEq(windows.balanceOf(alice, id), 0);
    }

    function test_aDisputeCannotTrapClaimsForever() public {
        _buy(alice, id, 1);
        _finish();
        _post(id, 3600, 0);
        vm.prank(host);
        windows.disputePerformance(id);
        vm.warp(uint256(t1) + 30 days);
        vm.prank(alice);
        windows.claimExpired(id);
        assertEq(windows.balanceOf(alice, id), 0);
    }

    function test_claimExpiredRefusesAFailedWindow() public {
        _buy(alice, id, 1);
        _finalFailed();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotClaimable.selector, id));
        windows.claimExpired(id);
    }

    function test_claimFailureRefusesAGoodWindow() public {
        _buy(alice, id, 1);
        _finalGood();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotClaimable.selector, id));
        windows.claimFailure(id);
    }

    function test_failureRefundsUndrawnAndSharesAllTheCollateral() public {
        _buy(alice, id, 3);
        _buy(bob, id, 1);
        vm.warp(t0);
        _draw(id, alice, 1_000_000);
        _finalFailed();
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        windows.claimFailure(id);
        assertEq(usdg.balanceOf(alice) - before, 2 * (START_PRICE + FEE) + _collateral() * 3 / 4);
        before = usdg.balanceOf(bob);
        vm.prank(bob);
        windows.claimFailure(id);
        assertEq(usdg.balanceOf(bob) - before, START_PRICE + FEE + _collateral() / 4);
        assertEq(usdg.balanceOf(address(windows)), 0);
    }

    function test_collateralFollowsUnitsHeldAtTheStartNotAfter() public {
        _buy(alice, id, 3);
        _buy(bob, id, 1);
        _finish();
        vm.prank(alice);
        windows.safeTransferFrom(alice, bob, id, 3, "");
        _post(id, 3600, 721);
        vm.warp(block.timestamp + 24 hours);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        windows.claimFailure(id);
        assertEq(usdg.balanceOf(alice) - before, _collateral() * 3 / 4);
        before = usdg.balanceOf(bob);
        vm.prank(bob);
        windows.claimFailure(id);
        assertEq(usdg.balanceOf(bob) - before, 4 * (START_PRICE + FEE) + _collateral() / 4);
    }

    function test_listedUnitsCountAsHeldAtTheStart() public {
        _buy(alice, id, 2);
        vm.prank(alice);
        uint256 listingId = windows.list(id, 2, 1_000_000);
        _finalFailed();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.StillListed.selector, id, uint64(2)));
        windows.claimFailure(id);
        vm.startPrank(alice);
        windows.delist(listingId);
        uint256 before = usdg.balanceOf(alice);
        windows.claimFailure(id);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice) - before, 2 * (START_PRICE + FEE) + _collateral());
    }

    function test_failureClaimsWaitForTheDisputeDay() public {
        _buy(alice, id, 1);
        _finish();
        _post(id, 3600, 721);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.NotClaimable.selector, id));
        windows.claimFailure(id);
    }

    function test_theLastUnitBurningDoesNotCutOffAHolderStillOwedCollateral() public {
        _buy(alice, id, 1);
        _buy(bob, id, 1);
        vm.warp(t0);
        _draw(id, alice, 1_000_000);
        _finalFailed();
        vm.prank(bob);
        windows.claimFailure(id);
        assertEq(windows.windowState(id).live, 0);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        windows.claimFailure(id);
        assertEq(usdg.balanceOf(alice) - before, _collateral() / 2);
        assertEq(usdg.balanceOf(address(windows)), 0);
    }

    function test_aFullyDrawnHolderStillGetsTheirCollateralShare() public {
        _buy(alice, id, 1);
        vm.warp(t0);
        _draw(id, alice, 1_000_000);
        _finalFailed();
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        windows.claimFailure(id);
        assertEq(usdg.balanceOf(alice) - before, _collateral());
    }

    function test_aFailureClaimPaysOnce() public {
        _buy(alice, id, 1);
        _buy(bob, id, 1);
        _finalFailed();
        vm.startPrank(alice);
        windows.claimFailure(id);
        uint256 before = usdg.balanceOf(alice);
        windows.claimFailure(id);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice), before);
    }

    function test_aStrangerGetsNothing() public {
        _buy(alice, id, 1);
        _finalFailed();
        vm.prank(bob);
        windows.claimFailure(id);
        assertEq(windows.windowState(id).sharedUnits, 0);
    }

    function test_listedUnitsBlockAnExpiredClaim() public {
        _buy(alice, id, 1);
        vm.prank(alice);
        windows.list(id, 1, 1);
        _finalGood();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowMarket.StillListed.selector, id, uint64(1)));
        windows.claimExpired(id);
    }

    function test_theOwnerCanSetEarlyAccessButNotMoveFunds() public {
        vm.prank(alice);
        vm.expectRevert();
        windows.setEarlyAccessSeconds(0);
        vm.prank(owner);
        windows.setEarlyAccessSeconds(0);
        assertEq(windows.earlyAccessSeconds(), 0);
    }
}
