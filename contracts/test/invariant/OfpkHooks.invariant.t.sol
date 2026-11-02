// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {OfpkHooks} from "../../src/OfpkHooks.sol";
import {OfpkHooksHandler} from "./OfpkHooksHandler.sol";

contract OfpkHooksInvariant is StdInvariant, Test {
    uint256 internal constant ACTORS = 3;

    OfpkHooksHandler internal handler;
    OfpkHooks internal hooks;

    function setUp() public {
        handler = new OfpkHooksHandler();
        hooks = handler.hooksAddress();
        targetContract(address(handler));
    }

    function invariant_hooksHoldExactlyWhatIsLockedOrUnlocking() public view {
        uint256 owed;
        for (uint256 i; i < ACTORS; ++i) {
            (uint256 locked, uint256 unlocking,) = hooks.locks(handler.actors(i));
            owed += locked + unlocking;
        }
        assertEq(handler.ofpkBalanceOf(address(hooks)), owed);
    }

    /// Nothing mints, burns or moves a lock to anyone else, so each account keeps its whole starting balance.
    function invariant_everyAccountsTokensAreConserved() public view {
        for (uint256 i; i < ACTORS; ++i) {
            address actor = handler.actors(i);
            (uint256 locked, uint256 unlocking,) = hooks.locks(actor);
            assertEq(handler.ofpkBalanceOf(actor) + locked + unlocking, handler.START_BALANCE());
        }
    }

    function invariant_aFinishedUnlockPaysExactly() public view {
        assertFalse(handler.unlockPaidWrong());
    }

    function invariant_aPendingUnlockAlwaysHasACooldown() public view {
        for (uint256 i; i < ACTORS; ++i) {
            (, uint256 unlocking, uint64 availableAt) = hooks.locks(handler.actors(i));
            assertEq(unlocking == 0, availableAt == 0);
        }
    }

    /// Only the locked balance counts, so a tier falls the moment an unlock is requested.
    function invariant_tiersFollowTheLockedBalanceAndTheSwitch() public view {
        for (uint256 i; i < ACTORS; ++i) {
            address actor = handler.actors(i);
            (uint256 locked,,) = hooks.locks(actor);
            uint8 expected;
            for (uint256 t; t < 3 && handler.hooksOn(); ++t) {
                if (locked >= hooks.tierThresholds(t)) expected = uint8(t + 1);
            }
            assertEq(hooks.tierOf(actor), expected);
            assertEq(hooks.earlyAccess(actor), expected >= 1);
            assertEq(hooks.feeDiscountBps(actor), hooks.tierDiscountBps(expected));
        }
    }

    function invariant_discountsAndBonusStayInRange() public view {
        for (uint256 i; i < hooks.TIERS(); ++i) {
            assertLe(hooks.tierDiscountBps(i), hooks.MAX_DISCOUNT_BPS());
        }
        assertEq(hooks.tierDiscountBps(0), 0);
        assertLe(hooks.bonusPerOfpk(), hooks.MAX_BONUS_PER_OFPK());
        uint16 bonus = hooks.routingBonusBps(handler.hostAddress());
        assertLe(bonus, hooks.MAX_ROUTING_BONUS_BPS());
        if (!handler.hooksOn()) assertEq(bonus, 0);
    }

    function invariant_everyAttackIsRefused() public view {
        assertFalse(handler.attackAccepted());
    }

    function afterInvariant() public view {
        console2.log("locks", handler.locks());
        console2.log("unlocks", handler.unlocks());
        console2.log("unlocks with hooks off", handler.unlocksWhileOff());
    }
}
