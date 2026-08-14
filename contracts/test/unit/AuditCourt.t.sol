// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuditCourt} from "../../src/AuditCourt.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import {IAuditCourt} from "../../src/interfaces/IAuditCourt.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "../../src/interfaces/IOffpeakVault.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {ThresholdSig} from "../../src/lib/ThresholdSig.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {CourtFixture} from "../helpers/CourtFixture.sol";

contract AuditCourtTest is CourtFixture {
    uint8 internal constant SWAP = 0;
    uint8 internal constant CANARY = 3;
    uint8 internal constant DISMISS = 0;
    uint8 internal constant BREACH = 1;
    uint8 internal constant OUTCOME_SWAP = 2;
    uint8 internal constant CONFIRM = 0;
    uint8 internal constant DOWNGRADE = 1;
    uint8 internal constant PANEL_DISMISS = 2;
    uint8 internal constant ACTIVE = 2;
    uint8 internal constant FROZEN = 3;
    uint8 internal constant DELISTED = 5;
    bytes32 internal constant NO_ROOT = bytes32(0);

    address internal host = makeAddr("host");
    address internal buyerA = address(0xA001);
    address internal buyerB = address(0xB002);

    function setUp() public override {
        super.setUp();
        _allowGpuClass();
        _activeHost(host);
    }

    function _responded(uint8 kind) private returns (uint256 id) {
        id = _file(host, kind);
        vm.prank(host);
        auditCourt.respond(id, keccak256("response"));
    }

    function _inReview() private returns (uint256 id) {
        id = _responded(SWAP);
        _rule(id, OUTCOME_SWAP, 10_000, NO_ROOT);
    }

    function _reviewDone(uint256 id) private {
        vm.warp(auditCourt.challengeView(id).reviewEndsAt);
    }

    /// A two-leaf refund tree over buyerA and buyerB.
    function _refundTree(uint256 amountA, uint256 amountB)
        private
        view
        returns (bytes32 root, bytes32[] memory proofA, bytes32[] memory proofB)
    {
        bytes32 leafA = keccak256(bytes.concat(keccak256(abi.encode(buyerA, amountA))));
        bytes32 leafB = keccak256(bytes.concat(keccak256(abi.encode(buyerB, amountB))));
        (bytes32 lo, bytes32 hi) = leafA < leafB ? (leafA, leafB) : (leafB, leafA);
        root = keccak256(abi.encodePacked(lo, hi));
        proofA = new bytes32[](1);
        proofB = new bytes32[](1);
        proofA[0] = leafB;
        proofB[0] = leafA;
    }

    // Filing

    function test_filingPullsTheBondAndBlocksWithdrawals() public {
        _accrue(host, 5e6);
        Evidence memory e = _evidence(host, SWAP);
        usdg.mint(challenger, CHALLENGE_BOND);
        vm.startPrank(challenger);
        usdg.approve(address(auditCourt), CHALLENGE_BOND);
        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.ChallengeFiled(1, host, challenger, SWAP, keccak256(abi.encode(e)));
        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.EvidenceFiled(1, e.modelDigest, e.samplesRoot, e.sampleCount, e.testId, e.statistic, e.threshold, e.uri);
        auditCourt.challenge(e);
        vm.stopPrank();

        assertEq(usdg.balanceOf(address(auditCourt)), CHALLENGE_BOND);
        assertEq(registry.hostView(host).openChallenges, 1);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.OpenChallenges.selector, host, uint32(1)));
        vm.prank(host);
        registry.withdrawCredits();
    }

    function test_filingNeedsARegisteredHost() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.HostNotRegistered.selector, stranger));
        auditCourt.challenge(_evidence(stranger, SWAP));
    }

    // Host response

    function test_respondIsHostOnly() public {
        uint256 id = _file(host, SWAP);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.NotHost.selector, address(this)));
        auditCourt.respond(id, bytes32(0));
    }

    function test_respondWindowIsExactlyTwentyFourHours() public {
        uint256 id = _file(host, SWAP);
        uint64 endsAt = uint64(block.timestamp + 24 hours);
        vm.warp(endsAt + 1);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.ResponseWindowOver.selector, endsAt));
        vm.prank(host);
        auditCourt.respond(id, bytes32(0));

        uint256 second = _file(host, SWAP);
        vm.warp(block.timestamp + 24 hours);
        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.HostResponded(second, keccak256("r"));
        vm.prank(host);
        auditCourt.respond(second, keccak256("r"));
    }

    // Ruling timing and shape

    function test_rulingWaitsForTheResponseOrTwentyFourHours() public {
        uint256 id = _file(host, CANARY);
        Ruling memory r = _ruling(id, DISMISS, 0, NO_ROOT);
        bytes memory sig = _rulingSig(r);
        uint64 endsAt = uint64(block.timestamp + 24 hours);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.ResponseWindowOpen.selector, endsAt));
        auditCourt.postRuling(r, sig);
        vm.warp(endsAt);
        auditCourt.postRuling(r, sig);
    }

    function test_aResponseOpensRulingEarly() public {
        uint256 id = _responded(CANARY);
        _rule(id, DISMISS, 0, NO_ROOT);
        assertEq(uint8(auditCourt.challengeView(id).state), uint8(AuditCourt.State.Finalized));
    }

    function test_rulingNeedsTwoRulers() public {
        uint256 id = _responded(CANARY);
        Ruling memory r = _ruling(id, DISMISS, 0, NO_ROOT);
        bytes memory one = _sig(rulerKeys[0], _auditDigest(Typehashes.hash(r)));
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        auditCourt.postRuling(r, one);
    }

    function test_settlementKeysCannotRule() public {
        uint256 id = _responded(CANARY);
        Ruling memory r = _ruling(id, BREACH, 2_000, NO_ROOT);
        bytes32 digest = _auditDigest(Typehashes.hash(r));
        bytes memory sig = bytes.concat(_sig(settlerKeys[0], digest), _sig(settlerKeys[1], digest));
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        auditCourt.postRuling(r, sig);
    }

    function test_aChallengeIsRuledOnce() public {
        uint256 id = _responded(CANARY);
        _rule(id, DISMISS, 0, NO_ROOT);
        Ruling memory r = _ruling(id, BREACH, 2_000, NO_ROOT);
        bytes memory sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.WrongState.selector, id, AuditCourt.State.Finalized));
        auditCourt.postRuling(r, sig);
    }

    function test_eachOutcomeHasOneSlashSize() public {
        uint256 id = _responded(SWAP);
        Ruling memory r = _ruling(id, DISMISS, 1, NO_ROOT);
        bytes memory sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.BadSlash.selector, DISMISS, uint16(1)));
        auditCourt.postRuling(r, sig);

        r = _ruling(id, BREACH, 10_000, NO_ROOT);
        sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.BadSlash.selector, BREACH, uint16(10_000)));
        auditCourt.postRuling(r, sig);

        r = _ruling(id, OUTCOME_SWAP, 2_000, NO_ROOT);
        sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.BadSlash.selector, OUTCOME_SWAP, uint16(2_000)));
        auditCourt.postRuling(r, sig);
    }

    function test_unknownOutcomesRevert() public {
        uint256 id = _responded(SWAP);
        Ruling memory r = _ruling(id, 9, 0, NO_ROOT);
        bytes memory sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.UnknownOutcome.selector, uint8(9)));
        auditCourt.postRuling(r, sig);
    }

    function test_onlyASwapChallengeCanBeRuledASwap() public {
        uint256 id = _responded(CANARY);
        Ruling memory r = _ruling(id, OUTCOME_SWAP, 10_000, NO_ROOT);
        bytes memory sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.SwapNeedsSwapChallenge.selector, CANARY));
        auditCourt.postRuling(r, sig);
    }

    // Dismiss and breach

    function test_dismissalPaysTheHostHalfTheBond() public {
        uint256 id = _responded(CANARY);
        _rule(id, DISMISS, 0, NO_ROOT);
        assertEq(usdg.balanceOf(host), 50e6);
        assertEq(usdg.balanceOf(challenger), 50e6);
        assertEq(registry.hostView(host).openChallenges, 0);
        assertEq(registry.hostView(host).bondUsdg, BOND);
    }

    function test_breachSlashesTwentyPercentAtOnceAndReturnsTheBond() public {
        uint256 id = _responded(CANARY);
        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.ChallengeFinalized(id, 2_000, 400e6, 0);
        _rule(id, BREACH, 2_000, keccak256("root"));

        HostView memory v = registry.hostView(host);
        assertEq(v.bondUsdg, BOND - 400e6);
        assertEq(v.strikes, 1);
        assertEq(v.status, ACTIVE);
        assertEq(v.openChallenges, 0);
        assertEq(usdg.balanceOf(challenger), CHALLENGE_BOND);
        assertEq(auditCourt.challengeView(id).refundable, 400e6);
        assertEq(auditCourt.challengeView(id).refundRoot, keccak256("root"));
    }

    function test_theSecondStrikeDelists() public {
        _rule(_responded(CANARY), BREACH, 2_000, NO_ROOT);
        _rule(_responded(CANARY), BREACH, 2_000, NO_ROOT);
        assertEq(registry.hostView(host).status, DELISTED);
        assertEq(registry.hostView(host).strikes, 2);
    }

    // Swap and panel review

    function test_aSwapRulingSlashesNothingAndFreezesTheHost() public {
        _accrue(host, 8e6);
        uint256 id = _responded(SWAP);
        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.PanelReviewOpened(id, uint64(block.timestamp + 7 days));
        _rule(id, OUTCOME_SWAP, 10_000, NO_ROOT);

        HostView memory v = registry.hostView(host);
        assertEq(v.bondUsdg, BOND, "no slash before the panel");
        assertEq(v.status, FROZEN);
        assertEq(v.pendingCredits, 0);
        assertFalse(registry.routable(host));
        assertEq(auditCourt.challengeView(id).seized, 8e6);
        assertEq(usdg.balanceOf(address(auditCourt)), CHALLENGE_BOND + 8e6, "credits wait in the court");
    }

    function test_rulingKeysAloneCanNeverFullySlash() public {
        uint256 id = _inReview();
        vm.warp(block.timestamp + 365 days);
        Ruling memory r = _ruling(id, OUTCOME_SWAP, 10_000, NO_ROOT);
        bytes memory sig = _rulingSig(r);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.WrongState.selector, id, AuditCourt.State.PanelReview));
        auditCourt.postRuling(r, sig);

        auditCourt.finalize(id);
        assertEq(registry.hostView(host).bondUsdg, BOND, "a timeout dismisses, it never slashes");
    }

    function test_appealIsHostOnlyAndInsideTheReview() public {
        uint256 id = _inReview();
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.NotHost.selector, address(this)));
        auditCourt.appeal(id, keccak256("appeal"));

        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.AppealFiled(id, keccak256("appeal"));
        vm.prank(host);
        auditCourt.appeal(id, keccak256("appeal"));

        uint64 endsAt = auditCourt.challengeView(id).reviewEndsAt;
        vm.warp(endsAt);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.ReviewOver.selector, endsAt));
        vm.prank(host);
        auditCourt.appeal(id, keccak256("appeal"));
    }

    function test_appealOutsideAReviewReverts() public {
        uint256 id = _responded(CANARY);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.WrongState.selector, id, AuditCourt.State.Filed));
        vm.prank(host);
        auditCourt.appeal(id, keccak256("appeal"));
    }

    function test_aSlashCannotLandBeforeTheAppealWindowCloses() public {
        uint256 id = _inReview();
        uint64 endsAt = auditCourt.challengeView(id).reviewEndsAt;
        PanelDecision memory d = _decision(id, CONFIRM, 10_000, NO_ROOT);
        panel.approve(_auditDigest(Typehashes.hash(d)));
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.ReviewNotOver.selector, endsAt));
        auditCourt.postPanelDecision(d, "");

        PanelDecision memory down = _decision(id, DOWNGRADE, 2_000, NO_ROOT);
        panel.approve(_auditDigest(Typehashes.hash(down)));
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.ReviewNotOver.selector, endsAt));
        auditCourt.postPanelDecision(down, "");

        vm.warp(endsAt);
        auditCourt.postPanelDecision(d, "");
    }

    function test_thePanelCanDismissAtAnyTime() public {
        uint256 id = _inReview();
        _decide(id, PANEL_DISMISS, 0, NO_ROOT);
        auditCourt.finalize(id);
        assertEq(registry.hostView(host).status, ACTIVE);
    }

    function test_decisionsNeedThePanel() public {
        uint256 id = _inReview();
        _reviewDone(id);
        PanelDecision memory d = _decision(id, CONFIRM, 10_000, NO_ROOT);
        vm.expectRevert(AuditCourt.BadPanelSignature.selector);
        auditCourt.postPanelDecision(d, "");
    }

    function test_rulingKeysCannotActAsThePanel() public {
        vm.prank(owner);
        auditCourt.proposeSigners(rulers, address(panel));
        vm.warp(block.timestamp + 8 days);
        auditCourt.applySigners();
        uint256 id = _inReview();
        _reviewDone(id);
        PanelDecision memory d = _decision(id, CONFIRM, 10_000, NO_ROOT);
        bytes32 digest = _auditDigest(Typehashes.hash(d));
        bytes memory sig = bytes.concat(_sig(rulerKeys[0], digest), _sig(rulerKeys[1], digest));
        vm.expectRevert(AuditCourt.BadPanelSignature.selector);
        auditCourt.postPanelDecision(d, sig);
    }

    function test_eachDecisionHasOneSlashSize() public {
        uint256 id = _inReview();
        _reviewDone(id);
        uint8[3] memory decisions = [CONFIRM, DOWNGRADE, PANEL_DISMISS];
        uint16[3] memory wrong = [uint16(2_000), uint16(10_000), uint16(1)];
        for (uint256 i; i < 3; ++i) {
            PanelDecision memory d = _decision(id, decisions[i], wrong[i], NO_ROOT);
            panel.approve(_auditDigest(Typehashes.hash(d)));
            vm.expectRevert(abi.encodeWithSelector(AuditCourt.BadSlash.selector, decisions[i], wrong[i]));
            auditCourt.postPanelDecision(d, "");
        }
    }

    function test_unknownDecisionsRevert() public {
        uint256 id = _inReview();
        PanelDecision memory d = _decision(id, 3, 0, NO_ROOT);
        panel.approve(_auditDigest(Typehashes.hash(d)));
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.UnknownOutcome.selector, uint8(3)));
        auditCourt.postPanelDecision(d, "");
    }

    function test_decisionsNeedAnOpenReview() public {
        uint256 id = _responded(CANARY);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.WrongState.selector, id, AuditCourt.State.Filed));
        auditCourt.postPanelDecision(_decision(id, CONFIRM, 10_000, NO_ROOT), "");
    }

    // Outcomes of a review

    function test_confirmSlashesEverythingDelistsAndFundsTheReserve() public {
        _accrue(host, 8e6);
        uint256 id = _inReview();
        _reviewDone(id);
        _decide(id, CONFIRM, 10_000, keccak256("root"));
        assertEq(registry.hostView(host).bondUsdg, BOND, "the slash waits for finalize");

        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.ChallengeFinalized(id, 10_000, BOND, 0);
        auditCourt.finalize(id);

        HostView memory v = registry.hostView(host);
        assertEq(v.bondUsdg, 0);
        assertEq(v.status, DELISTED);
        assertEq(v.openChallenges, 0);
        assertEq(vault.protocolReserve(), 8e6, "seized credits fund refunds");
        assertEq(usdg.balanceOf(challenger), CHALLENGE_BOND);
        assertEq(auditCourt.challengeView(id).refundable, BOND);
        assertEq(usdg.balanceOf(address(auditCourt)), BOND);
    }

    function test_downgradeSlashesTwentyPercentAndGivesCreditsBack() public {
        _accrue(host, 8e6);
        uint256 id = _inReview();
        _reviewDone(id);
        _decide(id, DOWNGRADE, 2_000, NO_ROOT);
        auditCourt.finalize(id);

        HostView memory v = registry.hostView(host);
        assertEq(v.bondUsdg, BOND - 400e6);
        assertEq(v.status, ACTIVE);
        assertEq(v.strikes, 1);
        assertEq(v.pendingCredits, 8e6);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(host);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(host), 8e6);
    }

    function test_aDowngradeOnASecondStrikeDelists() public {
        _rule(_responded(CANARY), BREACH, 2_000, NO_ROOT);
        uint256 id = _inReview();
        _reviewDone(id);
        _decide(id, DOWNGRADE, 2_000, NO_ROOT);
        auditCourt.finalize(id);
        assertEq(registry.hostView(host).status, DELISTED);
    }

    function test_panelDismissalReturnsTheFullBondAndTheCredits() public {
        _accrue(host, 8e6);
        uint256 id = _inReview();
        _decide(id, PANEL_DISMISS, 0, NO_ROOT);
        auditCourt.finalize(id);

        HostView memory v = registry.hostView(host);
        assertEq(v.bondUsdg, BOND);
        assertEq(v.status, ACTIVE);
        assertEq(v.strikes, 0);
        assertEq(v.pendingCredits, 8e6);
        assertEq(usdg.balanceOf(challenger), CHALLENGE_BOND, "the ruling keys agreed, so the bond is whole");
        assertEq(usdg.balanceOf(address(auditCourt)), 0);
    }

    function test_restoredCreditsDoNotRaiseTheRequiredBond() public {
        _accrue(host, 11_000e6);
        uint256 required = registry.requiredBond(host);
        uint256 id = _inReview();
        _decide(id, PANEL_DISMISS, 0, NO_ROOT);
        auditCourt.finalize(id);
        assertEq(registry.requiredBond(host), required);
    }

    function test_finalizeNeedsADecisionOrATimeout() public {
        uint256 id = _inReview();
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.NotFinalizable.selector, id));
        auditCourt.finalize(id);
    }

    function test_aFinalizedChallengeCannotRunTwice() public {
        uint256 id = _inReview();
        _decide(id, PANEL_DISMISS, 0, NO_ROOT);
        auditCourt.finalize(id);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.NotFinalizable.selector, id));
        auditCourt.finalize(id);
    }

    // Timeouts

    function test_noPanelDecisionInFourteenDaysDismisses() public {
        _accrue(host, 8e6);
        uint256 id = _inReview();
        uint256 timeoutAt = auditCourt.challengeView(id).filedAt + 14 days;
        vm.warp(timeoutAt - 1);
        vm.expectRevert(abi.encodeWithSelector(AuditCourt.NotFinalizable.selector, id));
        auditCourt.finalize(id);

        vm.warp(timeoutAt);
        vm.expectEmit(address(auditCourt));
        emit IAuditCourt.PanelTimeout(id);
        vm.prank(makeAddr("anyone"));
        auditCourt.finalize(id);

        HostView memory v = registry.hostView(host);
        assertEq(v.status, ACTIVE);
        assertEq(v.bondUsdg, BOND);
        assertEq(v.pendingCredits, 8e6);
        assertEq(usdg.balanceOf(challenger), CHALLENGE_BOND);
    }
