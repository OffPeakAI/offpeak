// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {ChainConfig} from "./ChainConfig.sol";

/// @notice Deploys the payment contracts and writes the timelock proposal that wires them to the vault.
/// Nothing goes live until the multisig schedules it and the 48 hour delay passes.
contract DeployP2 is ChainConfig {
    function run() external {
        Config memory c = _readConfig();
        Core memory d = _readCore();

        vm.startBroadcast();
        Payments memory p = _deployPayments(c, d);
        vm.stopBroadcast();

        string memory path = _deploymentPath();
        vm.writeJson(vm.toString(address(p.escrow)), path, ".contracts.X402Escrow");
        vm.writeJson(vm.toString(address(p.channels)), path, ".contracts.ChannelManager");
        _writeProposal("p2", _readTimelock(), _paymentsProposal(d, p));
        console2.log("escrow", address(p.escrow));
        console2.log("channels", address(p.channels));
    }
}
