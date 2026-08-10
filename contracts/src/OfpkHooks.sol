// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFeeSplitter} from "./interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "./interfaces/IHostRegistry.sol";
import {IOfpkHooks} from "./interfaces/IOfpkHooks.sol";

/// @notice Utility only: fee tiers, early Window access and a routing bonus for bonded hosts. Nothing here pays
/// lockers, and every hook reads as off until the splitter's single switch turns on after the legal gate.
contract OfpkHooks is IOfpkHooks, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error HooksDisabled();
    error NothingToUnlock();
    error StillCoolingDown(uint64 availableAt);
    error TooMuch(uint256 available, uint256 requested);
    error TiersNotAscending();
    error DiscountTooHigh(uint16 bps);
    error ZeroAmount();

    struct Lock {
        uint256 locked;
        uint256 unlocking;
        uint64 availableAt;
    }

    uint256 public constant COOLDOWN = 7 days;
    uint16 public constant MAX_ROUTING_BONUS_BPS = 2_500;
    /// `FEE_BPS_DEFAULT` less `FEE_BPS_MIN`: a discount can never take the fee below the floor.
    uint16 public constant MAX_DISCOUNT_BPS = 300;
    uint256 public constant TIERS = 4;

    IERC20 public immutable ofpk;
    IHostRegistry public immutable registry;
    IFeeSplitter public immutable splitter;

    /// Locked $OFPK needed for tiers 1 to 3, in token units. Timelocked, since the owner is the timelock.
    uint256[3] public tierThresholds = [1_000e18, 10_000e18, 100_000e18];
    uint16[4] public tierDiscountBps = [0, 25, 50, 100];
    /// Routing bonus in bps per whole $OFPK bonded, scaled by 1e18.
    uint256 public bonusPerOfpk = 1e15;

    mapping(address => Lock) public locks;

    constructor(address owner_, IERC20 ofpk_, IHostRegistry registry_, IFeeSplitter splitter_) Ownable(owner_) {
        ofpk = ofpk_;
        registry = registry_;
        splitter = splitter_;
    }

    function setTiers(uint256[3] calldata thresholds, uint16[4] calldata discountBps) external onlyOwner {
        if (thresholds[0] == 0 || thresholds[0] >= thresholds[1] || thresholds[1] >= thresholds[2]) revert TiersNotAscending();
        if (discountBps[0] != 0) revert DiscountTooHigh(discountBps[0]);
        for (uint256 i; i < TIERS; ++i) {
            if (discountBps[i] > MAX_DISCOUNT_BPS) revert DiscountTooHigh(discountBps[i]);
        }
        tierThresholds = thresholds;
        tierDiscountBps = discountBps;
    }

    function setBonusPerOfpk(uint256 bonus) external onlyOwner {
        bonusPerOfpk = bonus;
    }

    function lock(uint256 amount) external nonReentrant {
        if (!splitter.tokenHooksEnabled()) revert HooksDisabled();
        if (amount == 0) revert ZeroAmount();
        Lock storage l = locks[msg.sender];
        l.locked += amount;
        emit Locked(msg.sender, amount, l.locked);
        ofpk.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// Stops counting toward the tier at once. A further request restarts the cooldown for everything unlocking.
    function requestUnlock(uint256 amount) external {
        Lock storage l = locks[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > l.locked) revert TooMuch(l.locked, amount);
        l.locked -= amount;
        l.unlocking += amount;
        l.availableAt = uint64(block.timestamp + COOLDOWN);
        emit UnlockRequested(msg.sender, amount, l.availableAt);
    }

    /// Works whether or not the hooks are on, so turning them off can never trap a lock.
    function unlock() external nonReentrant {
        Lock storage l = locks[msg.sender];
        uint256 amount = l.unlocking;
        if (amount == 0) revert NothingToUnlock();
        if (block.timestamp < l.availableAt) revert StillCoolingDown(l.availableAt);
        l.unlocking = 0;
        l.availableAt = 0;
        emit Unlocked(msg.sender, amount);
        ofpk.safeTransfer(msg.sender, amount);
    }

    function tierOf(address a) public view returns (uint8 tier) {
        if (!splitter.tokenHooksEnabled()) return 0;
        uint256 locked = locks[a].locked;
        for (uint256 i; i < 3; ++i) {
            if (locked >= tierThresholds[i]) tier = uint8(i + 1);
        }
    }

    function feeDiscountBps(address a) external view returns (uint16) {
        return tierDiscountBps[tierOf(a)];
    }

    function earlyAccess(address a) external view returns (bool) {
        return tierOf(a) >= 1;
    }

    function routingBonusBps(address host) external view returns (uint16) {
        if (!splitter.tokenHooksEnabled()) return 0;
        uint256 bonus = registry.hostView(host).bondOfpk * bonusPerOfpk / 1e36;
        return bonus > MAX_ROUTING_BONUS_BPS ? MAX_ROUTING_BONUS_BPS : uint16(bonus);
    }
}
