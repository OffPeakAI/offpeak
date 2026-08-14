// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AuditCourt} from "../src/AuditCourt.sol";
import {ChannelManager} from "../src/ChannelManager.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {HostRegistry} from "../src/HostRegistry.sol";
import {OffpeakVault} from "../src/OffpeakVault.sol";
import {OfpkHooks} from "../src/OfpkHooks.sol";
import {UsageLedger} from "../src/UsageLedger.sol";
import {WindowMarket} from "../src/WindowMarket.sol";
import {X402Escrow} from "../src/X402Escrow.sol";
import {DeployCore} from "./DeployCore.sol";

/// @notice Reads `config/chains/4663.json` and the deployment file the scripts share.
abstract contract ChainConfig is Script, DeployCore {
    using stdJson for string;

    /// `deploy:rehearse` points these at throwaway files so the real ones stay untouched.
    function _configPath() internal view returns (string memory) {
        return vm.envOr("OFFPEAK_CHAIN_CONFIG", string("config/chains/4663.json"));
    }

    function _deploymentPath() internal view returns (string memory) {
        return vm.envOr("OFFPEAK_DEPLOYMENT_OUT", string("../packages/abis/deployments/4663.json"));
    }

    function _three(string memory json, string memory key) private pure returns (address[3] memory set) {
        address[] memory list = json.readAddressArray(key);
        set = [list[0], list[1], list[2]];
    }

    function _readConfig() internal view returns (Config memory c) {
        string memory json = vm.readFile(_configPath());
        c.usdg = json.readAddress(".usdg");
        c.usdgSymbol = json.readString(".usdgSymbol");
        c.permit2 = json.readAddress(".permit2");
        c.permit2CodeHash = json.readBytes32(".permit2CodeHash");
        c.ofpk = json.readAddress(".ofpk");
        c.settlers = _three(json, ".settlers");
        c.rulers = _three(json, ".rulers");
        c.panel = json.readAddress(".panel");
        c.guardian = json.readAddress(".guardian");
        c.multisig = json.readAddress(".multisig");
        c.relay = json.readAddress(".relay");
        c.capturer = json.readAddress(".capturer");
        c.keeper = json.readAddress(".keeper");
        c.channelPayee = json.readAddress(".channelPayee");
        c.routerSigner = json.readAddress(".routerSigner");
        c.treasury = json.readAddress(".treasury");
        c.opsWallet = json.readAddress(".opsWallet");
        c.betaCapLifted = json.readBool(".betaCapLifted");
    }

    function _readCore() internal view returns (Core memory d) {
        string memory json = vm.readFile(_deploymentPath());
        d.ledger = UsageLedger(json.readAddress(".contracts.UsageLedger"));
        d.registry = HostRegistry(json.readAddress(".contracts.HostRegistry"));
        d.vault = OffpeakVault(json.readAddress(".contracts.OffpeakVault"));
        d.court = AuditCourt(json.readAddress(".contracts.AuditCourt"));
        d.splitter = FeeSplitter(json.readAddress(".contracts.FeeSplitter"));
    }

    function _readPayments() internal view returns (Payments memory p) {
        string memory json = vm.readFile(_deploymentPath());
        p.escrow = X402Escrow(json.readAddress(".contracts.X402Escrow"));
        p.channels = ChannelManager(json.readAddress(".contracts.ChannelManager"));
    }

    function _readMarkets() internal view returns (Markets memory m) {
        string memory json = vm.readFile(_deploymentPath());
        m.hooks = OfpkHooks(json.readAddress(".contracts.OfpkHooks"));
        m.windows = WindowMarket(json.readAddress(".contracts.WindowMarket"));
    }

    function _proposalPath(string memory phase) internal view returns (string memory) {
        return string.concat(vm.envOr("OFFPEAK_PROPOSAL_DIR", string("../packages/abis/deployments/")), phase, "-proposal.json");
    }

    /// Writes the exact calldata the multisig pastes in, so nobody builds a proposal by hand.
    function _writeProposal(string memory phase, TimelockController timelock, Proposal memory p) internal {
        bytes32 salt = keccak256(bytes(phase));
        string memory root = phase;
        vm.serializeAddress(root, "timelock", address(timelock));
        vm.serializeUint(root, "delaySeconds", TIMELOCK_DELAY);
        vm.serializeAddress(root, "targets", p.targets);
        vm.serializeBytes(
            root, "schedule", abi.encodeCall(TimelockController.scheduleBatch, (p.targets, p.values, p.payloads, bytes32(0), salt, TIMELOCK_DELAY))
        );
        vm.writeJson(
            vm.serializeBytes(
                root, "execute", abi.encodeCall(TimelockController.executeBatch, (p.targets, p.values, p.payloads, bytes32(0), salt))
            ),
            _proposalPath(phase)
        );
    }

    function _readTimelock() internal view returns (TimelockController) {
        return TimelockController(payable(vm.readFile(_deploymentPath()).readAddress(".timelock")));
    }

    function _writeDeployment(Core memory d, address timelock, bool eip2612, bool eip3009, address deployer) internal {
        string memory contracts = "contracts";
        vm.serializeAddress(contracts, "UsageLedger", address(d.ledger));
        vm.serializeAddress(contracts, "HostRegistry", address(d.registry));
        vm.serializeAddress(contracts, "OffpeakVault", address(d.vault));
        vm.serializeAddress(contracts, "AuditCourt", address(d.court));
        vm.serializeAddress(contracts, "FeeSplitter", address(d.splitter));
        vm.serializeAddress(contracts, "MockUSDG", address(0));
        vm.serializeAddress(contracts, "MockOFPK", address(0));
        vm.serializeAddress(contracts, "MockSwapAdapter", address(0));
        vm.serializeAddress(contracts, "X402Escrow", address(0));
        vm.serializeAddress(contracts, "ChannelManager", address(0));
        vm.serializeAddress(contracts, "WindowMarket", address(0));
        vm.serializeAddress(contracts, "OfpkHooks", address(0));
        string memory table = vm.serializeAddress(contracts, "Permit2", address(d.vault.permit2()));

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "name", "mainnet");
        vm.serializeBool(root, "deployed", true);
        vm.serializeString(root, "note", "P1 contracts. Payment, Window and token contracts join after their audits.");
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeAddress(root, "timelock", timelock);
        vm.serializeBool(root, "usdgHasEip2612", eip2612);
        vm.serializeBool(root, "usdgHasEip3009", eip3009);
        vm.writeJson(vm.serializeString(root, "contracts", table), _deploymentPath());
    }
}
