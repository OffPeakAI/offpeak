// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Test} from "forge-std/Test.sol";
import {DeployCore} from "../../script/DeployCore.sol";
import {MockOFPK} from "../../src/mocks/MockOFPK.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {CodeCheckHarness, DeployHarness, MockSafe} from "../helpers/DeployHarness.sol";

contract DeployTest is Test {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    DeployHarness internal harness;
    CodeCheckHarness internal codeCheck;
    MockUSDG internal usdg;
    DeployCore.Config internal c;
    address internal panelOwner = makeAddr("reviewer");

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(4663);
        vm.etch(PERMIT2, vm.parseBytes(vm.trim(vm.readFile("test/fixtures/permit2.bin"))));
        harness = new DeployHarness();
        codeCheck = new CodeCheckHarness();
        usdg = new MockUSDG();
        address[] memory owners = new address[](1);
        owners[0] = panelOwner;
        c.usdg = address(usdg);
        c.usdgSymbol = "USDG";
        c.permit2 = PERMIT2;
        c.permit2CodeHash = PERMIT2.codehash;
        c.ofpk = address(new MockOFPK());
        c.settlers = [address(0x11), address(0x12), address(0x13)];
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
    }

    function _deployed() private returns (DeployCore.Core memory d, TimelockController timelock) {
        harness.preflight(c);
        d = harness.deploy(c);
        timelock = harness.handOff(d, c.multisig);
    }

    function test_theFullSequencePassesVerification() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        harness.verify(d, c, timelock);
    }

    function test_theDeployerHoldsNothingAfterwards() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        assertEq(d.vault.owner(), address(timelock));
        assertEq(timelock.getMinDelay(), 48 hours);
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(harness)));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(harness)));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), c.multisig));
    }

    function test_theMultisigChangesThingsOnlyAfterFortyEightHours() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        targets[0] = address(d.vault);
        payloads[0] = abi.encodeWithSignature("disableBetaCap()");

        vm.startPrank(c.multisig);
        vm.expectRevert();
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), 1 hours);

        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), 48 hours);
        vm.expectRevert();
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + 48 hours);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));
        assertFalse(d.vault.betaCapEnabled());
    }

    function test_laterPhasesCanStillSetTheirPeersThroughTheTimelock() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        assertEq(d.vault.x402Escrow(), address(0));
        vm.prank(address(timelock));
        d.vault.setPeers(address(0), address(0), address(0xE5), address(0xC4));
        assertEq(d.vault.x402Escrow(), address(0xE5));
    }

    function test_pauseFlagsAndDevGpuStayOut() public {
        (DeployCore.Core memory d,) = _deployed();
        assertFalse(d.registry.allowedGpuClass(keccak256("cpu-tdx-dev")));
        assertTrue(d.vault.betaCapEnabled());
        assertFalse(d.splitter.tokenHooksEnabled());
    }

    function test_verificationNamesTheFirstProblem() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        vm.prank(address(timelock));
        d.vault.disableBetaCap();
        vm.expectRevert(abi.encodeWithSelector(DeployCore.WiringMismatch.selector, "beta cap matches the config"));
        harness.verify(d, c, timelock);
    }

    function test_verificationCatchesARotatedSigner() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        c.settlers[0] = address(0x99);
        vm.expectRevert(abi.encodeWithSelector(DeployCore.WiringMismatch.selector, "vault.settlers"));
        harness.verify(d, c, timelock);
    }

    function test_verificationRequiresTheTimelockOwnsEverything() public {
        DeployCore.Core memory d = harness.deploy(c);
        TimelockController wrong = new TimelockController(0, new address[](0), new address[](0), address(this));
        vm.expectRevert(abi.encodeWithSelector(DeployCore.WiringMismatch.selector, "owner is the timelock"));
        harness.verify(d, c, wrong);
    }

    function test_verificationCoversEveryImmutableAddress() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        address[6] memory targets = [
            address(d.registry), address(d.registry), address(d.splitter), address(d.splitter), address(d.court), address(d.court)
        ];
        string[6] memory getters = ["usdg()", "ofpk()", "usdg()", "registry()", "usdg()", "treasury()"];
        string[6] memory checks =
            ["registry.usdg", "registry.ofpk", "splitter.usdg", "splitter.registry", "court.usdg", "court.treasury"];
        for (uint256 i; i < targets.length; ++i) {
            vm.mockCall(targets[i], abi.encodeWithSignature(getters[i]), abi.encode(address(0xBAD)));
            vm.expectRevert(abi.encodeWithSelector(DeployCore.WiringMismatch.selector, checks[i]));
            harness.verify(d, c, timelock);
            vm.clearMockedCalls();
        }
    }

    function test_everyDeployedContractMatchesItsBuild() public {
        (DeployCore.Core memory d, TimelockController timelock) = _deployed();
        codeCheck.verifyCoreCode(d, timelock);
        codeCheck.verifyPaymentsCode(harness.deployPayments(c, d));
        codeCheck.verifyMarketsCode(harness.deployMarkets(c, d, address(timelock)));
    }

    function test_theCodeCheckFailsOnOneChangedByte() public {
        (DeployCore.Core memory d,) = _deployed();
        bytes memory code = address(d.vault).code;
        code[100] = ~code[100];
        vm.etch(address(d.vault), code);
        vm.expectPartialRevert(DeployCore.CodeMismatch.selector);
        codeCheck.verifyCode("OffpeakVault", address(d.vault));
    }

    function test_theCodeCheckFailsOnTheWrongContract() public {
        (DeployCore.Core memory d,) = _deployed();
        vm.expectPartialRevert(DeployCore.CodeMismatch.selector);
        codeCheck.verifyCode("OffpeakVault", address(d.ledger));
    }

    function test_theCodeCheckFailsOnAnEmptyAddress() public {
        vm.expectPartialRevert(DeployCore.CodeMismatch.selector);
        codeCheck.verifyCode("OffpeakVault", address(0xDEAD));
    }

    /// The trailer holds the source hash, so a comment change alters it and nothing else.
    function test_theCodeCheckIgnoresMetadata() public {
        (DeployCore.Core memory d,) = _deployed();
        bytes memory code = address(d.vault).code;
        code[code.length - 10] = ~code[code.length - 10];
        vm.etch(address(d.vault), code);
        codeCheck.verifyCode("OffpeakVault", address(d.vault));
    }

    function test_theCodeCheckIgnoresImmutableValues() public {
        (DeployCore.Core memory first,) = _deployed();
        c.relay = makeAddr("second-relay");
        c.capturer = makeAddr("second-capturer");
        DeployCore.Payments memory p = harness.deployPayments(c, first);
        codeCheck.verifyPaymentsCode(p);
    }

    function test_preflightRejectsTheWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployCore.BadChain.selector, 1));
        harness.preflight(c);
    }

    function test_preflightRejectsUsdgThatIsNotAContract() public {
        c.usdg = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(DeployCore.BadUsdg.selector, "no code"));
        harness.preflight(c);
    }

    function test_preflightChecksDecimalsAndSymbol() public {
        c.usdg = c.ofpk;
        vm.expectRevert(abi.encodeWithSelector(DeployCore.BadUsdg.selector, "decimals"));
        harness.preflight(c);

        c.usdg = address(usdg);
        c.usdgSymbol = "USDC";
        vm.expectRevert(abi.encodeWithSelector(DeployCore.BadUsdg.selector, "symbol"));
        harness.preflight(c);
    }

    function test_preflightChecksThePermit2CodeHash() public {
        bytes32 actual = c.permit2CodeHash;
        c.permit2CodeHash = keccak256("other chain");
        vm.expectRevert(abi.encodeWithSelector(DeployCore.BadPermit2CodeHash.selector, actual, c.permit2CodeHash));
        harness.preflight(c);
    }

    function test_preflightRejectsAnEmptyRole() public {
        c.keeper = address(0);
        vm.expectRevert();
        harness.preflight(c);
    }

    function test_preflightRejectsAKeyShared() public {
        c.relay = c.capturer;
        vm.expectRevert(abi.encodeWithSelector(DeployCore.RolesNotDistinct.selector, c.capturer));
        harness.preflight(c);

        c.relay = makeAddr("relay");
        c.opsWallet = c.treasury;
        vm.expectRevert(abi.encodeWithSelector(DeployCore.RolesNotDistinct.selector, c.treasury));
        harness.preflight(c);
    }

    function test_preflightRejectsAPanelThatIsNotAMultisig() public {
        c.panel = makeAddr("just-a-wallet");
        vm.expectRevert(abi.encodeWithSelector(DeployCore.PanelNotASafe.selector, c.panel));
        harness.preflight(c);

        c.panel = address(usdg);
        vm.expectRevert(abi.encodeWithSelector(DeployCore.PanelNotASafe.selector, address(usdg)));
        harness.preflight(c);
    }

    function test_noPanelReviewerCanHoldAnOperationalKey() public {
        address[6] memory operational = [c.settlers[1], c.rulers[2], c.relay, c.capturer, c.keeper, c.routerSigner];
        for (uint256 i; i < operational.length; ++i) {
            address[] memory owners = new address[](2);
            owners[0] = panelOwner;
            owners[1] = operational[i];
            c.panel = address(new MockSafe(owners));
            vm.expectRevert(abi.encodeWithSelector(DeployCore.PanelOverlap.selector, operational[i]));
            harness.preflight(c);
        }
    }

    function test_theUsdgProbeReportsWhatItFinds() public view {
        (bool eip2612, bool eip3009) = harness.probe(address(usdg));
        assertFalse(eip2612);
        assertFalse(eip3009);
    }
}
