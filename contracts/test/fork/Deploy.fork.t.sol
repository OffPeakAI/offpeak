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
