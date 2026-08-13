// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ChannelManager} from "../../src/ChannelManager.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {ChannelHandler} from "./ChannelHandler.sol";

contract ChannelInvariant is StdInvariant, Test {
    ChannelHandler internal handler;
    ChannelManager internal manager;

    function setUp() public {
        handler = new ChannelHandler();
        manager = handler.managerAddress();
        targetContract(address(handler));
    }

    function invariant_everyDepositIsHeldPaidOrRefunded() public view {
        assertEq(handler.ghostDeposits(), handler.managerBalance() + handler.ghostPaid() + handler.ghostRefunded());
    }

    function invariant_theManagerHoldsExactlyWhatIsUnclaimedOnLiveChannels() public view {
        uint256 held;
        for (uint256 i; i < handler.idCount(); ++i) {
            ChannelView memory c = manager.channelView(handler.ids(i));
            if (c.status != 3) held += c.deposit - c.claimed;
        }
        assertEq(handler.managerBalance(), held);
    }

    function invariant_noChannelOverclaims() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            ChannelView memory c = manager.channelView(handler.ids(i));
            assertLe(c.claimed, c.deposit);
            assertEq(c.claimed, handler.ghostClaimed(handler.ids(i)));
        }
    }

    function invariant_noCloseBeforeTheChallengeEnds() public view {
        assertEq(handler.closedEarly(), 0);
    }

    function invariant_theLatestVoucherInTheChallengeLands() public view {
        assertEq(handler.latestVoucherLost(), 0);
    }

    function afterInvariant() public view {
        console2.log("opens", handler.opens());
        console2.log("claims", handler.claims());
        console2.log("challenge claims", handler.challengeClaims());
        console2.log("finalized", handler.finalized());
        console2.log("cooperative closes", handler.coopCloses());
    }
}
