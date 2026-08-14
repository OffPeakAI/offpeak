// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuditCourt} from "../src/AuditCourt.sol";
import {ChannelManager} from "../src/ChannelManager.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {HostRegistry} from "../src/HostRegistry.sol";
import {OffpeakVault} from "../src/OffpeakVault.sol";
import {OfpkHooks} from "../src/OfpkHooks.sol";
import {UsageLedger} from "../src/UsageLedger.sol";
import {WindowMarket} from "../src/WindowMarket.sol";
import {X402Escrow} from "../src/X402Escrow.sol";
import {IFeeSplitter} from "../src/interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "../src/interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "../src/interfaces/IOffpeakVault.sol";
import {IOfpkHooks} from "../src/interfaces/IOfpkHooks.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {IUsageLedger} from "../src/interfaces/IUsageLedger.sol";

interface ISafe {
    function getOwners() external view returns (address[] memory);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice P1 contracts only. Payment and Window contracts join through `setPeers` after their own audits.
abstract contract DeployCore {
    error BadChain(uint256 chainId);
    error BadPermit2CodeHash(bytes32 actual, bytes32 expected);
    error BadUsdg(string reason);
    error PanelOverlap(address owner);
    error PanelNotASafe(address panel);
    error RoleMissing(string role);
    error RolesNotDistinct(address role);
    error WiringMismatch(string check);

    uint256 internal constant CHAIN_ID = 4663;
    uint256 internal constant TIMELOCK_DELAY = 48 hours;

    struct Config {
        address usdg;
        string usdgSymbol;
        address permit2;
        bytes32 permit2CodeHash;
        address ofpk;
        address[3] settlers;
        address[3] rulers;
        address panel;
        address guardian;
        address multisig;
        address relay;
        address capturer;
        address keeper;
        address channelPayee;
        address routerSigner;
        address treasury;
        address opsWallet;
        bool betaCapLifted;
    }

    struct Core {
        UsageLedger ledger;
        HostRegistry registry;
        OffpeakVault vault;
        AuditCourt court;
        FeeSplitter splitter;
    }

    struct Payments {
        X402Escrow escrow;
        ChannelManager channels;
    }

    struct Markets {
        OfpkHooks hooks;
        WindowMarket windows;
    }

    /// What the multisig schedules on the timelock, then executes 48 hours later.
    struct Proposal {
        address[] targets;
        uint256[] values;
        bytes[] payloads;
    }

    function _gpuClasses() internal pure returns (string[6] memory) {
        return ["h100-80g-sxm", "h100-80g-pcie", "h200-141g", "a100-80g", "l40s-48g", "rtx4090-24g"];
    }

    function _roles(Config memory c) internal pure returns (address[15] memory) {
        return [
            c.settlers[0],
            c.settlers[1],
            c.settlers[2],
            c.rulers[0],
            c.rulers[1],
            c.rulers[2],
            c.panel,
            c.guardian,
            c.multisig,
            c.relay,
            c.capturer,
            c.keeper,
            c.channelPayee,
            c.routerSigner,
            c.treasury
        ];
    }

    /// Everything here runs before a single transaction, so a bad config costs nothing.
    function _preflight(Config memory c) internal view {
        if (block.chainid != CHAIN_ID) revert BadChain(block.chainid);
        if (c.usdg.code.length == 0) revert BadUsdg("no code");
        if (IERC20Metadata(c.usdg).decimals() != 6) revert BadUsdg("decimals");
        string memory symbol = IERC20Metadata(c.usdg).symbol();
        if (keccak256(bytes(symbol)) != keccak256(bytes(c.usdgSymbol))) revert BadUsdg("symbol");
        if (c.permit2.codehash != c.permit2CodeHash) revert BadPermit2CodeHash(c.permit2.codehash, c.permit2CodeHash);

        address[15] memory roles = _roles(c);
        for (uint256 i; i < roles.length; ++i) {
            if (roles[i] == address(0)) revert RoleMissing(vm_toString(i));
            if (roles[i] == c.opsWallet) revert RolesNotDistinct(roles[i]);
            for (uint256 j = i + 1; j < roles.length; ++j) {
                if (roles[i] == roles[j]) revert RolesNotDistinct(roles[i]);
            }
        }
        if (c.opsWallet == address(0)) revert RoleMissing("opsWallet");
        _requireIndependentPanel(c);
    }

    function _requireIndependentPanel(Config memory c) private view {
        if (c.panel.code.length == 0) revert PanelNotASafe(c.panel);
        address[] memory owners;
        try ISafe(c.panel).getOwners() returns (address[] memory found) {
            owners = found;
        } catch {
            revert PanelNotASafe(c.panel);
        }
        address[9] memory forbidden = [
            c.settlers[0],
            c.settlers[1],
            c.settlers[2],
            c.rulers[0],
            c.rulers[1],
            c.rulers[2],
            c.relay,
            c.capturer,
            c.keeper
        ];
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == c.routerSigner) revert PanelOverlap(owners[i]);
            for (uint256 j; j < forbidden.length; ++j) {
                if (owners[i] == forbidden[j]) revert PanelOverlap(owners[i]);
            }
        }
    }

    /// Informational: Offpeak uses Permit2 either way.
    function _probeUsdg(address usdg) internal view returns (bool eip2612, bool eip3009) {
        (eip2612,) = usdg.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        (eip3009,) = usdg.staticcall(abi.encodeWithSignature("authorizationState(address,bytes32)", address(1), bytes32(0)));
    }

    function _deploy(Config memory c, address deployer) internal returns (Core memory d) {
        IERC20 usdg = IERC20(c.usdg);
        d.ledger = new UsageLedger(deployer, c.routerSigner);
        d.registry = new HostRegistry(deployer, usdg, IERC20(c.ofpk), c.guardian, c.treasury);
        d.vault = new OffpeakVault(
            deployer,
            usdg,
            ISignatureTransfer(c.permit2),
            IUsageLedger(address(d.ledger)),
            IHostRegistry(address(d.registry)),
            c.settlers,
            c.guardian
        );
        d.court = new AuditCourt(
            deployer, usdg, IHostRegistry(address(d.registry)), IOffpeakVault(address(d.vault)), c.rulers, c.panel, c.treasury
        );
        d.splitter = new FeeSplitter(deployer, usdg, IHostRegistry(address(d.registry)), c.opsWallet, c.treasury);

        d.ledger.setVault(address(d.vault));
        d.vault.setPeers(address(0), address(d.splitter), address(0), address(0));
        d.registry.setPeers(address(d.vault), address(0), address(d.court), address(d.splitter));
        d.splitter.setPeers(address(d.vault), address(0));
        string[6] memory classes = _gpuClasses();
        for (uint256 i; i < classes.length; ++i) {
            d.registry.setGpuClass(keccak256(bytes(classes[i])), true);
        }
    }
