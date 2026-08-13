// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {WindowMarket} from "../../src/WindowMarket.sol";
import {WindowMarketHarness} from "../helpers/WindowMarketHarness.sol";
import {WindowHandler} from "./WindowHandler.sol";

contract PartialUnitsInvariant is StdInvariant, Test {
    WindowHandler internal handler;
    WindowMarketHarness internal market;

    function setUp() public {
        handler = new WindowHandler();
        market = handler.marketAddress();
        targetContract(address(handler));
    }

    function invariant_aPartlyUsedUnitIsNeverLost() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            for (uint256 a; a < 4; ++a) {
                address actor = handler.actors(a);
                if (market.holdingState(id, actor).drawnPartial > 0) assertGt(market.balanceOf(actor, id), 0);
            }
        }
    }

    function invariant_escrowCoversEveryHoldersUnusedValue() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            WindowMarket.Window memory w = market.windowState(id);
            uint256 owed;
            for (uint256 a; a < 4; ++a) {
                address actor = handler.actors(a);
                WindowMarket.Holding memory h = market.holdingState(id, actor);
                uint256 units = market.balanceOf(actor, id) * 1_000_000 - h.drawnPartial;
                owed += units * h.hostBasis / 1_000_000;
            }
            assertLe(owed, w.escrowHost);
        }
    }
}
