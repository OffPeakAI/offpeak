// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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
