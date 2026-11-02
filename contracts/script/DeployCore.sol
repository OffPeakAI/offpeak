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
    error CodeMismatch(string name, bytes32 actual, bytes32 expected);
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

    /// Accepts ownership at zero delay, raises the delay to 48 hours, then leaves the multisig alone in charge.
    function _handOff(Core memory d, address multisig, address deployer) internal returns (TimelockController timelock) {
        address[] memory temporary = new address[](1);
        temporary[0] = deployer;
        timelock = new TimelockController(0, temporary, temporary, deployer);

        address[5] memory owned = _owned(d);
        address[] memory targets = new address[](owned.length + 1);
        uint256[] memory values = new uint256[](owned.length + 1);
        bytes[] memory payloads = new bytes[](owned.length + 1);
        for (uint256 i; i < owned.length; ++i) {
            OffpeakVault(owned[i]).transferOwnership(address(timelock));
            targets[i] = owned[i];
            payloads[i] = abi.encodeWithSignature("acceptOwnership()");
        }
        targets[owned.length] = address(timelock);
        payloads[owned.length] = abi.encodeCall(TimelockController.updateDelay, (TIMELOCK_DELAY));
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), 0);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));

        timelock.grantRole(timelock.PROPOSER_ROLE(), multisig);
        timelock.grantRole(timelock.EXECUTOR_ROLE(), multisig);
        timelock.grantRole(timelock.CANCELLER_ROLE(), multisig);
        timelock.renounceRole(timelock.PROPOSER_ROLE(), deployer);
        timelock.renounceRole(timelock.EXECUTOR_ROLE(), deployer);
        timelock.renounceRole(timelock.CANCELLER_ROLE(), deployer);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), deployer);
    }

    /// Payment contracts have no owner, so only the vault's peers need the timelock.
    function _deployPayments(Config memory c, Core memory d) internal returns (Payments memory p) {
        ISignatureTransfer permit2 = ISignatureTransfer(c.permit2);
        p.escrow = new X402Escrow(IERC20(c.usdg), permit2, address(d.vault), c.relay, c.capturer);
        p.channels = new ChannelManager(IERC20(c.usdg), permit2, address(d.vault), c.channelPayee, c.keeper);
    }

    function _paymentsProposal(Core memory d, Payments memory p) internal pure returns (Proposal memory proposal) {
        proposal.targets = new address[](1);
        proposal.values = new uint256[](1);
        proposal.payloads = new bytes[](1);
        proposal.targets[0] = address(d.vault);
        proposal.payloads[0] = abi.encodeCall(OffpeakVault.setPeers, (address(0), address(0), address(p.escrow), address(p.channels)));
    }

    /// The timelock owns both from birth, so there is nothing to hand over afterwards.
    function _deployMarkets(Config memory c, Core memory d, address timelock) internal returns (Markets memory m) {
        IHostRegistry registry = IHostRegistry(address(d.registry));
        IFeeSplitter splitter = IFeeSplitter(address(d.splitter));
        m.hooks = new OfpkHooks(timelock, IERC20(c.ofpk), registry, splitter);
        m.windows = new WindowMarket(timelock, IERC20(c.usdg), registry, IOfpkHooks(address(m.hooks)), address(d.vault), address(d.splitter));
    }

    function _marketsProposal(Core memory d, Markets memory m) internal pure returns (Proposal memory proposal) {
        address windows = address(m.windows);
        proposal.targets = new address[](3);
        proposal.values = new uint256[](3);
        proposal.payloads = new bytes[](3);
        proposal.targets[0] = address(d.vault);
        proposal.payloads[0] = abi.encodeCall(OffpeakVault.setPeers, (windows, address(0), address(0), address(0)));
        proposal.targets[1] = address(d.registry);
        proposal.payloads[1] = abi.encodeCall(HostRegistry.setPeers, (address(0), windows, address(0), address(0)));
        proposal.targets[2] = address(d.splitter);
        proposal.payloads[2] = abi.encodeCall(FeeSplitter.setPeers, (address(0), windows));
    }

    function _owned(Core memory d) internal pure returns (address[5] memory) {
        return [address(d.ledger), address(d.registry), address(d.vault), address(d.court), address(d.splitter)];
    }

    function _require(bool ok, string memory check) private pure {
        if (!ok) revert WiringMismatch(check);
    }

    function _verifyPeers(Core memory d, Config memory c) private view {
        _require(d.vault.ledger() == IUsageLedger(address(d.ledger)), "vault.ledger");
        _require(d.vault.registry() == IHostRegistry(address(d.registry)), "vault.registry");
        _require(address(d.vault.usdg()) == c.usdg, "vault.usdg");
        _require(address(d.vault.permit2()) == c.permit2, "vault.permit2");
        _require(address(d.vault.feeSplitter()) == address(d.splitter), "vault.feeSplitter");
        _require(d.ledger.vault() == address(d.vault), "ledger.vault");
        _require(d.ledger.routerSigner() == c.routerSigner, "ledger.routerSigner");
        _require(address(d.registry.usdg()) == c.usdg, "registry.usdg");
        _require(address(d.registry.ofpk()) == c.ofpk, "registry.ofpk");
        _require(d.registry.vault() == address(d.vault), "registry.vault");
        _require(d.registry.auditCourt() == address(d.court), "registry.auditCourt");
        _require(d.registry.feeSplitter() == address(d.splitter), "registry.feeSplitter");
        _require(d.registry.guardian() == c.guardian, "registry.guardian");
        _require(d.registry.treasury() == c.treasury, "registry.treasury");
        _require(address(d.splitter.usdg()) == c.usdg, "splitter.usdg");
        _require(address(d.splitter.registry()) == address(d.registry), "splitter.registry");
        _require(address(d.splitter.vault()) == address(d.vault), "splitter.vault");
        _require(d.splitter.treasury() == c.treasury, "splitter.treasury");
        _require(d.splitter.opsWallet() == c.opsWallet, "splitter.opsWallet");
        _require(address(d.court.usdg()) == c.usdg, "court.usdg");
        _require(address(d.court.vault()) == address(d.vault), "court.vault");
        _require(address(d.court.registry()) == address(d.registry), "court.registry");
        _require(d.court.panel() == c.panel, "court.panel");
        _require(d.court.treasury() == c.treasury, "court.treasury");
    }

    function _verifySigners(Core memory d, Config memory c) private view {
        for (uint256 i; i < 3; ++i) {
            _require(d.vault.settlers(i) == c.settlers[i], "vault.settlers");
            _require(d.court.rulers(i) == c.rulers[i], "court.rulers");
        }
        _require(d.vault.guardian() == c.guardian, "vault.guardian");
    }

    function _verifyLaunchFlags(Core memory d, Config memory c) private view {
        _require(d.vault.betaCapEnabled() != c.betaCapLifted, "beta cap matches the config");
        _require(d.vault.BETA_CAP() == 500e6, "beta cap is 500 USDG");
        _require(!d.vault.usagePaused(), "usage not paused");
        _require(!d.vault.settlesPaused(), "settles not paused");
        _require(!d.splitter.tokenHooksEnabled(), "token hooks are off");
        _require(d.splitter.swapAdapter() == address(0), "no swap adapter");
        _require(d.splitter.burnKeeper() == address(0), "no burn keeper");
        _require(!d.registry.allowedGpuClass(keccak256("cpu-tdx-dev")), "no dev GPU class");
        string[6] memory classes = _gpuClasses();
        for (uint256 i; i < classes.length; ++i) {
            _require(d.registry.allowedGpuClass(keccak256(bytes(classes[i]))), "gpu classes");
        }
    }

    function _verifyOwnership(Core memory d, TimelockController timelock, address multisig, address deployer) private view {
        address[5] memory owned = _owned(d);
        for (uint256 i; i < owned.length; ++i) {
            _require(OffpeakVault(owned[i]).owner() == address(timelock), "owner is the timelock");
            _require(OffpeakVault(owned[i]).pendingOwner() == address(0), "no pending owner");
        }
        _require(timelock.getMinDelay() == TIMELOCK_DELAY, "timelock delay is 48 hours");
        bytes32[4] memory roles =
            [timelock.PROPOSER_ROLE(), timelock.EXECUTOR_ROLE(), timelock.CANCELLER_ROLE(), timelock.DEFAULT_ADMIN_ROLE()];
        for (uint256 i; i < roles.length; ++i) {
            _require(!timelock.hasRole(roles[i], deployer), "deployer holds nothing");
            if (i < 3) _require(timelock.hasRole(roles[i], multisig), "multisig holds the timelock");
        }
    }

    /// Read-only. It reverts naming the first check that fails.
    function _verify(Core memory d, Config memory c, TimelockController timelock, address deployer) internal view {
        _verifyPeers(d, c);
        _verifySigners(d, c);
        _verifyLaunchFlags(d, c);
        _verifyOwnership(d, timelock, c.multisig, deployer);
    }

    /// Read-only, and run once the timelock has executed the payments proposal.
    function _verifyPayments(Core memory d, Payments memory p, Config memory c) internal view {
        _require(d.vault.x402Escrow() == address(p.escrow), "vault.x402Escrow");
        _require(d.vault.channelManager() == address(p.channels), "vault.channelManager");
        _require(address(p.escrow.usdg()) == c.usdg, "escrow.usdg");
        _require(address(p.escrow.permit2()) == c.permit2, "escrow.permit2");
        _require(p.escrow.payee() == address(d.vault), "escrow.payee");
        _require(p.escrow.relay() == c.relay, "escrow.relay");
        _require(p.escrow.capturer() == c.capturer, "escrow.capturer");
        _require(address(p.channels.usdg()) == c.usdg, "channels.usdg");
        _require(address(p.channels.permit2()) == c.permit2, "channels.permit2");
        _require(p.channels.vault() == address(d.vault), "channels.vault");
        _require(p.channels.payee() == c.channelPayee, "channels.payee");
        _require(p.channels.keeper() == c.keeper, "channels.keeper");
    }

    /// Read-only, and run once the timelock has executed the markets proposal.
    function _verifyMarkets(Core memory d, Markets memory m, Config memory c, TimelockController timelock) internal view {
        _require(address(d.vault.windowMarket()) == address(m.windows), "vault.windowMarket");
        _require(d.registry.windowMarket() == address(m.windows), "registry.windowMarket");
        _require(d.splitter.windowMarket() == address(m.windows), "splitter.windowMarket");
        _require(address(m.windows.usdg()) == c.usdg, "windows.usdg");
        _require(m.windows.owner() == address(timelock), "windows.owner");
        _require(address(m.windows.registry()) == address(d.registry), "windows.registry");
        _require(address(m.windows.hooks()) == address(m.hooks), "windows.hooks");
        _require(m.windows.vault() == address(d.vault), "windows.vault");
        _require(m.windows.feeSplitter() == address(d.splitter), "windows.feeSplitter");
        _require(m.hooks.owner() == address(timelock), "hooks.owner");
        _require(address(m.hooks.ofpk()) == c.ofpk, "hooks.ofpk");
        _require(address(m.hooks.registry()) == address(d.registry), "hooks.registry");
        _require(address(m.hooks.splitter()) == address(d.splitter), "hooks.splitter");
    }

    function vm_toString(uint256 index) private pure returns (string memory) {
        bytes memory out = new bytes(2);
        out[0] = bytes1(uint8(48 + index / 10));
        out[1] = bytes1(uint8(48 + index % 10));
        return string(out);
    }
}
