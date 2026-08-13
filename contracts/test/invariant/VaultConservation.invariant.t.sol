// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {OffpeakVault} from "../../src/OffpeakVault.sol";
import {VaultHandler} from "./VaultHandler.sol";

contract VaultConservationInvariant is StdInvariant, Test {
    VaultHandler internal handler;
    OffpeakVault internal vault;

    function setUp() public {
        handler = new VaultHandler();
        vault = handler.vaultAddress();
        targetContract(address(handler));
    }

    function invariant_usdgEqualsBalancesPlusPoolPlusReserve() public view {
        uint256 books = vault.agentPool() + vault.protocolReserve();
        for (uint256 i; i < 3; ++i) {
            books += vault.buyerState(handler.actors(i)).balance;
        }
        assertEq(handler.usdgBalanceOfVault(), books);
    }

    function invariant_settlesAreSequential() public view {
        assertEq(vault.lastSettledHour(), handler.ghostLastSettled());
    }
}
