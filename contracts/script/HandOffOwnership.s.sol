// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ChainConfig} from "./ChainConfig.sol";

/// @notice Step 2 of 3. The deployer key holds nothing afterwards.
contract HandOffOwnership is ChainConfig {
    using stdJson for string;

    function run() external {
        Config memory c = _readConfig();
        Core memory d = _readCore();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        TimelockController timelock = _handOff(d, c.multisig, deployer);
        vm.stopBroadcast();

        string memory json = vm.readFile(_deploymentPath());
        _writeDeployment(d, address(timelock), json.readBool(".usdgHasEip2612"), json.readBool(".usdgHasEip3009"), deployer);
        console2.log("timelock", address(timelock));
    }
}
