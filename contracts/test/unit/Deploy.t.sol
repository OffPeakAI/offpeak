// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Test} from "forge-std/Test.sol";
import {DeployCore} from "../../script/DeployCore.sol";
import {MockOFPK} from "../../src/mocks/MockOFPK.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {DeployHarness, MockSafe} from "../helpers/DeployHarness.sol";

contract DeployTest is Test {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    DeployHarness internal harness;
    MockUSDG internal usdg;
    DeployCore.Config internal c;
    address internal panelOwner = makeAddr("reviewer");

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(4663);
        vm.etch(PERMIT2, vm.parseBytes(vm.trim(vm.readFile("test/fixtures/permit2.bin"))));
        harness = new DeployHarness();
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
