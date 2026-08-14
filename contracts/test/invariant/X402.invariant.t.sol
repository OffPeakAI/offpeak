// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {X402Escrow} from "../../src/X402Escrow.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {X402Handler} from "./X402Handler.sol";

contract X402Invariant is StdInvariant, Test {
    X402Handler internal handler;
    X402Escrow internal x402;

    function setUp() public {
        handler = new X402Handler();
        x402 = handler.escrowAddress();
        targetContract(address(handler));
    }

    function invariant_escrowHoldsExactlyTheOpenMaxes() public view {
        uint256 open;
        for (uint256 i; i < handler.reqCount(); ++i) {
            EscrowView memory e = x402.escrowView(handler.reqIds(i));
            if (e.status == 1) open += e.max - e.captured;
        }
        assertEq(handler.escrowBalance(), open);
    }

    function invariant_everyAuthorizedUnitIsHeldCapturedOrRefunded() public view {
        assertEq(handler.ghostAuthorized(), handler.escrowBalance() + handler.ghostCaptured() + handler.ghostRefunded());
    }

    function invariant_capturedFundsReachTheVault() public view {
        assertEq(handler.vaultBalance(), handler.ghostCaptured());
    }

    function invariant_aRevokedApprovalCannotReduceAnEscrow() public view {
        assertEq(handler.revokedThenClawedBack(), 0);
    }

    function afterInvariant() public view {
        console2.log("authorized", handler.reqCount());
        console2.log("captures", handler.captures());
        console2.log("expiries", handler.expiries());
        console2.log("revokes", handler.revokes());
    }
}
