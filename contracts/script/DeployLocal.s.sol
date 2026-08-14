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
