// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {ReserveHandler} from "./ReserveHandler.sol";

contract ReserveInvariant is StdInvariant, Test {
    ReserveHandler internal handler;

    function setUp() public {
        handler = new ReserveHandler();
        targetContract(address(handler));
    }

    /// With a router obeying the chain, every debit is taken in full unless settlement ran past the 2-hour exit.
    function invariant_debitsAreNeverClampedOnTime() public view {
        assertFalse(handler.unexpectedClamp());
    }

    /// Served-but-unsettled usage is always covered by what the buyer cannot withdraw.
    function invariant_reserveCoversUnsettledUsage() public view {
        for (uint256 i; i < 3; ++i) {
            address actor = handler.actors(i);
            if (handler.exitedLate(actor)) continue;
            uint256 owed = handler.unsettled(actor);
            uint256 balance = handler.balanceOf(actor);
            assertGe(handler.reserveOf(actor), owed < balance ? owed : balance);
            assertGe(balance, owed);
        }
    }
}
