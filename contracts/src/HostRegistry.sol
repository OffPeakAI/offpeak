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

    function updateServing(
        bytes32[] calldata modelDigests,
        uint32[] calldata maxTps,
        bytes32 imageDigest,
        bytes32 gpuClass,
        bytes32 attestationRef
    ) external {
        Host storage h = _hosts[msg.sender];
        if (h.status != Status.Probation && h.status != Status.Active) revert WrongStatus(msg.sender, h.status);
        if (!allowedGpuClass[gpuClass]) revert GpuClassNotAllowed(gpuClass);
        bool changed = imageDigest != h.imageDigest || gpuClass != h.gpuClass
            || keccak256(abi.encode(modelDigests)) != keccak256(abi.encode(_models[msg.sender]));
        h.imageDigest = imageDigest;
        h.gpuClass = gpuClass;
        h.attestationRef = attestationRef;
        _setModels(msg.sender, modelDigests, maxTps);
        if (changed) {
            h.status = Status.Probation;
            h.probationEnds = uint64(block.timestamp + PROBATION);
            emit HostStatusChanged(msg.sender, uint8(Status.Probation));
        }
        emit ServingUpdated(msg.sender, imageDigest, gpuClass, modelDigests, maxTps, h.probationEnds, attestationRef);
    }

    function activate(address host) external {
        Host storage h = _hosts[host];
        if (h.status != Status.Probation) revert WrongStatus(host, h.status);
        if (block.timestamp < h.probationEnds) revert ProbationNotOver(h.probationEnds);
        uint256 required = requiredBond(host);
        if (h.bondUsdg < required) revert BondBelowRequired(h.bondUsdg, required);
        h.status = Status.Active;
        emit HostStatusChanged(host, uint8(Status.Active));
    }

    function verifyPriceSheet(PriceSheet calldata s, bytes calldata sig) external view returns (bool ok, bytes32 sheetHash) {
        sheetHash = _hashTypedDataV4(Typehashes.hash(s));
        ok = _floorHolds(s.floorIn, s.baseIn) && _floorHolds(s.floorOut, s.baseOut)
            && SignatureChecker.isValidSignatureNow(s.host, sheetHash, sig);
    }

    function topUpBond(uint256 usdgAmount, uint256 ofpkAmount) external nonReentrant {
        Host storage h = _hosts[msg.sender];
        if (h.status == Status.None) revert NotRegistered(msg.sender);
        h.bondUsdg += usdgAmount;
        h.bondOfpk += ofpkAmount;
        totalOwed += usdgAmount;
        emit BondChanged(msg.sender, h.bondUsdg, h.bondOfpk);
        _pullBonds(usdgAmount, ofpkAmount);
    }

    function updateEndpoint(bytes32 endpointHash) external {
        Host storage h = _hosts[msg.sender];
        if (h.status == Status.None) revert NotRegistered(msg.sender);
        h.endpointHash = endpointHash;
        emit EndpointUpdated(msg.sender, endpointHash);
    }

    /// A delisted host stays Delisted through its exit, so leaving cannot clear the listing.
    function exit() external {
        Host storage h = _hosts[msg.sender];
        Status status = h.status;
        bool canExit = status == Status.Probation || status == Status.Active
            || (status == Status.Delisted && h.exitAvailableAt == 0);
        if (!canExit) revert WrongStatus(msg.sender, status);
        if (h.openChallenges > 0) revert OpenChallenges(msg.sender, h.openChallenges);
        h.exitAvailableAt = uint64(block.timestamp + UNBONDING);
        if (status != Status.Delisted) {
            h.status = Status.Exiting;
            emit HostStatusChanged(msg.sender, uint8(Status.Exiting));
        }
    }

    function finalizeExit() external nonReentrant {
        Host storage h = _hosts[msg.sender];
        if (h.exitAvailableAt == 0 || (h.status != Status.Exiting && h.status != Status.Delisted)) {
            revert WrongStatus(msg.sender, h.status);
        }
        if (block.timestamp < h.exitAvailableAt) revert ExitNotAvailable(h.exitAvailableAt);
        if (h.openChallenges > 0) revert OpenChallenges(msg.sender, h.openChallenges);
        uint256 bondUsdg = h.bondUsdg;
        uint256 bondOfpk = h.bondOfpk;
        h.bondUsdg = 0;
        h.bondOfpk = 0;
        h.exitAvailableAt = 0;
        totalOwed -= bondUsdg;
        emit BondChanged(msg.sender, 0, 0);
        if (h.status == Status.Exiting) {
            h.status = Status.None;
            emit HostStatusChanged(msg.sender, uint8(Status.None));
        }
        if (bondUsdg > 0) usdg.safeTransfer(msg.sender, bondUsdg);
        if (bondOfpk > 0) ofpk.safeTransfer(msg.sender, bondOfpk);
    }

    function withdrawCredits() external nonReentrant {
        Host storage h = _hosts[msg.sender];
        if (h.openChallenges > 0) revert OpenChallenges(msg.sender, h.openChallenges);
        if (h.status == Status.Frozen) revert HostFrozen(msg.sender);
        if (h.forfeited) revert CreditsForfeited(msg.sender);
        uint256 total = _takeReleasable(msg.sender);
        emit CreditsWithdrawn(msg.sender, total);
        if (total > 0) usdg.safeTransfer(msg.sender, total);
    }

    /// After a full slash, anyone can move the host's released credits into the reserve.
    function sweepForfeitedCredits(address host) external nonReentrant {
        if (!_hosts[host].forfeited) revert NotForfeited(host);
        uint256 total = _takeReleasable(host);
        emit CreditsWithdrawn(host, total);
        if (total == 0) return;
        usdg.forceApprove(vault, total);
        IOffpeakVault(vault).fundReserve(total);
    }

    function _takeReleasable(address host) private returns (uint256 total) {
        CreditEntry[] storage entries = _credits[host];
        uint256 i = _creditHead[host];
        uint256 end = i + MAX_WITHDRAW_ENTRIES;
        if (end > entries.length) end = entries.length;
        for (; i < end; ++i) {
            CreditEntry storage entry = entries[i];
            if (entry.releasableAt > block.timestamp) break;
            if (!entry.clawed) total += entry.amount;
            delete entries[i];
        }
        _creditHead[host] = i;
        totalOwed -= total;
    }

    /// One entry per host per hour, so nobody can pad the list until a seizure runs out of gas.
    function _recordCredit(address host, uint64 hour, uint64 releasableAt, uint128 amount) private {
        CreditEntry[] storage entries = _credits[host];
        uint256 count = entries.length;
        if (count > _creditHead[host]) {
            CreditEntry storage last = entries[count - 1];
            if (last.hour == hour && !last.clawed) {
                last.amount += amount;
                last.releasableAt = releasableAt;
                return;
            }
        }
        entries.push(CreditEntry(hour, releasableAt, amount, false));
    }

    function _recordOwed(Credit[] calldata credits) private {
        uint256 total;
        for (uint256 i; i < credits.length; ++i) {
            total += credits[i].amount;
        }
        totalOwed += total;
        uint256 balance = usdg.balanceOf(address(this));
        if (balance < totalOwed) revert UnbackedCredits(balance, totalOwed);
    }

    /// Never reverts on a host's state, so a settle can always land.
    function accrueCredits(uint64 hour, Credit[] calldata credits) external {
        if (msg.sender != vault && msg.sender != windowMarket) revert NotAuthorized(msg.sender);
        _recordOwed(credits);
        uint64 releasableAt = uint64(block.timestamp + CREDIT_DELAY);
        for (uint256 i; i < credits.length; ++i) {
            Credit calldata credit = credits[i];
            if (credit.amount == 0) continue;
            _recordCredit(credit.host, hour, releasableAt, credit.amount);
            _addToRing(_hosts[credit.host], credit.amount);
            emit CreditsAccrued(credit.host, hour, credit.amount, releasableAt);
        }
    }

    /// Rewards are not revenue: they follow the credit delay but stay out of the required-bond ring.
    /// Also how the court returns seized credits, which were already counted in the ring.
    function accrueRewards(uint64 week, Credit[] calldata credits) external {
        if (msg.sender != feeSplitter && msg.sender != auditCourt) revert NotAuthorized(msg.sender);
        _recordOwed(credits);
        uint64 releasableAt = uint64(block.timestamp + CREDIT_DELAY);
        for (uint256 i; i < credits.length; ++i) {
            Credit calldata credit = credits[i];
            if (credit.amount == 0) continue;
            _credits[credit.host].push(CreditEntry(0, releasableAt, credit.amount, false));
            emit RewardsAccrued(credit.host, week, credit.amount, releasableAt);
        }
    }

    function clawBack(address host, uint64 hour, bytes32 reason) external nonReentrant {
        if (msg.sender != auditCourt && msg.sender != guardian) revert NotAuthorized(msg.sender);
        CreditEntry[] storage entries = _credits[host];
        uint256 head = _creditHead[host];
        uint256 total;
        for (uint256 i = entries.length; i > head; --i) {
            CreditEntry storage entry = entries[i - 1];
            if (entry.releasableAt <= block.timestamp) break;
            if (entry.hour == hour && !entry.clawed) {
                entry.clawed = true;
                total += entry.amount;
            }
        }
        if (total == 0) return;
        totalOwed -= total;
        emit CreditsClawedBack(host, hour, uint128(total), reason);
        usdg.forceApprove(vault, total);
        IOffpeakVault(vault).fundReserve(total);
    }

    /// Moves every unreleased credit to the court, which holds it until the outcome is known.
    function seizePendingCredits(address host, bytes32 reason) external onlyAuditCourt nonReentrant returns (uint256 total) {
        CreditEntry[] storage entries = _credits[host];
        uint256 head = _creditHead[host];
        for (uint256 i = entries.length; i > head; --i) {
            CreditEntry storage entry = entries[i - 1];
            if (entry.releasableAt <= block.timestamp) break;
            if (entry.clawed) continue;
            entry.clawed = true;
            total += entry.amount;
            emit CreditsClawedBack(host, entry.hour, entry.amount, reason);
        }
        totalOwed -= total;
        if (total > 0) usdg.safeTransfer(auditCourt, total);
    }

    function freeze(address host) external onlyAuditCourt {
        Host storage h = _hosts[host];
        if (h.status == Status.None || h.status == Status.Delisted) return;
        if (h.freezes++ > 0) return;
        h.frozenFrom = h.status;
        h.status = Status.Frozen;
        emit HostStatusChanged(host, uint8(Status.Frozen));
    }

    function unfreeze(address host) external onlyAuditCourt {
        Host storage h = _hosts[host];
        if (h.freezes == 0 || --h.freezes > 0 || h.status != Status.Frozen) return;
        h.status = h.frozenFrom;
        emit HostStatusChanged(host, uint8(h.status));
    }

    function addChallenge(address host) external onlyAuditCourt {
        Host storage h = _hosts[host];
        emit ChallengesChanged(host, ++h.openChallenges);
    }

    function removeChallenge(address host) external onlyAuditCourt {
        Host storage h = _hosts[host];
        emit ChallengesChanged(host, --h.openChallenges);
    }

    function slash(address host, uint16 bps, bytes32 evidence)
        external
        onlyAuditCourt
        nonReentrant
        returns (uint256 slashedUsdg, uint256 slashedOfpk)
    {
        if (bps > 10_000) revert SlashTooLarge(bps);
        Host storage h = _hosts[host];
        // Without this a stack of Breach rulings could take nearly the whole bond and skip the panel.
        if (bps < 10_000 && h.status == Status.Delisted) return (0, 0);
        slashedUsdg = h.bondUsdg * bps / 10_000;
        slashedOfpk = h.bondOfpk * bps / 10_000;
        h.bondUsdg -= slashedUsdg;
        h.bondOfpk -= slashedOfpk;
        totalOwed -= slashedUsdg;
        if (bps == 10_000) h.forfeited = true;
        emit HostSlashed(host, bps, slashedUsdg, slashedOfpk, evidence);
        emit HostStruck(host, ++h.strikes);
        emit BondChanged(host, h.bondUsdg, h.bondOfpk);
        if (slashedUsdg > 0) usdg.safeTransfer(auditCourt, slashedUsdg);
        if (slashedOfpk > 0) ofpk.safeTransfer(treasury, slashedOfpk);
    }

    function delist(address host) external onlyAuditCourt {
        Host storage h = _hosts[host];
        h.status = Status.Delisted;
        h.freezes = 0;
        h.exitAvailableAt = 0;
        emit HostStatusChanged(host, uint8(Status.Delisted));
    }

    function hostView(address host) external view returns (HostView memory v) {
        Host storage h = _hosts[host];
        v.operator = h.operator;
        v.status = uint8(h.status);
        v.bondUsdg = h.bondUsdg;
        v.bondOfpk = h.bondOfpk;
        v.requiredBond = requiredBond(host);
        v.imageDigest = h.imageDigest;
        v.gpuClass = h.gpuClass;
        v.attestationRef = h.attestationRef;
        v.probationEnds = h.probationEnds;
        v.strikes = h.strikes;
        v.openChallenges = h.openChallenges;
        CreditEntry[] storage entries = _credits[host];
        for (uint256 i = _creditHead[host]; i < entries.length; ++i) {
            CreditEntry storage entry = entries[i];
            if (entry.clawed) continue;
            if (entry.releasableAt <= block.timestamp) v.releasableCredits += entry.amount;
            else v.pendingCredits += entry.amount;
        }
    }

    function standing(address host) external view returns (uint8 status, uint8 strikes) {
        Host storage h = _hosts[host];
        return (uint8(h.status), h.strikes);
    }

    function modelsOf(address host) external view returns (bytes32[] memory) {
        return _models[host];
    }

    function requiredBond(address host) public view returns (uint256) {
        Host storage h = _hosts[host];
        uint256 today = block.timestamp / 1 days;
        uint256 age = today - h.lastCreditDay;
        uint256 total;
        for (uint256 back = 0; back + age < RING_DAYS; ++back) {
            total += h.dailyCredits[(h.lastCreditDay - back) % RING_DAYS];
        }
        uint256 required = total * REQUIRED_BOND_BPS / 10_000;
        return required > MIN_BOND ? required : MIN_BOND;
    }

    function routable(address host) external view returns (bool) {
        Host storage h = _hosts[host];
        return h.status == Status.Active && h.bondUsdg >= requiredBond(host);
    }

    function _setModels(address host, bytes32[] calldata modelDigests, uint32[] calldata maxTps) private {
        if (modelDigests.length == 0 || modelDigests.length != maxTps.length) revert InvalidModels();
        bytes32[] storage current = _models[host];
        for (uint256 i; i < current.length; ++i) {
            delete maxTpsOf[host][current[i]];
        }
        delete _models[host];
        for (uint256 i; i < modelDigests.length; ++i) {
            if (maxTps[i] == 0) revert InvalidModels();
            maxTpsOf[host][modelDigests[i]] = maxTps[i];
            current.push(modelDigests[i]);
        }
    }

    function _addToRing(Host storage h, uint128 amount) private {
        uint64 today = uint64(block.timestamp / 1 days);
        uint64 last = h.lastCreditDay;
        if (today != last) {
            uint256 stale = today - last;
            if (stale > RING_DAYS) stale = RING_DAYS;
            for (uint256 back; back < stale; ++back) {
                delete h.dailyCredits[(today - back) % RING_DAYS];
            }
            h.lastCreditDay = today;
        }
        h.dailyCredits[today % RING_DAYS] += amount;
    }

    function _pullBonds(uint256 usdgAmount, uint256 ofpkAmount) private {
        if (usdgAmount > 0) usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);
        if (ofpkAmount > 0) ofpk.safeTransferFrom(msg.sender, address(this), ofpkAmount);
    }

    function _floorHolds(uint64 floor, uint64[168] calldata base) private pure returns (bool) {
        uint64 lowest = base[0];
        for (uint256 i = 1; i < 168; ++i) {
            if (base[i] < lowest) lowest = base[i];
        }
        return uint256(floor) * 10_000 <= FLOOR_MAX_RATIO_BPS * uint256(lowest);
    }
}
