// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OfpkHooks} from "../../src/OfpkHooks.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";
import {WindowFixture} from "../helpers/WindowFixture.sol";

/// @notice Locks, unlocks and retunes the hooks, with the switch flipping underneath. Each `attack` action must be
/// refused, and a lock must always come back out, whatever the switch says.
contract OfpkHooksHandler is WindowFixture {
    uint256 internal constant ACTORS = 3;
    uint256 public constant START_BALANCE = 1_000_000e18;
    uint256 public constant HOST_OFPK = 1e30;

    address[ACTORS] public actors = [address(0x1000), address(0x2000), address(0x3000)];
    bool public attackAccepted;
    bool public unlockPaidWrong;
    uint256 public locks;
    uint256 public unlocks;
    uint256 public unlocksWhileOff;

    constructor() {
        VaultFixture.setUp();
        _setUpWindows();
        for (uint256 i; i < ACTORS; ++i) {
            ofpk.mint(actors[i], START_BALANCE);
            vm.prank(actors[i]);
            ofpk.approve(address(hooks), type(uint256).max);
        }
        ofpk.mint(host, HOST_OFPK);
        vm.prank(host);
        ofpk.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        splitter.setTokenHooksEnabled(true);
    }

    function setUp() public override {}

    function hooksAddress() external view returns (OfpkHooks) {
        return hooks;
    }

    function hostAddress() external view returns (address) {
        return host;
    }

    function hooksOn() external view returns (bool) {
        return splitter.tokenHooksEnabled();
    }

    function ofpkBalanceOf(address who) external view returns (uint256) {
        return ofpk.balanceOf(who);
    }

    function lock(uint256 seed, uint256 amount) external {
        address actor = _actor(seed);
        uint256 wallet = ofpk.balanceOf(actor);
        if (wallet == 0) return;
        amount = bound(amount, 1, wallet);
        bool on = splitter.tokenHooksEnabled();
        vm.prank(actor);
        if (on) {
            hooks.lock(amount);
            locks++;
        } else {
            try hooks.lock(amount) {
                attackAccepted = true;
            } catch {}
        }
    }

    function requestUnlock(uint256 seed, uint256 amount) external {
        address actor = _actor(seed);
        (uint256 locked,,) = hooks.locks(actor);
        if (locked == 0) return;
        amount = bound(amount, 1, locked);
        vm.prank(actor);
        hooks.requestUnlock(amount);
    }

    /// Before the cooldown ends this must be refused, and after it nothing may stop it.
    function unlock(uint256 seed) external {
        address actor = _actor(seed);
        (, uint256 unlocking, uint64 availableAt) = hooks.locks(actor);
        if (unlocking == 0) return;
        if (block.timestamp < availableAt) {
            vm.prank(actor);
            try hooks.unlock() {
                attackAccepted = true;
            } catch {}
            return;
        }
        uint256 wallet = ofpk.balanceOf(actor);
        bool on = splitter.tokenHooksEnabled();
        vm.prank(actor);
        hooks.unlock();
        if (ofpk.balanceOf(actor) != wallet + unlocking) unlockPaidWrong = true;
        unlocks++;
        if (!on) unlocksWhileOff++;
    }

    function attackUnlockTooMuch(uint256 seed) external {
        address actor = _actor(seed);
        (uint256 locked,,) = hooks.locks(actor);
        vm.prank(actor);
        try hooks.requestUnlock(locked + 1) {
            attackAccepted = true;
        } catch {}
    }

    function attackSettings(uint256 bonus, uint16 discount) external {
        uint256 tooHigh = hooks.MAX_BONUS_PER_OFPK() + bound(bonus, 1, type(uint128).max);
        uint16 tooDeep = uint16(hooks.MAX_DISCOUNT_BPS() + bound(discount, 1, 1_000));
        uint256[3] memory thresholds = [uint256(1), 2, 3];
        vm.startPrank(owner);
        try hooks.setBonusPerOfpk(tooHigh) {
            attackAccepted = true;
        } catch {}
        try hooks.setTiers(thresholds, [uint16(0), 0, 0, tooDeep]) {
            attackAccepted = true;
        } catch {}
        try hooks.setTiers([uint256(2), 2, 3], [uint16(0), 0, 0, 0]) {
            attackAccepted = true;
        } catch {}
        vm.stopPrank();
    }

    function setHooks(bool enabled) external {
        vm.prank(owner);
        splitter.setTokenHooksEnabled(enabled);
    }

    function setBonus(uint256 bonus) external {
        bonus = bound(bonus, 0, hooks.MAX_BONUS_PER_OFPK());
        vm.prank(owner);
        hooks.setBonusPerOfpk(bonus);
    }

    function setTiers(uint256 base, uint256 step, uint16 discount) external {
        uint256 first = bound(base, 1, 500_000e18);
        uint256 gap = bound(step, 1, 500_000e18);
        uint16 deepest = uint16(bound(discount, 0, hooks.MAX_DISCOUNT_BPS()));
        vm.prank(owner);
        hooks.setTiers([first, first + gap, first + 2 * gap], [uint16(0), deepest / 4, deepest / 2, deepest]);
    }

    function topUpHostBond(uint256 amount) external {
        uint256 wallet = ofpk.balanceOf(host);
        if (wallet == 0) return;
        amount = bound(amount, 1, wallet);
        vm.prank(host);
        registry.topUpBond(0, amount);
    }

    function wait(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 8 days));
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % ACTORS];
    }
}
