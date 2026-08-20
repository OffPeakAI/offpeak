// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {DeployCore} from "../../script/DeployCore.sol";
import {ChannelManager} from "../../src/ChannelManager.sol";
import {X402Escrow} from "../../src/X402Escrow.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {DeployHarness, MockSafe} from "../helpers/DeployHarness.sol";

/// @notice A full P1 deployment onto a fork of Robinhood Chain, against the real USDG and Permit2.
/// Runs when OFFPEAK_RPC_URL is set: `bun run contracts:fork`.
contract DeployForkTest is Test {
    using stdJson for string;

    DeployHarness internal harness;
    DeployCore.Config internal c;
    DeployCore.Core internal d;
    TimelockController internal timelock;
    IERC20 internal usdg;
    uint256[3] internal settlerKeys;
    address internal buyer;
    uint256 internal buyerKey;

    function setUp() public {
        string memory rpc = vm.envOr("OFFPEAK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        string memory config = vm.readFile("config/chains/4663.json");
        address[] memory owners = new address[](1);
        owners[0] = makeAddr("reviewer");
        harness = new DeployHarness();

        for (uint256 i; i < 3; ++i) {
            (c.settlers[i], settlerKeys[i]) = makeAddrAndKey(string.concat("fork-settler-", vm.toString(i)));
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (c.settlers[j] < c.settlers[i]) {
                    (c.settlers[i], c.settlers[j]) = (c.settlers[j], c.settlers[i]);
                    (settlerKeys[i], settlerKeys[j]) = (settlerKeys[j], settlerKeys[i]);
                }
            }
        }
        c.usdg = config.readAddress(".usdg");
        c.usdgSymbol = config.readString(".usdgSymbol");
        c.permit2 = config.readAddress(".permit2");
        c.permit2CodeHash = config.readBytes32(".permit2CodeHash");
        c.rulers = [address(0x21), address(0x22), address(0x23)];
        c.panel = address(new MockSafe(owners));
        c.guardian = makeAddr("guardian");
        c.multisig = makeAddr("multisig");
        c.relay = makeAddr("relay");
        c.capturer = makeAddr("capturer");
        c.keeper = makeAddr("keeper");
        c.channelPayee = makeAddr("payee");
        c.routerSigner = makeAddr("router");
        c.treasury = makeAddr("treasury");
        c.opsWallet = makeAddr("ops");
        usdg = IERC20(c.usdg);
        (buyer, buyerKey) = makeAddrAndKey("fork-buyer");

        harness.preflight(c);
        uint256 gasBefore = gasleft();
        d = harness.deploy(c);
        timelock = harness.handOff(d, c.multisig);
        console2.log("deployment gas", gasBefore - gasleft());
    }

    function _settleDebit(uint128 amount) private {
        uint64 hour = d.vault.lastSettledHour() + 1;
        vm.warp((uint256(hour) + 1) * 3600 + 600);
        Debit[] memory debits = new Debit[](1);
        debits[0] = Debit({buyer: buyer, amount: amount, lastTs: uint64(uint256(hour) * 3600 + 1)});
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({host: address(0xA11), amount: amount - amount / 25});
        RootTotals memory t;
        t.records = 1;
        t.prepaidDebit = amount;
        t.hostCredit = credits[0].amount;
        t.fees = amount / 25;
        SettleBatch memory b = SettleBatch({
            chainId: block.chainid,
            vault: address(d.vault),
            hour: hour,
            root: keccak256("root"),
            totalsHash: Typehashes.hash(t),
            debits: debits,
            credits: credits,
            windowDraws: new WindowDraw[](0),
            fees: amount / 25,
            agentPoolDraw: 0,
            reserveDraw: 0,
            agentPaymentsHash: Typehashes.agentPaymentsHash(new bytes32[](0))
        });
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OffpeakSettlement"),
                keccak256("1"),
                block.chainid,
                address(d.vault)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, Typehashes.hash(b)));
        bytes memory sig;
        for (uint256 i; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(settlerKeys[i], digest);
            sig = bytes.concat(sig, abi.encodePacked(r, s, v));
        }
        d.vault.settle(b, t, sig);
    }

    function test_deploysAndVerifiesOnTheRealChain() public view {
        harness.verify(d, c, timelock);
    }

    function test_realUsdgProbe() public view {
        (bool eip2612, bool eip3009) = harness.probe(c.usdg);
        assertTrue(eip2612);
        console2.log("usdg eip3009", eip3009);
    }

    function test_depositSettleAndExitWithRealUsdg() public {
        deal(c.usdg, buyer, 200e6, true);
        vm.startPrank(buyer);
        usdg.approve(address(d.vault), 200e6);
        d.vault.deposit(200e6);
        d.vault.setCaps(10e6, 0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(d.vault)), 200e6);

        _settleDebit(10e6);
        assertEq(d.vault.buyerState(buyer).balance, 190e6);
        assertEq(usdg.balanceOf(address(d.registry)), 10e6 - 10e6 / uint256(25));
        assertEq(usdg.balanceOf(address(d.splitter)), 10e6 / uint256(25));

        vm.startPrank(buyer);
        d.vault.requestWithdrawAll();
        vm.warp(block.timestamp + 7200);
        d.vault.executeWithdrawAll(buyer);
        vm.stopPrank();
        assertEq(usdg.balanceOf(buyer), 190e6);
    }

    function test_depositThroughTheRealPermit2() public {
        deal(c.usdg, buyer, 50e6, true);
        vm.prank(buyer);
        usdg.approve(c.permit2, type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory p = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: c.usdg, amount: 50e6}),
            nonce: uint256(keccak256("fork-nonce")),
            deadline: block.timestamp + 1 hours
        });
        bytes32 tokenHash = keccak256(
            abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), p.permitted.token, p.permitted.amount)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                ),
                tokenHash,
                address(d.vault),
                p.nonce,
                p.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(c.permit2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);

        vm.prank(buyer);
        d.vault.depositWithPermit2(p, abi.encodePacked(r, s, v));
        assertEq(d.vault.buyerState(buyer).balance, 50e6);
    }

    /// The same path mainnet takes: the deploy code, then the multisig through the 48 hour timelock.
    function _agentContracts() private returns (X402Escrow x402, ChannelManager manager) {
        DeployCore.Payments memory p = harness.deployPayments(c, d);
        DeployCore.Proposal memory proposal = harness.paymentsProposal(d, p);
        vm.startPrank(c.multisig);
        timelock.scheduleBatch(proposal.targets, proposal.values, proposal.payloads, bytes32(0), bytes32(0), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.executeBatch(proposal.targets, proposal.values, proposal.payloads, bytes32(0), bytes32(0));
        vm.stopPrank();
        harness.verifyPayments(d, p, c);
        return (p.escrow, p.channels);
    }

    function _permit2Digest(address spender, ISignatureTransfer.PermitTransferFrom memory p, bytes32 witness, string memory witnessType)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    abi.encodePacked(
                        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                        witnessType
                    )
                ),
                keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), p.permitted.token, p.permitted.amount)),
                spender,
                p.nonce,
                p.deadline,
                witness
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(c.permit2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_exactSettlesThroughTheRealPermit2() public {
        (X402Escrow x402,) = _agentContracts();
        deal(c.usdg, buyer, 1e6, true);
        vm.prank(buyer);
        usdg.approve(c.permit2, type(uint256).max);
        ExactWitness memory w = ExactWitness({
            reqId: keccak256("fork-exact"),
            payee: address(d.vault),
            amount: 40_000,
            validBefore: uint64(block.timestamp + 600),
            resourceHash: keccak256("resource")
        });
        ISignatureTransfer.PermitTransferFrom memory p = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: c.usdg, amount: 40_000}),
            nonce: uint256(keccak256("fork-exact-nonce")),
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _permit2Digest(address(x402), p, Typehashes.hash(w), Typehashes.EXACT_WITNESS_TYPESTRING);
        vm.prank(c.relay);
        x402.settleExact(p, sig, buyer, w);
        assertEq(d.vault.agentPool(), 40_000);
    }

    function test_aChannelOpensThroughTheRealPermit2() public {
        (, ChannelManager manager) = _agentContracts();
        deal(c.usdg, buyer, 5e6, true);
        vm.prank(buyer);
        usdg.approve(c.permit2, type(uint256).max);
        ChannelOpenWitness memory w =
            ChannelOpenWitness({channelSalt: keccak256("fork-open"), payee: c.channelPayee, expiry: uint64(block.timestamp + 1 days)});
        ISignatureTransfer.PermitTransferFrom memory p = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: c.usdg, amount: 5e6}),
            nonce: uint256(keccak256("fork-open-nonce")),
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _permit2Digest(address(manager), p, Typehashes.hash(w), Typehashes.CHANNEL_WITNESS_TYPESTRING);
        bytes32 id = manager.openWithPermit2(p, sig, buyer, w);
        assertEq(manager.channelView(id).deposit, 5e6);
        assertEq(usdg.balanceOf(address(manager)), 5e6);
    }

    function test_uptoAuthorizesAndCapturesThroughTheRealPermit2() public {
        (X402Escrow x402,) = _agentContracts();
        deal(c.usdg, buyer, 10e6, true);
        vm.prank(buyer);
        usdg.approve(c.permit2, type(uint256).max);

        UptoWitness memory w = UptoWitness({
            reqId: keccak256("fork-upto"),
            payee: address(d.vault),
            maxAmount: 2e6,
            validBefore: uint64(block.timestamp + 600),
            resourceHash: keccak256("resource")
        });
        ISignatureTransfer.PermitTransferFrom memory p = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: c.usdg, amount: 2e6}),
            nonce: uint256(keccak256("fork-upto-nonce")),
            deadline: block.timestamp + 1 hours
        });
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    abi.encodePacked(
                        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                        Typehashes.UPTO_WITNESS_TYPESTRING
                    )
                ),
                keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), c.usdg, uint256(2e6))),
                address(x402),
                p.nonce,
                p.deadline,
                Typehashes.hash(w)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(c.permit2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);

        vm.prank(c.relay);
        x402.authorize(p, abi.encodePacked(r, s, v), buyer, w);
        assertEq(usdg.balanceOf(address(x402)), 2e6);

        vm.prank(c.capturer);
        x402.capture(w.reqId, 5e5);
        assertEq(d.vault.agentPool(), 5e5);
        assertEq(usdg.balanceOf(buyer), 10e6 - 5e5);
        assertEq(usdg.balanceOf(address(x402)), 0);
    }

    function test_aChannelPaysAndClosesWithRealUsdg() public {
        (, ChannelManager manager) = _agentContracts();
        deal(c.usdg, buyer, 10e6, true);
        vm.startPrank(buyer);
        usdg.approve(address(manager), 10e6);
        bytes32 id = manager.open(10e6, uint64(block.timestamp + 1 days), keccak256("fork-channel"));
        vm.stopPrank();

        Voucher memory voucher = Voucher({channelId: id, seq: 1, cumulative: 3e6});
        bytes32 channelDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OffpeakChannel"),
                keccak256("1"),
                block.chainid,
                address(manager)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", channelDomain, Typehashes.hash(voucher))));
        vm.prank(c.keeper);
        manager.settleChannel(id, voucher, abi.encodePacked(r, s, v));
        assertEq(d.vault.agentPool(), 3e6);

        vm.prank(buyer);
        manager.requestClose(id);
        vm.warp(block.timestamp + 2 hours);
        manager.finalizeClose(id);
        assertEq(usdg.balanceOf(buyer), 7e6);
    }

    function test_aWindowRunsOnTheRealChain() public {
        DeployCore.Markets memory m = harness.deployMarkets(c, d, address(timelock));
        DeployCore.Proposal memory proposal = harness.marketsProposal(d, m);
        vm.startPrank(c.multisig);
        timelock.scheduleBatch(proposal.targets, proposal.values, proposal.payloads, bytes32(0), bytes32("p3"), 48 hours);
        vm.warp(block.timestamp + 48 hours);
        timelock.executeBatch(proposal.targets, proposal.values, proposal.payloads, bytes32(0), bytes32("p3"));
        vm.stopPrank();
        harness.verifyMarkets(d, m, c, timelock);

        address host = makeAddr("fork-host");
        bytes32[] memory models = new bytes32[](1);
        models[0] = keccak256("model");
        uint32[] memory tps = new uint32[](1);
        tps[0] = 50_000;
        deal(c.usdg, host, 3_000e6, true);
        deal(c.usdg, buyer, 10e6, true);
        vm.startPrank(host);
        usdg.approve(address(d.registry), type(uint256).max);
        usdg.approve(address(m.windows), type(uint256).max);
        d.registry.register(
            RegisterParams({
                modelDigests: models,
                maxTps: tps,
                imageDigest: keccak256("image"),
                gpuClass: keccak256("h100-80g-sxm"),
                endpointHash: keccak256("endpoint"),
                attestationRef: bytes32(0),
                bondUsdg: 2_000e6,
                bondOfpk: 0
            })
        );
        vm.warp(block.timestamp + 72 hours);
        d.registry.activate(host);
        uint64 t0 = uint64((block.timestamp / 3600 + 2) * 3600);
        uint256 id = m.windows.create(
            WindowParams({
                modelDigest: models[0],
                t0: t0,
                t1: t0 + 3600,
                minTps: 1,
                units: 2,
                startPricePerUnit: 1e6,
                endPricePerUnit: 1e6,
                auctionStart: uint64(block.timestamp),
                auctionEnd: t0
            }),
            2e6
        );
        vm.stopPrank();

        vm.startPrank(buyer);
        usdg.approve(address(m.windows), type(uint256).max);
        m.windows.buy(id, 1, type(uint256).max);
        m.windows.cancel(id, 1);
        vm.stopPrank();
        assertEq(usdg.balanceOf(buyer), 10e6 - 1e6 + 950_000);
    }

    function test_theBetaCapHoldsOnTheRealToken() public {
        deal(c.usdg, buyer, 501e6, true);
        vm.startPrank(buyer);
        usdg.approve(address(d.vault), 501e6);
        vm.expectRevert();
        d.vault.deposit(501e6);
        d.vault.deposit(500e6);
        vm.stopPrank();
    }
}
