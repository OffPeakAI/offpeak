// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IHostRegistry} from "./interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import "./interfaces/OffpeakTypes.sol";
import {Typehashes} from "./lib/Typehashes.sol";

contract HostRegistry is IHostRegistry, EIP712, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error AlreadyRegistered(address host);
    error AlreadySet();
    error CreditsForfeited(address host);
    error BondBelowRequired(uint256 bond, uint256 required);
    error BondTooLow(uint256 bond, uint256 minimum);
    error ExitNotAvailable(uint64 availableAt);
    error GpuClassNotAllowed(bytes32 gpuClass);
    error HostFrozen(address host);
    error InvalidModels();
    error NotAuthorized(address caller);
    error NotForfeited(address host);
    error NotRegistered(address host);
    error OpenChallenges(address host, uint32 openChallenges);
    error ProbationNotOver(uint64 probationEnds);
    error SlashTooLarge(uint16 bps);
    error UnbackedCredits(uint256 balance, uint256 owed);
    error WrongStatus(address host, Status status);

    enum Status {
        None,
        Probation,
        Active,
        Frozen,
        Exiting,
        Delisted
    }

    struct Host {
        address operator;
        Status status;
        Status frozenFrom;
        uint8 strikes;
        uint8 freezes;
        uint32 openChallenges;
        /// A full slash forfeits every credit not yet withdrawn, however old.
        bool forfeited;
        uint256 bondUsdg;
        uint256 bondOfpk;
        bytes32 imageDigest;
        bytes32 gpuClass;
        bytes32 attestationRef;
        bytes32 endpointHash;
        uint64 probationEnds;
        uint64 exitAvailableAt;
        uint64 lastCreditDay;
        uint128[30] dailyCredits;
    }

    struct CreditEntry {
        uint64 hour;
        uint64 releasableAt;
        uint128 amount;
        bool clawed;
    }

    uint256 public constant MIN_BOND = 2_000e6;
    uint256 public constant PROBATION = 72 hours;
    uint256 public constant UNBONDING = 7 days;
    uint256 public constant CREDIT_DELAY = 24 hours;
    uint256 public constant REQUIRED_BOND_BPS = 2_000;
    uint256 public constant FLOOR_MAX_RATIO_BPS = 6_000;
    uint256 public constant MAX_WITHDRAW_ENTRIES = 500;
    uint256 internal constant RING_DAYS = 30;

    IERC20 public immutable usdg;
    IERC20 public immutable ofpk;

    address public vault;
    address public windowMarket;
    address public auditCourt;
    address public feeSplitter;
    address public guardian;
    address public treasury;
    mapping(bytes32 => bool) public allowedGpuClass;
    mapping(address => mapping(bytes32 => uint32)) public maxTpsOf;

    mapping(address => Host) internal _hosts;
    mapping(address => bytes32[]) internal _models;
    mapping(address => CreditEntry[]) internal _credits;
    mapping(address => uint256) internal _creditHead;
    /// USDG owed to all hosts in bonds and credits. No peer can record a credit it did not fund, so a bad
    /// peer cannot pay itself out of the bonds.
    uint256 public totalOwed;

    modifier onlyAuditCourt() {
        if (msg.sender != auditCourt) revert NotAuthorized(msg.sender);
        _;
    }

    constructor(address owner_, IERC20 usdg_, IERC20 ofpk_, address guardian_, address treasury_)
        EIP712("OffpeakPriceSheet", "1")
        Ownable(owner_)
    {
        usdg = usdg_;
        ofpk = ofpk_;
        guardian = guardian_;
        treasury = treasury_;
    }

    function setPeers(address vault_, address windowMarket_, address auditCourt_, address feeSplitter_) external onlyOwner {
        vault = _once(vault, vault_);
        windowMarket = _once(windowMarket, windowMarket_);
        auditCourt = _once(auditCourt, auditCourt_);
        feeSplitter = _once(feeSplitter, feeSplitter_);
    }

    /// Peers arrive with their launch phase. Each can be set once; zero leaves a slot for later.
    function _once(address current, address next) private pure returns (address) {
        if (next == address(0)) return current;
        if (current != address(0)) revert AlreadySet();
        return next;
    }

    function setGpuClass(bytes32 gpuClass, bool allowed) external onlyOwner {
        allowedGpuClass[gpuClass] = allowed;
        emit GpuClassSet(gpuClass, allowed);
    }

    function register(RegisterParams calldata p) external nonReentrant {
        Host storage h = _hosts[msg.sender];
        if (h.status != Status.None) revert AlreadyRegistered(msg.sender);
        if (p.bondUsdg < MIN_BOND) revert BondTooLow(p.bondUsdg, MIN_BOND);
        if (!allowedGpuClass[p.gpuClass]) revert GpuClassNotAllowed(p.gpuClass);
        uint64 probationEnds = uint64(block.timestamp + PROBATION);
        h.operator = msg.sender;
        h.status = Status.Probation;
        h.bondUsdg = p.bondUsdg;
        h.bondOfpk = p.bondOfpk;
        totalOwed += p.bondUsdg;
        h.imageDigest = p.imageDigest;
        h.gpuClass = p.gpuClass;
        h.attestationRef = p.attestationRef;
        h.endpointHash = p.endpointHash;
        h.probationEnds = probationEnds;
        h.exitAvailableAt = 0;
        _setModels(msg.sender, p.modelDigests, p.maxTps);
        emit HostRegistered(msg.sender, p.imageDigest, p.gpuClass, p.modelDigests, p.maxTps, probationEnds, p.attestationRef);
        emit EndpointUpdated(msg.sender, p.endpointHash);
        emit BondChanged(msg.sender, p.bondUsdg, p.bondOfpk);
        emit HostStatusChanged(msg.sender, uint8(Status.Probation));
        _pullBonds(p.bondUsdg, p.bondOfpk);
    }
