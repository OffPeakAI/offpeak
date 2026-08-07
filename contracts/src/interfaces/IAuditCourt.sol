// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./OffpeakTypes.sol";

interface IAuditCourt {
    event ChallengeFiled(
        uint256 indexed challengeId, address indexed host, address indexed challenger, uint8 kind, bytes32 evidenceHash
    );
    event EvidenceFiled(
        uint256 indexed challengeId,
        bytes32 modelDigest,
        bytes32 samplesRoot,
        uint32 sampleCount,
        bytes32 testId,
        int256 statistic,
        int256 threshold,
        string uri
    );
    event HostResponded(uint256 indexed challengeId, bytes32 responseHash);
    event RulingPosted(uint256 indexed challengeId, uint8 outcome, uint16 slashBps);
    event PanelReviewOpened(uint256 indexed challengeId, uint64 reviewEndsAt);
    event AppealFiled(uint256 indexed challengeId, bytes32 appealHash);
    event PanelDecided(uint256 indexed challengeId, uint8 decision, uint16 finalSlashBps);
    event PanelTimeout(uint256 indexed challengeId);
    event ChallengeFinalized(uint256 indexed challengeId, uint16 slashBps, uint256 slashedUsdg, uint256 slashedOfpk);
    event RefundClaimed(uint256 indexed challengeId, address indexed buyer, uint256 amount);
    event RefundSwept(uint256 indexed challengeId, uint256 amount);
    event SignersProposed(address[3] rulers, address panel, uint64 dueAt);
    event SignersChanged(address[3] oldSigners, address[3] newSigners);
    event PanelChanged(address oldPanel, address newPanel);

    function challenge(Evidence calldata e) external returns (uint256 challengeId);
    function respond(uint256 challengeId, bytes32 responseHash) external;
    function postRuling(Ruling calldata r, bytes calldata thresholdSig) external;
    function appeal(uint256 challengeId, bytes32 appealHash) external;
    function postPanelDecision(PanelDecision calldata d, bytes calldata panelSig) external;
    function finalize(uint256 challengeId) external;
    function claimRefund(uint256 challengeId, address buyer, uint256 amount, bytes32[] calldata proof) external;
    function sweep(uint256 challengeId) external;
    function proposeSigners(address[3] calldata nextRulers, address nextPanel) external;
    function applySigners() external;
    function claimOwed() external;
}
