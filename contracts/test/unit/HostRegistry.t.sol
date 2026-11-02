// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

contract ContractWallet {
    bytes32 public approved;

    function approve(bytes32 digest) external {
        approved = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approved ? bytes4(0x1626ba7e) : bytes4(0);
    }
}

contract HostRegistryTest is VaultFixture {
    using stdJson for string;

    uint8 internal constant NONE = 0;
    uint8 internal constant PROBATION = 1;
    uint8 internal constant ACTIVE = 2;
    uint8 internal constant FROZEN = 3;
    uint8 internal constant EXITING = 4;
    uint8 internal constant DELISTED = 5;
    uint256 internal constant BOND = 2_000e6;
    bytes32 internal constant GPU = keccak256("h100-80g-sxm");
    bytes32 internal constant OTHER_GPU = keccak256("a100-80g");
    bytes32 internal constant MODEL = keccak256("model-a");
    bytes32 internal constant OTHER_MODEL = keccak256("model-b");
    bytes32 internal constant IMAGE = keccak256("image");
    bytes32 internal constant ATTESTATION = keccak256("attestation");
    bytes32 internal constant ENDPOINT = keccak256("endpoint");
    bytes32 internal constant REASON = keccak256("reason");

    address internal host = makeAddr("host");

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        registry.setGpuClass(GPU, true);
        registry.setGpuClass(OTHER_GPU, true);
        vm.stopPrank();
    }

    // Registration

    function test_registerStoresTheHostAndPullsBonds() public {
        _fundHost(host, BOND, 5e18);
        RegisterParams memory p = _params(BOND, 5e18);
        vm.expectEmit(address(registry));
        emit IHostRegistry.HostRegistered(host, IMAGE, GPU, _digests(MODEL), _tps(100), uint64(START + 72 hours), ATTESTATION);
        vm.expectEmit(address(registry));
        emit IHostRegistry.EndpointUpdated(host, ENDPOINT);
        vm.expectEmit(address(registry));
        emit IHostRegistry.BondChanged(host, BOND, 5e18);
        vm.expectEmit(address(registry));
        emit IHostRegistry.HostStatusChanged(host, PROBATION);
        vm.prank(host);
        registry.register(p);

        HostView memory v = registry.hostView(host);
        assertEq(v.operator, host);
        assertEq(v.status, PROBATION);
        assertEq(v.bondUsdg, BOND);
        assertEq(v.bondOfpk, 5e18);
        assertEq(v.probationEnds, START + 72 hours);
        assertEq(registry.maxTpsOf(host, MODEL), 100);
        assertEq(usdg.balanceOf(address(registry)), BOND);
        assertEq(ofpk.balanceOf(address(registry)), 5e18);
    }

    function test_registerRejectsALowBond() public {
        RegisterParams memory p = _params(BOND - 1, 0);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.BondTooLow.selector, BOND - 1, BOND));
        vm.prank(host);
        registry.register(p);
    }

    function test_registerRejectsAnUnknownGpuClass() public {
        RegisterParams memory p = _params(BOND, 0);
        p.gpuClass = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.GpuClassNotAllowed.selector, p.gpuClass));
        vm.prank(host);
        registry.register(p);
    }

    function test_registerRejectsBadModelLists() public {
        _fundHost(host, BOND, 0);
        RegisterParams memory p = _params(BOND, 0);
        p.maxTps = new uint32[](2);
        vm.prank(host);
        vm.expectRevert(HostRegistry.InvalidModels.selector);
        registry.register(p);

        p.modelDigests = new bytes32[](0);
        p.maxTps = new uint32[](0);
        vm.prank(host);
        vm.expectRevert(HostRegistry.InvalidModels.selector);
        registry.register(p);

        p = _params(BOND, 0);
        p.maxTps = _tps(0);
        vm.prank(host);
        vm.expectRevert(HostRegistry.InvalidModels.selector);
        registry.register(p);
    }

    function test_registerTwiceReverts() public {
        _register(host, BOND, 0);
        RegisterParams memory p = _params(BOND, 0);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.AlreadyRegistered.selector, host));
        vm.prank(host);
        registry.register(p);
    }

    function test_setGpuClassIsOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.setGpuClass(GPU, false);
    }

    // Serving updates

    function test_tpsAndAttestationChangesKeepActiveStatus() public {
        _activeHost(host);
        vm.prank(host);
        registry.updateServing(_digests(MODEL), _tps(250), IMAGE, GPU, keccak256("new-attestation"));
        HostView memory v = registry.hostView(host);
        assertEq(v.status, ACTIVE);
        assertEq(v.attestationRef, keccak256("new-attestation"));
        assertEq(registry.maxTpsOf(host, MODEL), 250);
    }

    function test_changingWhatIsServedResetsProbation() public {
        bytes32[3] memory images = [keccak256("image-2"), IMAGE, IMAGE];
        bytes32[3] memory gpus = [GPU, OTHER_GPU, GPU];
        bytes32[3] memory models = [MODEL, MODEL, OTHER_MODEL];
        for (uint256 i; i < 3; ++i) {
            address operator = makeAddr(string.concat("host-", vm.toString(i)));
            _activeHost(operator);
            vm.expectEmit(address(registry));
            emit IHostRegistry.HostStatusChanged(operator, PROBATION);
            vm.prank(operator);
            registry.updateServing(_digests(models[i]), _tps(100), images[i], gpus[i], ATTESTATION);
            HostView memory v = registry.hostView(operator);
            assertEq(v.status, PROBATION);
            assertEq(v.probationEnds, block.timestamp + 72 hours);
            assertFalse(registry.routable(operator));
        }
    }

    function test_replacedModelsLoseTheirCapacity() public {
        _activeHost(host);
        vm.prank(host);
        registry.updateServing(_digests(OTHER_MODEL), _tps(77), IMAGE, GPU, ATTESTATION);
        assertEq(registry.maxTpsOf(host, MODEL), 0);
        assertEq(registry.maxTpsOf(host, OTHER_MODEL), 77);
        assertEq(registry.modelsOf(host).length, 1);
        assertEq(registry.modelsOf(host)[0], OTHER_MODEL);
    }

    function test_updateServingNeedsAServingHost() public {
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.WrongStatus.selector, host, HostRegistry.Status.None));
        vm.prank(host);
        registry.updateServing(_digests(MODEL), _tps(1), IMAGE, GPU, ATTESTATION);
    }

    function test_updateServingChecksTheGpuClass() public {
        _activeHost(host);
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.GpuClassNotAllowed.selector, unknown));
        vm.prank(host);
        registry.updateServing(_digests(MODEL), _tps(1), IMAGE, unknown, ATTESTATION);
    }

    function test_updateEndpoint() public {
        _register(host, BOND, 0);
        vm.expectEmit(address(registry));
        emit IHostRegistry.EndpointUpdated(host, keccak256("next"));
        vm.prank(host);
        registry.updateEndpoint(keccak256("next"));

        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotRegistered.selector, address(this)));
        registry.updateEndpoint(keccak256("next"));
    }

    // Activation and routing

    function test_activateWaitsForProbation() public {
        _register(host, BOND, 0);
        uint64 ends = uint64(START + 72 hours);
        vm.warp(ends - 1);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.ProbationNotOver.selector, ends));
        registry.activate(host);
        assertFalse(registry.routable(host));

        vm.warp(ends);
        vm.expectEmit(address(registry));
        emit IHostRegistry.HostStatusChanged(host, ACTIVE);
        registry.activate(host);
        assertTrue(registry.routable(host));
    }

    function test_activateNeedsProbationStatus() public {
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.WrongStatus.selector, host, HostRegistry.Status.None));
        registry.activate(host);
    }

    function test_activateNeedsTheRequiredBond() public {
        _register(host, BOND, 0);
        _accrue(host, 20_000e6);
        vm.warp(START + 72 hours);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.BondBelowRequired.selector, BOND, 4_000e6));
        registry.activate(host);
    }

    function test_requiredBondIsTheFloorUntilTwentyPercentOfCreditsPassesIt() public {
        assertEq(registry.requiredBond(host), BOND);
        _accrue(host, 10_000e6);
        assertEq(registry.requiredBond(host), BOND);
        _accrue(host, 5_000e6);
        assertEq(registry.requiredBond(host), 3_000e6);
    }

    function test_requiredBondCountsThirtyDaysAndNoMore() public {
        _accrue(host, 15_000e6);
        vm.warp(block.timestamp + 10 days);
        _accrue(host, 15_000e6);
        assertEq(registry.requiredBond(host), 6_000e6);

        vm.warp(block.timestamp + 19 days);
        assertEq(registry.requiredBond(host), 6_000e6, "day 29 still holds the first credit");
        vm.warp(block.timestamp + 1 days);
        assertEq(registry.requiredBond(host), 3_000e6, "day 30 drops it");
        vm.warp(block.timestamp + 10 days);
        assertEq(registry.requiredBond(host), BOND);
    }

    function test_ringSlotsAreReusedCleanlyOverManyDays() public {
        for (uint256 i; i < 90; ++i) {
            _accrue(host, 1_000e6);
            vm.warp(block.timestamp + 1 days);
        }
        _accrue(host, 1_000e6);
        assertEq(registry.requiredBond(host), 6_000e6, "exactly the last 30 days count");
    }

    function test_routingStopsBelowTheRequiredBondAndResumesAfterTopUp() public {
        _activeHost(host);
        _accrue(host, 20_000e6);
        assertFalse(registry.routable(host));
        assertEq(registry.hostView(host).status, ACTIVE);

        _fundHost(host, 2_000e6, 0);
        vm.prank(host);
        registry.topUpBond(2_000e6, 0);
        assertTrue(registry.routable(host));
    }

    function test_topUpNeedsARegisteredHost() public {
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotRegistered.selector, address(this)));
        registry.topUpBond(1, 0);
    }

    // Credits

    function test_accrueCreditsIsVaultOrMarketOnly() public {
        Credit[] memory credits = _credit(host, 1);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotAuthorized.selector, address(this)));
        registry.accrueCredits(1, credits);
        usdg.mint(address(registry), 1);
        vm.prank(address(windows));
        registry.accrueCredits(1, credits);
        assertEq(registry.hostView(host).pendingCredits, 1);
    }

    function test_zeroCreditsLeaveNoEntry() public {
        vm.recordLogs();
        vm.prank(address(vault));
        registry.accrueCredits(1, _credit(host, 0));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_creditsReleaseExactlyAfterTwentyFourHours() public {
        _accrue(host, 100e6);
        HostView memory v = registry.hostView(host);
        assertEq(v.pendingCredits, 100e6);
        assertEq(v.releasableCredits, 0);

        vm.warp(START + 24 hours - 1);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 0, "nothing one second early");

        vm.warp(START + 24 hours);
        assertEq(registry.hostView(host).releasableCredits, 100e6);
        vm.expectEmit(address(registry));
        emit IHostRegistry.CreditsWithdrawn(host, 100e6);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 100e6);
        assertEq(registry.hostView(host).releasableCredits, 0);
    }

    function test_withdrawTakesOnlyMatureEntries() public {
        _accrue(host, 1e6);
        vm.warp(START + 12 hours);
        _accrue(host, 2e6);
        vm.warp(START + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 1e6);
        assertEq(registry.hostView(host).pendingCredits, 2e6);
    }

    function test_withdrawDrainsLongHistoriesInSteps() public {
        for (uint256 i; i < 501; ++i) {
            vm.warp(START + i * 1 hours);
            _accrue(host, 1);
        }
        vm.warp(START + 525 hours);
        vm.startPrank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 500);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 501);
    }

    function test_withdrawIsBlockedByAnOpenChallenge() public {
        _accrue(host, 1e6);
        vm.prank(court);
        registry.addChallenge(host);
        vm.warp(START + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.OpenChallenges.selector, host, uint32(1)));
        vm.prank(host);
        registry.withdrawCredits();

        vm.prank(court);
        registry.removeChallenge(host);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 1e6);
    }

    function test_withdrawIsBlockedWhileFrozen() public {
        _activeHost(host);
        vm.prank(court);
        registry.freeze(host);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.HostFrozen.selector, host));
        vm.prank(host);
        registry.withdrawCredits();
    }

    // Clawback

    function test_clawBackFundsTheVaultReserve() public {
        _accrue(host, 7e6);
        vm.expectEmit(address(registry));
        emit IHostRegistry.CreditsClawedBack(host, START_HOUR, 7e6, REASON);
        vm.prank(court);
        registry.clawBack(host, START_HOUR, REASON);

        assertEq(vault.protocolReserve(), 7e6);
        assertEq(usdg.balanceOf(address(vault)), 7e6);
        assertEq(registry.hostView(host).pendingCredits, 0);
        vm.warp(START + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 0, "a clawed entry never pays");
    }

    function test_guardianCanClawBackForAKeyIncident() public {
        _accrue(host, 7e6);
        vm.prank(guardian);
        registry.clawBack(host, START_HOUR, REASON);
        assertEq(vault.protocolReserve(), 7e6);
    }

    function test_clawBackIsCourtOrGuardianOnly() public {
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotAuthorized.selector, address(this)));
        registry.clawBack(host, START_HOUR, REASON);
    }

    function test_clawBackStopsAtTwentyFourHours() public {
        _accrue(host, 7e6);
        vm.warp(START + 24 hours - 1);
        vm.prank(court);
        registry.clawBack(host, START_HOUR, REASON);
        assertEq(vault.protocolReserve(), 7e6);

        _accrue(host, 3e6);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(court);
        registry.clawBack(host, uint64((block.timestamp - 24 hours) / 3600), REASON);
        assertEq(vault.protocolReserve(), 7e6, "a released entry cannot be clawed");
        assertEq(registry.hostView(host).releasableCredits, 3e6);
    }

    function test_clawBackOnlyTouchesItsHour() public {
        _accrue(host, 1e6);
        vm.warp(block.timestamp + 2 hours);
        _accrue(host, 2e6);
        vm.prank(court);
        registry.clawBack(host, START_HOUR, REASON);
        assertEq(vault.protocolReserve(), 1e6);
        assertEq(registry.hostView(host).pendingCredits, 2e6);
    }

    function test_clawingAnEmptyHourIsANoOp() public {
        vm.recordLogs();
        vm.prank(court);
        registry.clawBack(host, START_HOUR, REASON);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_guardianPowerDoesNotExtendToBonds() public {
        _activeHost(host);
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotAuthorized.selector, guardian));
        registry.slash(host, 10_000, REASON);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotAuthorized.selector, guardian));
        registry.freeze(host);
    }

    // Freezing, challenges and slashing

    function test_courtHooksAreCourtOnly() public {
        vm.startPrank(makeAddr("stranger"));
        bytes4 selector = HostRegistry.NotAuthorized.selector;
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(selector, stranger));
        registry.freeze(host);
        vm.expectRevert(abi.encodeWithSelector(selector, stranger));
        registry.unfreeze(host);
        vm.expectRevert(abi.encodeWithSelector(selector, stranger));
        registry.addChallenge(host);
        vm.expectRevert(abi.encodeWithSelector(selector, stranger));
        registry.removeChallenge(host);
        vm.expectRevert(abi.encodeWithSelector(selector, stranger));
        registry.slash(host, 1, REASON);
        vm.expectRevert(abi.encodeWithSelector(selector, stranger));
        registry.delist(host);
    }

    function test_freezeStopsRoutingAndUnfreezeRestoresThePriorStatus() public {
        _activeHost(host);
        vm.prank(court);
        registry.freeze(host);
        assertEq(registry.hostView(host).status, FROZEN);
        assertFalse(registry.routable(host));

        vm.prank(court);
        registry.unfreeze(host);
        assertEq(registry.hostView(host).status, ACTIVE);
        assertTrue(registry.routable(host));
    }

    function test_freezeDuringProbationRestoresProbation() public {
        _register(host, BOND, 0);
        vm.startPrank(court);
        registry.freeze(host);
        registry.unfreeze(host);
        assertEq(registry.hostView(host).status, PROBATION);
    }

    function test_twoFreezesNeedTwoUnfreezes() public {
        _activeHost(host);
        vm.startPrank(court);
        registry.freeze(host);
        registry.freeze(host);
        registry.unfreeze(host);
        assertEq(registry.hostView(host).status, FROZEN, "the second ruling still stands");
        registry.unfreeze(host);
        assertEq(registry.hostView(host).status, ACTIVE);
    }

    function test_freezingADelistedHostChangesNothing() public {
        _activeHost(host);
        vm.startPrank(court);
        registry.delist(host);
        registry.freeze(host);
        assertEq(registry.hostView(host).status, DELISTED);
        registry.unfreeze(host);
        assertEq(registry.hostView(host).status, DELISTED);
    }

    function test_slashMovesUsdgToTheCourtAndOfpkToTheTreasury() public {
        _register(host, 5_000e6, 10e18);
        vm.expectEmit(address(registry));
        emit IHostRegistry.HostSlashed(host, 2_000, 1_000e6, 2e18, REASON);
        vm.prank(court);
        (uint256 slashedUsdg, uint256 slashedOfpk) = registry.slash(host, 2_000, REASON);

        assertEq(slashedUsdg, 1_000e6);
        assertEq(slashedOfpk, 2e18);
        assertEq(usdg.balanceOf(court), 1_000e6);
        assertEq(ofpk.balanceOf(treasury), 2e18);
        HostView memory v = registry.hostView(host);
        assertEq(v.bondUsdg, 4_000e6);
        assertEq(v.bondOfpk, 8e18);
        assertEq(v.strikes, 1);
    }

    function test_slashCannotExceedTheBond() public {
        vm.prank(court);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.SlashTooLarge.selector, uint16(10_001)));
        registry.slash(host, 10_001, REASON);
    }

    function test_slashWorksWithNoOfpkBond() public {
        _register(host, BOND, 0);
        vm.prank(court);
        registry.slash(host, 10_000, REASON);
        assertEq(registry.hostView(host).bondUsdg, 0);
    }

    // Exit

    function test_exitReturnsBondsAfterSevenDays() public {
        _register(host, BOND, 5e18);
        vm.prank(host);
        registry.exit();
        assertEq(registry.hostView(host).status, EXITING);
        assertFalse(registry.routable(host));

        uint64 available = uint64(START + 7 days);
        vm.warp(available - 1);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.ExitNotAvailable.selector, available));
        vm.prank(host);
        registry.finalizeExit();

        vm.warp(available);
        vm.prank(host);
        registry.finalizeExit();
        assertEq(usdg.balanceOf(host), BOND);
        assertEq(ofpk.balanceOf(host), 5e18);
        assertEq(registry.hostView(host).status, NONE);
    }

    function test_oneHoursCreditsShareOneEntry() public {
        _register(host, BOND, 0);
        for (uint256 i; i < 501; ++i) {
            _accrue(host, 1);
        }
        assertEq(registry.hostView(host).pendingCredits, 501);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 501, "501 credits in one hour fit in one withdrawal");
    }

    function test_aCreditAfterAClawbackKeepsItsOwnEntry() public {
        _register(host, BOND, 0);
        _accrue(host, 5);
        vm.prank(guardian);
        registry.clawBack(host, uint64(block.timestamp / 3600), keccak256("bad"));
        _accrue(host, 7);
        assertEq(registry.hostView(host).pendingCredits, 7);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 7);
    }

    function test_aMergedCreditKeepsTheFullDelay() public {
        _register(host, BOND, 0);
        uint256 hourStart = block.timestamp / 3600 * 3600;
        vm.warp(hourStart + 1);
        _accrue(host, 1);
        vm.warp(hourStart + 1800);
        _accrue(host, 2);
        vm.warp(hourStart + 1 + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 0, "the late credit is still inside its 24 hours");
        vm.warp(hourStart + 1800 + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 3);
    }

    function test_totalOwedFollowsBondsAndCreditsExactly() public {
        _register(host, BOND, 0);
        assertEq(registry.totalOwed(), BOND);
        _accrue(host, 3e6);
        assertEq(registry.totalOwed(), BOND + 3e6);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(registry.totalOwed(), BOND);
        vm.startPrank(host);
        registry.exit();
        vm.warp(block.timestamp + 7 days);
        registry.finalizeExit();
        vm.stopPrank();
        assertEq(registry.totalOwed(), 0);
        assertEq(usdg.balanceOf(address(registry)), 0);
    }

    function test_creditsStayWithdrawableAfterExit() public {
        _register(host, BOND, 0);
        _accrue(host, 3e6);
        vm.prank(host);
        registry.exit();
        vm.warp(START + 7 days);
        vm.startPrank(host);
        registry.finalizeExit();
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), BOND + 3e6);
    }

    function test_openChallengeBlocksExitAndFinalize() public {
        _register(host, BOND, 0);
        vm.prank(court);
        registry.addChallenge(host);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.OpenChallenges.selector, host, uint32(1)));
        vm.prank(host);
        registry.exit();

        vm.prank(court);
        registry.removeChallenge(host);
        vm.prank(host);
        registry.exit();
        vm.prank(court);
        registry.addChallenge(host);
        vm.warp(START + 7 days);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.OpenChallenges.selector, host, uint32(1)));
        vm.prank(host);
        registry.finalizeExit();
    }

    function test_frozenHostCannotExit() public {
        _activeHost(host);
        vm.prank(court);
        registry.freeze(host);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.WrongStatus.selector, host, HostRegistry.Status.Frozen));
        vm.prank(host);
        registry.exit();
    }

    function test_freezeDuringUnbondingRestoresExiting() public {
        _register(host, BOND, 0);
        vm.prank(host);
        registry.exit();
        vm.startPrank(court);
        registry.freeze(host);
        registry.unfreeze(host);
        assertEq(registry.hostView(host).status, EXITING);
    }

    function test_finalizeNeedsAnExit() public {
        _register(host, BOND, 0);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.WrongStatus.selector, host, HostRegistry.Status.Probation));
        vm.prank(host);
        registry.finalizeExit();
    }

    function test_exitedHostCanRegisterAgainButKeepsItsStrikes() public {
        _register(host, BOND, 0);
        vm.prank(court);
        registry.slash(host, 100, REASON);
        vm.prank(host);
        registry.exit();
        vm.warp(START + 7 days);
        vm.prank(host);
        registry.finalizeExit();

        _register(host, BOND, 0);
        assertEq(registry.hostView(host).status, PROBATION);
        assertEq(registry.hostView(host).strikes, 1);
    }

    function test_delistedHostGetsItsRemainingBondButStaysDelisted() public {
        _activeHost(host);
        vm.startPrank(court);
        registry.slash(host, 2_000, REASON);
        registry.delist(host);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(HostRegistry.WrongStatus.selector, host, HostRegistry.Status.Delisted));
        vm.prank(host);
        registry.finalizeExit();

        vm.prank(host);
        registry.exit();
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.WrongStatus.selector, host, HostRegistry.Status.Delisted));
        vm.prank(host);
        registry.exit();

        vm.warp(block.timestamp + 7 days);
        vm.prank(host);
        registry.finalizeExit();
        assertEq(usdg.balanceOf(host), BOND - 400e6);
        assertEq(registry.hostView(host).status, DELISTED);

        RegisterParams memory p = _params(BOND, 0);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.AlreadyRegistered.selector, host));
        vm.prank(host);
        registry.register(p);
    }

    // Rewards

    function test_accrueRewardsIsSplitterOnlyAndStaysOutOfTheBondRing() public {
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.NotAuthorized.selector, address(this)));
        registry.accrueRewards(1, _credit(host, 1));

        usdg.mint(address(registry), 50_000e6);
        vm.expectEmit(address(registry));
        emit IHostRegistry.RewardsAccrued(host, 7, 50_000e6, uint64(START + 24 hours));
        vm.prank(address(splitter));
        registry.accrueRewards(7, _credit(host, 50_000e6));
        assertEq(registry.requiredBond(host), BOND);
        assertEq(registry.hostView(host).pendingCredits, 50_000e6);

        vm.warp(START + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 50_000e6);
    }

    // Price sheets

    function test_priceSheetReproducesTheGoldenVector() public {
        string memory json = vm.readFile("../packages/shared/fixtures/vectors.json");
        address vectorRegistry = json.readAddress(".addresses.contracts.HostRegistry");
        vm.etch(vectorRegistry, address(registry).code);

        PriceSheet memory s = _sheet(json.readAddress(".priceSheet.host"), 200_000, 800_000);
        s.modelDigest = json.readBytes32(".priceSheet.modelDigest");
        s.floorIn = 100_000;
        s.floorOut = 400_000;
        s.validFrom = 1_700_000_000;
        s.nonce = 1;
        (bool ok, bytes32 hash) = HostRegistry(vectorRegistry).verifyPriceSheet(s, json.readBytes(".priceSheet.signature"));
        assertTrue(ok);
        assertEq(hash, json.readBytes32(".priceSheet.hash"));
    }

    function test_priceSheetRejectsTheWrongSigner() public {
        (address operator,) = makeAddrAndKey("operator");
        (, uint256 wrongKey) = makeAddrAndKey("wrong");
        PriceSheet memory s = _sheet(operator, 1_000, 1_000);
        (bool ok,) = registry.verifyPriceSheet(s, _signSheet(wrongKey, s));
        assertFalse(ok);
    }

    function test_priceSheetFloorMayBeExactlySixtyPercentOfTheLowestHour() public {
        (address operator, uint256 key) = makeAddrAndKey("operator");
        PriceSheet memory s = _sheet(operator, 1_000, 1_000);
        s.baseIn[100] = 500;
        s.baseOut[7] = 500;
        s.floorIn = 300;
        s.floorOut = 300;
        (bool ok,) = registry.verifyPriceSheet(s, _signSheet(key, s));
        assertTrue(ok);
    }

    function test_priceSheetRejectsAFloorAboveTheRuleOnEitherSide() public {
        (address operator, uint256 key) = makeAddrAndKey("operator");
        PriceSheet memory s = _sheet(operator, 1_000, 1_000);
        s.baseIn[100] = 500;
        s.floorIn = 301;
        (bool ok,) = registry.verifyPriceSheet(s, _signSheet(key, s));
        assertFalse(ok);

        s = _sheet(operator, 1_000, 1_000);
        s.baseOut[167] = 500;
        s.floorOut = 301;
        (ok,) = registry.verifyPriceSheet(s, _signSheet(key, s));
        assertFalse(ok);
    }

    function test_priceSheetAcceptsContractWallets() public {
        ContractWallet wallet = new ContractWallet();
        PriceSheet memory s = _sheet(address(wallet), 1_000, 1_000);
        (, bytes32 hash) = registry.verifyPriceSheet(s, "");
        wallet.approve(hash);
        (bool ok,) = registry.verifyPriceSheet(s, "");
        assertTrue(ok);
    }

    function test_setPeersOnce() public {
        vm.prank(owner);
        vm.expectRevert(HostRegistry.AlreadySet.selector);
        registry.setPeers(address(1), address(2), address(3), address(4));
    }

    function test_setPeersEmits() public {
        HostRegistry fresh = new HostRegistry(owner, IERC20(address(usdg)), IERC20(address(ofpk)), guardian, treasury);
        vm.startPrank(owner);
        vm.expectEmit(address(fresh));
        emit IHostRegistry.PeersSet(address(1), address(0), address(0), address(0));
        fresh.setPeers(address(1), address(0), address(0), address(0));
        vm.expectEmit(address(fresh));
        emit IHostRegistry.PeersSet(address(1), address(2), address(3), address(4));
        fresh.setPeers(address(0), address(2), address(3), address(4));
        vm.stopPrank();
    }

    // Helpers

    function _digests(bytes32 digest) private pure returns (bytes32[] memory digests) {
        digests = new bytes32[](1);
        digests[0] = digest;
    }

    function _tps(uint32 value) private pure returns (uint32[] memory tps) {
        tps = new uint32[](1);
        tps[0] = value;
    }

    function _params(uint256 bondUsdg, uint256 bondOfpk) private pure returns (RegisterParams memory p) {
        p.modelDigests = _digests(MODEL);
        p.maxTps = _tps(100);
        p.imageDigest = IMAGE;
        p.gpuClass = GPU;
        p.endpointHash = ENDPOINT;
        p.attestationRef = ATTESTATION;
        p.bondUsdg = bondUsdg;
        p.bondOfpk = bondOfpk;
    }

    function _fundHost(address operator, uint256 usdgAmount, uint256 ofpkAmount) private {
        usdg.mint(operator, usdgAmount);
        ofpk.mint(operator, ofpkAmount);
        vm.startPrank(operator);
        usdg.approve(address(registry), type(uint256).max);
        ofpk.approve(address(registry), type(uint256).max);
        vm.stopPrank();
    }

    function _register(address operator, uint256 bondUsdg, uint256 bondOfpk) private {
        _fundHost(operator, bondUsdg, bondOfpk);
        RegisterParams memory p = _params(bondUsdg, bondOfpk);
        vm.prank(operator);
        registry.register(p);
    }

    function _activeHost(address operator) private {
        _register(operator, BOND, 0);
        vm.warp(block.timestamp + 72 hours);
        registry.activate(operator);
    }

    function _credit(address operator, uint128 amount) private pure returns (Credit[] memory credits) {
        credits = new Credit[](1);
        credits[0] = Credit({host: operator, amount: amount});
    }

    function _accrue(address operator, uint128 amount) private {
        usdg.mint(address(registry), amount);
        vm.prank(address(vault));
        registry.accrueCredits(uint64(block.timestamp / 3600), _credit(operator, amount));
    }

    function _sheet(address operator, uint64 baseIn, uint64 baseOut) private pure returns (PriceSheet memory s) {
        s.host = operator;
        s.modelDigest = MODEL;
        for (uint64 i; i < 168; ++i) {
            s.baseIn[i] = baseIn + (baseIn >= 200_000 ? i * 100 : 0);
            s.baseOut[i] = baseOut + (baseOut >= 200_000 ? i * 100 : 0);
        }
    }

    function _signSheet(uint256 key, PriceSheet memory s) private view returns (bytes memory) {
        (, bytes32 hash) = registry.verifyPriceSheet(s, "");
        return _sig(key, hash);
    }

    function test_noPeerCanRecordACreditItDidNotFund() public {
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({host: address(0xBAD), amount: 1});
        bytes memory refused =
            abi.encodeWithSelector(HostRegistry.UnbackedCredits.selector, usdg.balanceOf(address(registry)), registry.totalOwed() + 1);
        vm.prank(address(vault));
        vm.expectRevert(refused);
        registry.accrueCredits(1, credits);
    }
}
