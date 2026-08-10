// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAuditCourt} from "./interfaces/IAuditCourt.sol";
import {IHostRegistry} from "./interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import "./interfaces/OffpeakTypes.sol";
import {ThresholdSig} from "./lib/ThresholdSig.sol";
import {Typehashes} from "./lib/Typehashes.sol";

/// @notice Records evidence hashes, enforces timing, bonds and who may sign. It never decides statistics.
/// No path reaches a full slash without a panel Confirm.
contract AuditCourt is IAuditCourt, EIP712, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error AlreadyClaimed(uint256 challengeId, address buyer);
    error BadPanelSignature();
    error BadRefundProof();
    error BadSlash(uint8 outcome, uint16 slashBps);
    error HostNotRegistered(address host);
    error NotFinalizable(uint256 challengeId);
    error NotHost(address caller);
    error ResponseWindowOver(uint64 endsAt);
    error ResponseWindowOpen(uint64 endsAt);
    error ReviewOver(uint64 endsAt);
    error ReviewNotOver(uint64 endsAt);
    error SignersNotDue(uint64 at);
    error SwapNeedsSwapChallenge(uint8 kind);
    error SweepTooEarly(uint64 availableAt);
    error UnknownOutcome(uint8 outcome);
    error UnsortedSigners();
    error WrongState(uint256 challengeId, State state);

    enum State {
        None,
        Filed,
        PanelReview,
        Decided,
        Finalized
    }

    struct Challenge {
        address host;
        address challenger;
        uint8 kind;
        State state;
        bool responded;
        uint8 decision;
        uint16 slashBps;
        uint64 filedAt;
        uint64 reviewEndsAt;
        uint64 finalizedAt;
        bytes32 evidenceHash;
        bytes32 refundRoot;
        /// Slashed USDG still owed to affected buyers.
        uint256 refundable;
        /// Pending host credits held here until the outcome is known.
        uint256 seized;
    }

    uint8 public constant OUTCOME_DISMISS = 0;
    uint8 public constant OUTCOME_BREACH = 1;
    uint8 public constant OUTCOME_SWAP = 2;
    uint8 public constant DECISION_CONFIRM = 0;
    uint8 public constant DECISION_DOWNGRADE = 1;
    uint8 public constant DECISION_DISMISS = 2;
    uint8 public constant KIND_SWAP = 0;
    uint8 public constant STRIKES_TO_DELIST = 2;
    uint16 public constant SWAP_SLASH_BPS = 10_000;
    uint16 public constant BREACH_SLASH_BPS = 2_000;
    uint256 public constant CHALLENGE_BOND = 100e6;
    uint256 public constant HOST_RESPONSE = 24 hours;
    uint256 public constant PANEL_REVIEW = 7 days;
    uint256 public constant PANEL_TIMEOUT = 14 days;
    /// The panel can only Confirm once the review ends, so it always gets this long afterwards.
    uint256 public constant CONFIRM_WINDOW = 7 days;
    /// Longer than the 7 day unbonding, so a host sees a new signer set coming in time to leave.
    uint256 public constant SIGNER_DELAY = 8 days;
    uint256 public constant REFUND_WINDOW = 90 days;

    IERC20 public immutable usdg;
    IHostRegistry public immutable registry;
    IOffpeakVault public immutable vault;
    address[3] public rulers;
    address public panel;
    address public treasury;
    uint256 public nextChallengeId = 1;
    mapping(uint256 => Challenge) internal _challenges;
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    /// Payments a frozen address could not take. It collects them with `claimOwed` once it can.
    mapping(address => uint256) public owed;
    address[3] public pendingRulers;
    address public pendingPanel;
    uint64 public signersDueAt;

    constructor(
        address owner_,
        IERC20 usdg_,
        IHostRegistry registry_,
        IOffpeakVault vault_,
        address[3] memory rulers_,
        address panel_,
        address treasury_
    ) EIP712("OffpeakAudit", "1") Ownable(owner_) {
        _requireSorted(rulers_);
        usdg = usdg_;
        registry = registry_;
        vault = vault_;
        rulers = rulers_;
        panel = panel_;
        treasury = treasury_;
    }

    function challenge(Evidence calldata e) external nonReentrant returns (uint256 challengeId) {
        (uint8 status,) = registry.standing(e.host);
        if (status == 0) revert HostNotRegistered(e.host);
        challengeId = nextChallengeId++;
        Challenge storage c = _challenges[challengeId];
        c.host = e.host;
        c.challenger = msg.sender;
        c.kind = e.kind;
        c.state = State.Filed;
        c.filedAt = uint64(block.timestamp);
        c.evidenceHash = keccak256(abi.encode(e));
        emit ChallengeFiled(challengeId, e.host, msg.sender, e.kind, c.evidenceHash);
        emit EvidenceFiled(
            challengeId, e.modelDigest, e.samplesRoot, e.sampleCount, e.testId, e.statistic, e.threshold, e.uri
        );
        registry.addChallenge(e.host);
        usdg.safeTransferFrom(msg.sender, address(this), CHALLENGE_BOND);
    }

    function respond(uint256 challengeId, bytes32 responseHash) external {
        Challenge storage c = _challenges[challengeId];
        if (msg.sender != c.host) revert NotHost(msg.sender);
        if (c.state != State.Filed) revert WrongState(challengeId, c.state);
        uint64 endsAt = c.filedAt + uint64(HOST_RESPONSE);
        if (block.timestamp > endsAt) revert ResponseWindowOver(endsAt);
        c.responded = true;
        emit HostResponded(challengeId, responseHash);
    }

    function postRuling(Ruling calldata r, bytes calldata thresholdSig) external nonReentrant {
        Challenge storage c = _challenges[r.challengeId];
        if (c.state != State.Filed) revert WrongState(r.challengeId, c.state);
        uint64 responseEnds = c.filedAt + uint64(HOST_RESPONSE);
        if (!c.responded && block.timestamp < responseEnds) revert ResponseWindowOpen(responseEnds);
        ThresholdSig.verify2of3(rulers, _hashTypedDataV4(Typehashes.hash(r)), thresholdSig);
        emit RulingPosted(r.challengeId, r.outcome, r.slashBps);

        if (r.outcome == OUTCOME_DISMISS) {
            if (r.slashBps != 0) revert BadSlash(r.outcome, r.slashBps);
            _dismissByRuling(r.challengeId, c);
        } else if (r.outcome == OUTCOME_BREACH) {
            if (r.slashBps != BREACH_SLASH_BPS) revert BadSlash(r.outcome, r.slashBps);
            _slashAndClose(r.challengeId, c, BREACH_SLASH_BPS, r.refundRoot);
        } else if (r.outcome == OUTCOME_SWAP) {
            if (r.slashBps != SWAP_SLASH_BPS) revert BadSlash(r.outcome, r.slashBps);
            if (c.kind != KIND_SWAP) revert SwapNeedsSwapChallenge(c.kind);
            _openPanelReview(r.challengeId, c);
        } else {
            revert UnknownOutcome(r.outcome);
        }
    }

    function appeal(uint256 challengeId, bytes32 appealHash) external {
        Challenge storage c = _challenges[challengeId];
        if (msg.sender != c.host) revert NotHost(msg.sender);
        if (c.state != State.PanelReview) revert WrongState(challengeId, c.state);
        if (block.timestamp >= c.reviewEndsAt) revert ReviewOver(c.reviewEndsAt);
        emit AppealFiled(challengeId, appealHash);
    }
