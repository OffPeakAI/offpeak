// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployCore} from "../../script/DeployCore.sol";

/// @notice Stands in for the deployer key, so tests run the same code the scripts do.
contract DeployHarness is DeployCore {
    function preflight(Config memory c) external view {
        _preflight(c);
    }

    function deploy(Config memory c) external returns (Core memory) {
        return _deploy(c, address(this));
    }

    function handOff(Core memory d, address multisig) external returns (TimelockController) {
        return _handOff(d, multisig, address(this));
    }

    function verify(Core memory d, Config memory c, TimelockController timelock) external view {
        _verify(d, c, timelock, address(this));
    }

    function deployPayments(Config memory c, Core memory d) external returns (Payments memory) {
        return _deployPayments(c, d);
    }

    function paymentsProposal(Core memory d, Payments memory p) external pure returns (Proposal memory) {
        return _paymentsProposal(d, p);
    }

    function verifyPayments(Core memory d, Payments memory p, Config memory c) external view {
        _verifyPayments(d, p, c);
    }

    function deployMarkets(Config memory c, Core memory d, address timelock) external returns (Markets memory) {
        return _deployMarkets(c, d, timelock);
    }

    function marketsProposal(Core memory d, Markets memory m) external pure returns (Proposal memory) {
        return _marketsProposal(d, m);
    }

    function verifyMarkets(Core memory d, Markets memory m, Config memory c, TimelockController timelock) external view {
        _verifyMarkets(d, m, c, timelock);
    }

    function probe(address usdg) external view returns (bool, bool) {
        return _probeUsdg(usdg);
    }
}

contract MockSafe {
    address[] internal _owners;

    constructor(address[] memory owners_) {
        _owners = owners_;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}
