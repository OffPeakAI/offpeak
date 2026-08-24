// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFeeSplitter} from "../src/interfaces/IFeeSplitter.sol";
import {Script} from "forge-std/Script.sol";
import {AuditCourt} from "../src/AuditCourt.sol";
import {ChannelManager} from "../src/ChannelManager.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {HostRegistry} from "../src/HostRegistry.sol";
import {OffpeakVault} from "../src/OffpeakVault.sol";
import {OfpkHooks} from "../src/OfpkHooks.sol";
import {UsageLedger} from "../src/UsageLedger.sol";
import {WindowMarket} from "../src/WindowMarket.sol";
import {X402Escrow} from "../src/X402Escrow.sol";
import {IHostRegistry} from "../src/interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "../src/interfaces/IOffpeakVault.sol";
import {IOfpkHooks} from "../src/interfaces/IOfpkHooks.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {IUsageLedger} from "../src/interfaces/IUsageLedger.sol";
import {MockOFPK} from "../src/mocks/MockOFPK.sol";
import {MockSwapAdapter} from "../src/mocks/MockSwapAdapter.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @notice Deploys every contract on local anvil from a fresh deployer. `bun run chain:local` drives this.
/// The nonce order keeps addresses stable, because the golden vectors are signed over them.
contract DeployLocal is Script {
    error UnexpectedAddress(string name, address expected, address actual);

    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    ISignatureTransfer internal constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    string internal constant OUTPUT = "../packages/abis/deployments/local.json";
    string[] internal GPU_CLASSES = [
        "h100-80g-sxm", "h100-80g-pcie", "h200-141g", "a100-80g", "l40s-48g", "rtx4090-24g", "cpu-tdx-dev"
    ];

    struct Roles {
        address router;
        address host;
        address buyer;
        address[3] settlers;
        address[3] rulers;
        address guardian;
        address relay;
        address capturer;
        address keeper;
        address channelPayee;
        address panel;
        address treasury;
        address opsWallet;
    }

    struct Peers {
        address vault;
        address registry;
        address ledger;
        address hooks;
        address splitter;
    }

    struct Deployed {
        MockUSDG usdg;
        MockOFPK ofpk;
        OffpeakVault vault;
        HostRegistry registry;
        UsageLedger ledger;
        X402Escrow escrow;
        ChannelManager channels;
        MockSwapAdapter adapter;
        WindowMarket windows;
        AuditCourt court;
        OfpkHooks hooks;
        FeeSplitter splitter;
    }

    function run() external {
        address deployer = msg.sender;
        Roles memory r = _roles();
        Peers memory p = _predict(deployer);
        Deployed memory d;

        vm.startBroadcast(deployer);
        _deployTokens(d);
        _deployCore(d, deployer, r, p);
        _deployMarkets(d, deployer, r, p);
        _wire(d, r);
        vm.stopBroadcast();

        _expect("OffpeakVault", p.vault, address(d.vault));
        _expect("HostRegistry", p.registry, address(d.registry));
        _expect("UsageLedger", p.ledger, address(d.ledger));
        _expect("OfpkHooks", p.hooks, address(d.hooks));
        _expect("FeeSplitter", p.splitter, address(d.splitter));
        _write(d, r);
    }

    function _predict(address deployer) private view returns (Peers memory p) {
        uint64 start = vm.getNonce(deployer);
        p.vault = vm.computeCreateAddress(deployer, start + 2);
        p.registry = vm.computeCreateAddress(deployer, start + 3);
        p.ledger = vm.computeCreateAddress(deployer, start + 4);
        p.splitter = vm.computeCreateAddress(deployer, start + 10);
        p.hooks = vm.computeCreateAddress(deployer, start + 12);
    }

    function _deployTokens(Deployed memory d) private {
        d.usdg = new MockUSDG();
        d.ofpk = new MockOFPK();
    }

    function _deployCore(Deployed memory d, address deployer, Roles memory r, Peers memory p) private {
        IERC20 usdg = IERC20(address(d.usdg));
        d.vault = new OffpeakVault(
            deployer, usdg, PERMIT2, IUsageLedger(p.ledger), IHostRegistry(p.registry), r.settlers, r.guardian
        );
        d.registry = new HostRegistry(deployer, usdg, IERC20(address(d.ofpk)), r.guardian, r.treasury);
        d.ledger = new UsageLedger(deployer, r.router);
    }

    /// Nonces 7 and 11 fall between the contracts' vector addresses, so a mock and a mint take those slots.
    function _deployMarkets(Deployed memory d, address deployer, Roles memory r, Peers memory p) private {
        IERC20 usdg = IERC20(address(d.usdg));
        IHostRegistry registry = IHostRegistry(p.registry);
        d.escrow = new X402Escrow(usdg, PERMIT2, p.vault, r.relay, r.capturer);
        d.channels = new ChannelManager(usdg, PERMIT2, p.vault, r.channelPayee, r.keeper);
        d.adapter = new MockSwapAdapter(usdg, d.ofpk);
        d.windows = new WindowMarket(deployer, usdg, registry, IOfpkHooks(p.hooks), p.vault, p.splitter);
        d.court = new AuditCourt(deployer, usdg, registry, IOffpeakVault(p.vault), r.rulers, r.panel, r.treasury);
        d.splitter = new FeeSplitter(deployer, usdg, registry, r.opsWallet, r.treasury);
        d.usdg.mint(r.buyer, 10_000e6);
        d.hooks = new OfpkHooks(deployer, IERC20(address(d.ofpk)), registry, IFeeSplitter(p.splitter));
    }

    function _wire(Deployed memory d, Roles memory r) private {
        d.vault.setPeers(address(d.windows), address(d.splitter), address(d.escrow), address(d.channels));
        d.registry.setPeers(address(d.vault), address(d.windows), address(d.court), address(d.splitter));
        d.ledger.setVault(address(d.vault));
        d.splitter.setPeers(address(d.vault), address(d.windows));
        for (uint256 i; i < GPU_CLASSES.length; ++i) {
            d.registry.setGpuClass(keccak256(bytes(GPU_CLASSES[i])), true);
        }
        d.usdg.mint(r.host, 10_000e6);
    }

    function _write(Deployed memory d, Roles memory r) private {
        string memory addresses = "contracts";
        vm.serializeAddress(addresses, "MockUSDG", address(d.usdg));
        vm.serializeAddress(addresses, "MockOFPK", address(d.ofpk));
        vm.serializeAddress(addresses, "MockSwapAdapter", address(d.adapter));
        vm.serializeAddress(addresses, "OffpeakVault", address(d.vault));
        vm.serializeAddress(addresses, "HostRegistry", address(d.registry));
        vm.serializeAddress(addresses, "UsageLedger", address(d.ledger));
        vm.serializeAddress(addresses, "X402Escrow", address(d.escrow));
        vm.serializeAddress(addresses, "ChannelManager", address(d.channels));
        vm.serializeAddress(addresses, "WindowMarket", address(d.windows));
        vm.serializeAddress(addresses, "AuditCourt", address(d.court));
        vm.serializeAddress(addresses, "OfpkHooks", address(d.hooks));
        vm.serializeAddress(addresses, "FeeSplitter", address(d.splitter));
        string memory contractsJson = vm.serializeAddress(addresses, "Permit2", address(PERMIT2));

        string memory people = "roles";
        vm.serializeAddress(people, "router", r.router);
        vm.serializeAddress(people, "host", r.host);
        vm.serializeAddress(people, "buyer", r.buyer);
        vm.serializeAddress(people, "settlers", _dynamic(r.settlers));
        vm.serializeAddress(people, "rulers", _dynamic(r.rulers));
        vm.serializeAddress(people, "guardian", r.guardian);
        vm.serializeAddress(people, "relay", r.relay);
        vm.serializeAddress(people, "capturer", r.capturer);
        vm.serializeAddress(people, "keeper", r.keeper);
        vm.serializeAddress(people, "channelPayee", r.channelPayee);
        vm.serializeAddress(people, "panel", r.panel);
        vm.serializeAddress(people, "treasury", r.treasury);
        string memory rolesJson = vm.serializeAddress(people, "opsWallet", r.opsWallet);

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "contracts", contractsJson);
        vm.writeJson(vm.serializeString(root, "roles", rolesJson), OUTPUT);
    }

    /// Accounts 1-9 match the vector signers in packages/shared/src/test-keys.ts; 10-17 are the remaining roles.
    function _roles() private pure returns (Roles memory r) {
        r.router = _account(1);
        r.host = _account(2);
        r.buyer = _account(3);
        r.settlers = _sorted(_account(4), _account(5), _account(6));
        r.rulers = _sorted(_account(7), _account(8), _account(9));
        r.guardian = _account(10);
        r.relay = _account(11);
        r.capturer = _account(12);
        r.keeper = _account(13);
        r.channelPayee = _account(14);
        r.panel = _account(15);
        r.treasury = _account(16);
        r.opsWallet = _account(17);
    }

    function _account(uint32 index) private pure returns (address) {
        return vm.addr(vm.deriveKey(MNEMONIC, index));
    }

    function _sorted(address a, address b, address c) private pure returns (address[3] memory set) {
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        set = [a, b, c];
    }

    function _dynamic(address[3] memory set) private pure returns (address[] memory out) {
        out = new address[](3);
        for (uint256 i; i < 3; ++i) {
            out[i] = set[i];
        }
    }

    function _expect(string memory name, address expected, address actual) private pure {
        if (expected != actual) revert UnexpectedAddress(name, expected, actual);
    }
}
