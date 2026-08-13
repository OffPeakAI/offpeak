// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {OffpeakVault} from "../../src/OffpeakVault.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {VaultHandler} from "./VaultHandler.sol";

contract VaultExitInvariant is StdInvariant, Test {
    VaultHandler internal handler;
    OffpeakVault internal vault;

    function setUp() public {
        handler = new VaultHandler();
        vault = handler.vaultAddress();
        targetContract(address(handler));
    }

    function invariant_noDebitAfterARequestIsEverAccepted() public view {
        assertFalse(handler.badDebitAccepted());
    }

    function invariant_reserveNeverExceedsBalance() public view {
        for (uint256 i; i < 3; ++i) {
            BuyerView memory v = vault.buyerState(handler.actors(i));
            assertLe(v.reserve, v.balance);
        }
    }

    /// Whatever state the run reached, paused or not, everyone can take out balance minus reserve right now.
    function invariant_withdrawingTheUnreservedPartAlwaysWorks() public {
        for (uint256 i; i < 3; ++i) {
            address actor = handler.actors(i);
            BuyerView memory v = vault.buyerState(actor);
            uint256 state = vm.snapshotState();
            vm.prank(actor);
            vault.withdraw(v.balance - v.reserve);
            assertEq(vault.buyerState(actor).balance, v.reserve);
            vm.revertToState(state);
        }
    }

    /// A pending exit always completes within 2 hours of the request, with settlement halted or not.
    function invariant_exitCompletesTwoHoursAfterRequest() public {
        for (uint256 i; i < 3; ++i) {
            address actor = handler.actors(i);
            BuyerView memory v = vault.buyerState(actor);
            if (v.withdrawRequestedAt == 0) continue;
            uint256 state = vm.snapshotState();
            if (block.timestamp < v.withdrawDueAt) vm.warp(v.withdrawDueAt);
            vault.executeWithdrawAll(actor);
            assertEq(vault.buyerState(actor).balance, 0);
            vm.revertToState(state);
        }
    }
}
