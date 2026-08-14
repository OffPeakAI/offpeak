// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ChainConfig} from "./ChainConfig.sol";

/// @notice Step 3 of 3, and re-runnable any time. Read-only: it sends no transactions.
contract VerifyWiring is ChainConfig {
    using stdJson for string;

    function run() external view {
        Config memory c = _readConfig();
        Core memory d = _readCore();
        string memory json = vm.readFile(_deploymentPath());
        _verify(d, c, _readTimelock(), json.readAddress(".deployer"));
        console2.log("wiring verified: peers, signers, beta cap, token hooks off, timelock in charge");
        if (json.readAddress(".contracts.X402Escrow") != address(0)) {
            _verifyPayments(d, _readPayments(), c);
            console2.log("payments verified: escrow and channels wired to the vault");
        }
        if (json.readAddress(".contracts.WindowMarket") != address(0)) {
            _verifyMarkets(d, _readMarkets(), c, _readTimelock());
            console2.log("markets verified: Windows and token hooks wired, timelock owns both");
        }
    }
}
