// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OfpkHooks} from "../../src/OfpkHooks.sol";
import {IOfpkHooks} from "../../src/interfaces/IOfpkHooks.sol";
import {WindowFixture} from "../helpers/WindowFixture.sol";

contract OfpkHooksTest is WindowFixture {
    function setUp() public override {
        super.setUp();
        ofpk.mint(alice, 1_000_000e18);
        vm.prank(alice);
        ofpk.approve(address(hooks), type(uint256).max);
    }

    function _on() private {
        vm.prank(owner);
        splitter.setTokenHooksEnabled(true);
    }

    function _lock(uint256 amount) private {
        vm.prank(alice);
        hooks.lock(amount);
    }

    function test_lockingIsRefusedUntilTheHooksAreOn() public {
        vm.prank(alice);
        vm.expectRevert(OfpkHooks.HooksDisabled.selector);
        hooks.lock(1);
    }

    function test_tiersFollowLockedBalance() public {
        _on();
        assertEq(hooks.tierOf(alice), 0);
        _lock(999e18);
        assertEq(hooks.tierOf(alice), 0);
        _lock(1e18);
        assertEq(hooks.tierOf(alice), 1);
        assertEq(hooks.feeDiscountBps(alice), 25);
        assertTrue(hooks.earlyAccess(alice));
        _lock(9_000e18);
        assertEq(hooks.tierOf(alice), 2);
        assertEq(hooks.feeDiscountBps(alice), 50);
        _lock(90_000e18);
        assertEq(hooks.tierOf(alice), 3);
        assertEq(hooks.feeDiscountBps(alice), 100);
    }

    function test_turningTheHooksOffSwitchesEverythingOff() public {
        _on();
        _lock(100_000e18);
        vm.prank(owner);
        splitter.setTokenHooksEnabled(false);
        assertEq(hooks.tierOf(alice), 0);
        assertEq(hooks.feeDiscountBps(alice), 0);
        assertFalse(hooks.earlyAccess(alice));
    }

    function test_aWalletBalanceEarnsNoTier() public {
        _on();
        assertGt(ofpk.balanceOf(alice), 100_000e18);
        assertEq(hooks.tierOf(alice), 0);
    }

    function test_unlockingStopsCountingAtOnceAndWaitsSevenDays() public {
        _on();
        _lock(1_000e18);
        vm.prank(alice);
        hooks.requestUnlock(1_000e18);
        assertEq(hooks.tierOf(alice), 0);
        uint64 availableAt = uint64(block.timestamp + 7 days);
        vm.warp(availableAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OfpkHooks.StillCoolingDown.selector, availableAt));
        hooks.unlock();
        vm.warp(availableAt);
        uint256 before = ofpk.balanceOf(alice);
        vm.prank(alice);
        hooks.unlock();
        assertEq(ofpk.balanceOf(alice) - before, 1_000e18);
    }

    function test_anUnlockPaysOnce() public {
        _on();
        vm.startPrank(alice);
        hooks.lock(10e18);
        hooks.requestUnlock(1e18);
        vm.warp(block.timestamp + 7 days);
        hooks.unlock();
        vm.expectRevert(OfpkHooks.NothingToUnlock.selector);
        hooks.unlock();
        vm.stopPrank();
    }

    function test_aFurtherRequestRestartsTheCooldown() public {
        _on();
        _lock(2e18);
        vm.prank(alice);
        hooks.requestUnlock(1e18);
        vm.warp(block.timestamp + 6 days);
        vm.prank(alice);
        hooks.requestUnlock(1e18);
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        vm.expectRevert();
        hooks.unlock();
    }

    function test_unlockNeedsSomethingUnlocking() public {
        vm.prank(alice);
        vm.expectRevert(OfpkHooks.NothingToUnlock.selector);
        hooks.unlock();
    }

    function test_cannotRequestMoreThanLocked() public {
        _on();
        _lock(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OfpkHooks.TooMuch.selector, 1, 2));
        hooks.requestUnlock(2);
    }

    function test_zeroAmountsAreRefused() public {
        _on();
        vm.startPrank(alice);
        vm.expectRevert(OfpkHooks.ZeroAmount.selector);
        hooks.lock(0);
        vm.expectRevert(OfpkHooks.ZeroAmount.selector);
        hooks.requestUnlock(0);
        vm.stopPrank();
    }

    function test_turningTheHooksOffNeverTrapsALock() public {
        _on();
        _lock(1e18);
        vm.prank(alice);
        hooks.requestUnlock(1e18);
        vm.prank(owner);
        splitter.setTokenHooksEnabled(false);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        hooks.unlock();
        assertEq(ofpk.balanceOf(address(hooks)), 0);
    }

    function test_settingsAreOwnerOnlyAndBounded() public {
        uint256[3] memory thresholds = [uint256(1), 2, 3];
        uint16[4] memory discounts = [uint16(0), 1, 2, 3];
        vm.prank(alice);
        vm.expectRevert();
        hooks.setTiers(thresholds, discounts);

        vm.startPrank(owner);
        hooks.setTiers(thresholds, discounts);
        assertEq(hooks.tierThresholds(0), 1);
        thresholds = [uint256(2), 2, 3];
        vm.expectRevert(OfpkHooks.TiersNotAscending.selector);
        hooks.setTiers(thresholds, discounts);
        thresholds = [uint256(1), 2, 3];
        discounts = [uint16(1), 1, 2, 3];
        vm.expectRevert(abi.encodeWithSelector(OfpkHooks.DiscountTooHigh.selector, uint16(1)));
        hooks.setTiers(thresholds, discounts);
        discounts = [uint16(0), 1, 2, 301];
        vm.expectRevert(abi.encodeWithSelector(OfpkHooks.DiscountTooHigh.selector, uint16(301)));
        hooks.setTiers(thresholds, discounts);
        vm.stopPrank();
    }

    function test_theRoutingBonusIsCapped() public {
        _setUpWindows();
        assertEq(hooks.routingBonusBps(host), 0);
        _on();
        assertEq(hooks.routingBonusBps(host), 0);
        vm.prank(owner);
        hooks.setBonusPerOfpk(type(uint128).max);
        ofpk.mint(host, 1e30);
        vm.startPrank(host);
        ofpk.approve(address(registry), type(uint256).max);
        registry.topUpBond(0, 1e30);
        vm.stopPrank();
        assertEq(hooks.routingBonusBps(host), 2_500);
        vm.prank(owner);
        splitter.setTokenHooksEnabled(false);
        assertEq(hooks.routingBonusBps(host), 0);
    }

    function test_lockEmits() public {
        _on();
        vm.expectEmit(address(hooks));
        emit IOfpkHooks.Locked(alice, 5, 5);
        _lock(5);
    }
}
