// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./OffpeakTypes.sol";

interface IHostRegistry {
    event HostRegistered(
        address indexed host,
        bytes32 imageDigest,
        bytes32 gpuClass,
        bytes32[] modelDigests,
        uint32[] maxTps,
        uint64 probationEnds,
        bytes32 attestationRef
    );
    event ServingUpdated(
        address indexed host,
        bytes32 imageDigest,
        bytes32 gpuClass,
        bytes32[] modelDigests,
        uint32[] maxTps,
        uint64 probationEnds,
        bytes32 attestationRef
    );
    event EndpointUpdated(address indexed host, bytes32 endpointHash);
    event BondChanged(address indexed host, uint256 bondUsdg, uint256 bondOfpk);
    event HostStatusChanged(address indexed host, uint8 status);
    event HostSlashed(address indexed host, uint16 bps, uint256 slashedUsdg, uint256 slashedOfpk, bytes32 evidence);
    event HostStruck(address indexed host, uint8 strikes);
    event ChallengesChanged(address indexed host, uint32 openChallenges);
    event CreditsAccrued(address indexed host, uint64 indexed hour, uint128 amount, uint64 releasableAt);
    event RewardsAccrued(address indexed host, uint64 indexed week, uint128 amount, uint64 releasableAt);
    event CreditsClawedBack(address indexed host, uint64 indexed hour, uint128 amount, bytes32 reason);
    event CreditsWithdrawn(address indexed host, uint256 amount);
    event GpuClassSet(bytes32 indexed gpuClass, bool allowed);
    event PeersSet(address vault, address windowMarket, address auditCourt, address feeSplitter);

    function register(RegisterParams calldata p) external;
    function updateServing(
        bytes32[] calldata modelDigests,
        uint32[] calldata maxTps,
        bytes32 imageDigest,
        bytes32 gpuClass,
        bytes32 attestationRef
    ) external;
    function activate(address host) external;
    function verifyPriceSheet(PriceSheet calldata s, bytes calldata sig) external view returns (bool ok, bytes32 sheetHash);
    function topUpBond(uint256 usdg, uint256 ofpk) external;
    function updateEndpoint(bytes32 endpointHash) external;
    function exit() external;
    function finalizeExit() external;
    function withdrawCredits() external;
    function sweepForfeitedCredits(address host) external;
    function hostView(address host) external view returns (HostView memory);
    function modelsOf(address host) external view returns (bytes32[] memory);
    function standing(address host) external view returns (uint8 status, uint8 strikes);
    function requiredBond(address host) external view returns (uint256);
    function routable(address host) external view returns (bool);
    function maxTpsOf(address host, bytes32 modelDigest) external view returns (uint32);

    function accrueCredits(uint64 hour, Credit[] calldata credits) external;
    function accrueRewards(uint64 week, Credit[] calldata credits) external;
    function clawBack(address host, uint64 hour, bytes32 reason) external;
    function seizePendingCredits(address host, bytes32 reason) external returns (uint256 total);
    function freeze(address host) external;
    function unfreeze(address host) external;
    function addChallenge(address host) external;
    function removeChallenge(address host) external;
    function slash(address host, uint16 bps, bytes32 evidence) external returns (uint256 slashedUsdg, uint256 slashedOfpk);
    function delist(address host) external;
}
