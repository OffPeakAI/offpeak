// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import {OffpeakVault} from "../../src/OffpeakVault.sol";
import {OfpkHooks} from "../../src/OfpkHooks.sol";
import {UsageLedger} from "../../src/UsageLedger.sol";
import {WindowMarketHarness} from "./WindowMarketHarness.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import {IOfpkHooks} from "../../src/interfaces/IOfpkHooks.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {IUsageLedger} from "../../src/interfaces/IUsageLedger.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {HourMath} from "../../src/lib/HourMath.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {MockOFPK} from "../../src/mocks/MockOFPK.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";

abstract contract VaultFixture is Test {
    uint256 internal constant START = 1_800_000_000;
    uint64 internal constant START_HOUR = uint64(START / 3600);
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    MockUSDG internal usdg;
    MockOFPK internal ofpk;
    UsageLedger internal ledger;
    HostRegistry internal registry;
    OffpeakVault internal vault;
    WindowMarketHarness internal windows;
    OfpkHooks internal hooks;
    FeeSplitter internal splitter;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal router = makeAddr("router");
    address internal treasury = makeAddr("treasury");
    address internal ops = makeAddr("ops");
    address internal escrow = makeAddr("escrow");
    address internal channels = makeAddr("channels");
    address internal court = makeAddr("court");
    address internal hostA = address(0xA11);
    address internal hostB = address(0xB22);

    address[3] internal settlers;
    uint256[3] internal settlerKeys;

    function setUp() public virtual {
        vm.warp(START);
        vm.chainId(CHAIN_ID);
        vm.etch(PERMIT2, vm.parseBytes(vm.trim(vm.readFile("test/fixtures/permit2.bin"))));
        _sortSettlers();

        usdg = new MockUSDG();
        ofpk = new MockOFPK();
        ledger = new UsageLedger(owner, router);
        registry = new HostRegistry(owner, IERC20(address(usdg)), IERC20(address(ofpk)), guardian, treasury);
        vault = new OffpeakVault(
            owner,
            IERC20(address(usdg)),
            ISignatureTransfer(PERMIT2),
            IUsageLedger(address(ledger)),
            IHostRegistry(address(registry)),
            settlers,
            guardian
        );
        splitter = new FeeSplitter(owner, IERC20(address(usdg)), IHostRegistry(address(registry)), ops, treasury);
        hooks = new OfpkHooks(owner, IERC20(address(ofpk)), IHostRegistry(address(registry)), IFeeSplitter(address(splitter)));
        windows = new WindowMarketHarness(
            owner,
            IERC20(address(usdg)),
            IHostRegistry(address(registry)),
            IOfpkHooks(address(hooks)),
            address(vault),
            address(splitter)
        );

        vm.startPrank(owner);
        (address escrowPeer, address channelPeer) = _agentPeers();
        vault.setPeers(address(windows), address(splitter), escrowPeer, channelPeer);
        ledger.setVault(address(vault));
        registry.setPeers(address(vault), address(windows), _courtAddress(), address(splitter));
        splitter.setPeers(address(vault), address(windows));
        vm.stopPrank();
    }

    /// The vault's payment peers. Suites that exercise the real contracts override this.
    function _agentPeers() internal virtual returns (address, address) {
        return (escrow, channels);
    }

    /// The registry's court peer. Suites that exercise the real court override this.
    function _courtAddress() internal virtual returns (address) {
        return court;
    }

    function _sortSettlers() private {
        for (uint256 i; i < 3; ++i) {
            (settlers[i], settlerKeys[i]) = makeAddrAndKey(string.concat("settler-", vm.toString(i)));
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (settlers[j] < settlers[i]) {
                    (settlers[i], settlers[j]) = (settlers[j], settlers[i]);
                    (settlerKeys[i], settlerKeys[j]) = (settlerKeys[j], settlerKeys[i]);
                }
            }
        }
    }
