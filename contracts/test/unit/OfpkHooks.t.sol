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
