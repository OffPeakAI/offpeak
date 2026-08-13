// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {WindowMarket} from "../../src/WindowMarket.sol";
import {WindowMarketHarness} from "../helpers/WindowMarketHarness.sol";
import {WindowHandler} from "./WindowHandler.sol";

contract WindowConservationInvariant is StdInvariant, Test {
    WindowHandler internal handler;
    WindowMarketHarness internal market;

    function setUp() public {
        handler = new WindowHandler();
        market = handler.marketAddress();
        targetContract(address(handler));
    }

    function invariant_theMarketHoldsExactlyItsEscrowsAndCollateral() public view {
        uint256 held;
        for (uint256 i; i < handler.idCount(); ++i) {
            WindowMarket.Window memory w = market.windowState(handler.ids(i));
            held += w.escrowHost + w.escrowFees;
            if (!w.collateralSettled) held += w.collateral - w.collateralPaid;
        }
        assertEq(handler.marketBalance(), held);
    }

    function invariant_nothingStaysBehindAfterTheLastClaim() public view {
        assertEq(handler.leftBehind(), 0);
    }

    function afterInvariant() public view {
        console2.log("buys", handler.buys());
        console2.log("cancels", handler.cancels());
        console2.log("resales", handler.resales());
        console2.log("draws", handler.draws());
        console2.log("gifts", handler.gifts());
        console2.log("finished", handler.finishedCount());
        console2.log("failed", handler.failedCount());
    }
}
