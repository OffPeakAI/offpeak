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

    function _fund(address buyer, uint256 amount) internal {
        usdg.mint(buyer, amount);
        vm.startPrank(buyer);
        usdg.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _fundWithCaps(address buyer, uint256 amount, uint128 hourlyCap) internal {
        _fund(buyer, amount);
        vm.prank(buyer);
        vault.setCaps(hourlyCap, 0);
    }

    function _fundReserve(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(vault), amount);
        vault.fundReserve(amount);
    }

    function _fundAgentPool(uint256 amount) internal {
        usdg.mint(address(vault), amount);
        bytes32 paymentId = keccak256(abi.encode("agent", amount, vault.agentPool()));
        vm.prank(escrow);
        vault.creditAgentPool(amount, paymentId);
    }

    function _nextHour() internal view returns (uint64) {
        return vault.lastSettledHour() + 1;
    }

    function _emptyBatch(uint64 hour) internal view returns (SettleBatch memory b, RootTotals memory t) {
        b.chainId = CHAIN_ID;
        b.vault = address(vault);
        b.hour = hour;
        b.totalsHash = Typehashes.hash(t);
        b.agentPaymentsHash = Typehashes.agentPaymentsHash(new bytes32[](0));
    }

    /// A batch whose credits go to hostA and whose fees are whatever the debits leave after `credit`.
    function _batch(uint64 hour, Debit[] memory debits, uint128 credit)
        internal
        view
        returns (SettleBatch memory b, RootTotals memory t)
    {
        (b, t) = _emptyBatch(hour);
        uint128 total;
        for (uint256 i; i < debits.length; ++i) {
            total += debits[i].amount;
        }
        b.debits = debits;
        b.fees = total - credit;
        if (credit > 0) {
            b.credits = new Credit[](1);
            b.credits[0] = Credit({host: hostA, amount: credit});
        }
        t.records = 1;
        t.prepaidDebit = total;
        t.hostCredit = credit;
        t.fees = b.fees;
        _seal(b, t);
    }

    function _seal(SettleBatch memory b, RootTotals memory t) internal pure {
        b.root = t.records == 0 ? bytes32(0) : keccak256(abi.encode("root", b.hour));
        b.totalsHash = Typehashes.hash(t);
    }

    function _oneDebit(address buyer, uint128 amount, uint64 lastTs) internal pure returns (Debit[] memory debits) {
        debits = new Debit[](1);
        debits[0] = Debit({buyer: buyer, amount: amount, lastTs: lastTs});
    }

    function _settlementDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OffpeakSettlement"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _thresholdSig(bytes32 digest) internal view returns (bytes memory) {
        return bytes.concat(_sig(settlerKeys[0], digest), _sig(settlerKeys[1], digest));
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signBatch(SettleBatch memory b) internal view returns (bytes memory) {
        return _thresholdSig(_settlementDigest(Typehashes.hash(b)));
    }

    function _warpPast(uint64 hour) internal {
        uint256 ready = HourMath.hourEnd(hour) + vault.HOUR_CLOSE_GRACE();
        if (block.timestamp < ready) vm.warp(ready);
    }

    function _settle(SettleBatch memory b, RootTotals memory t) internal {
        _warpPast(b.hour);
        vault.settle(b, t, _signBatch(b));
    }

    /// Settles empty hours up to and including `hour`.
    function _settleEmptyThrough(uint64 hour) internal {
        while (vault.lastSettledHour() < hour) {
            (SettleBatch memory b, RootTotals memory t) = _emptyBatch(_nextHour());
            _settle(b, t);
        }
    }

    function _balance(address buyer) internal view returns (uint256) {
        return vault.buyerState(buyer).balance;
    }
}
