// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {ChainConfig} from "./ChainConfig.sol";

/// @notice Deploys Windows and the token hooks, and writes the timelock proposal that wires them in.
/// The hooks stay off until the legal gate turns on `tokenHooksEnabled`, which this script never touches.
contract DeployP3 is ChainConfig {
    function run() external {
        Config memory c = _readConfig();
        Core memory d = _readCore();
        address timelock = address(_readTimelock());

        vm.startBroadcast();
        Markets memory m = _deployMarkets(c, d, timelock);
        vm.stopBroadcast();

        string memory path = _deploymentPath();
        vm.writeJson(vm.toString(address(m.hooks)), path, ".contracts.OfpkHooks");
        vm.writeJson(vm.toString(address(m.windows)), path, ".contracts.WindowMarket");
        _writeProposal("p3", _readTimelock(), _marketsProposal(d, m));
        console2.log("hooks", address(m.hooks));
        console2.log("windows", address(m.windows));
    }
}
