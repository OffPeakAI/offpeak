// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import {OffpeakVault} from "../../src/OffpeakVault.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {SettlementHandler} from "./SettlementHandler.sol";

contract SettlementInvariant is StdInvariant, Test {
    SettlementHandler internal handler;
    OffpeakVault internal vault;
    HostRegistry internal registry;

    function setUp() public {
        handler = new SettlementHandler();
        vault = handler.vaultAddress();
        registry = HostRegistry(handler.registryAddress());
        targetContract(address(handler));
    }

    function invariant_settlesAreOnePerHourInOrder() public view {
        assertEq(vault.lastSettledHour(), handler.ghostLastSettled());
    }

    /// Over-cap debits, debits above totals, unbalanced batches, skipped hours and replays never land.
    function invariant_noBadBatchEverLands() public view {
        assertFalse(handler.badBatchAccepted());
    }

    /// Credits are clawable for exactly 24 hours and payable only after them.
    function invariant_hostCreditsMatchTheMirror() public view {
        assertFalse(handler.creditMirrorBroken());
        for (uint256 i; i < 2; ++i) {
            address host = handler.hostAt(i);
            HostView memory v = registry.hostView(host);
            (uint256 pending, uint256 releasable) = handler.mirrored(host);
            assertEq(v.pendingCredits, pending);
            assertEq(v.releasableCredits, releasable);
        }
    }

    function invariant_registryHoldsEveryUnpaidCredit() public view {
        uint256 owed;
        for (uint256 i; i < 2; ++i) {
            HostView memory v = registry.hostView(handler.hostAt(i));
            owed += v.pendingCredits + v.releasableCredits;
        }
        assertEq(handler.usdgBalanceOf(address(registry)), owed);
    }
}
