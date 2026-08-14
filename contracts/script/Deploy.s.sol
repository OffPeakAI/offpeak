// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {ChainConfig} from "./ChainConfig.sol";

/// @notice Step 1 of 3. Pre-flight, then the P1 contracts with the beta cap on and token hooks off.
contract Deploy is ChainConfig {
    function run() external {
        Config memory c = _readConfig();
        _preflight(c);
        (bool eip2612, bool eip3009) = _probeUsdg(c.usdg);
        console2.log("pre-flight passed");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Core memory d = _deploy(c, deployer);
        vm.stopBroadcast();

        _writeDeployment(d, address(0), eip2612, eip3009, deployer);
        console2.log("vault", address(d.vault));
    }
}
