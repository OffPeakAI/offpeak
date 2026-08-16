// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFeeSplitter} from "./interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "./interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import "./interfaces/OffpeakTypes.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {ThresholdSig} from "./lib/ThresholdSig.sol";
import {Typehashes} from "./lib/Typehashes.sol";

/// @notice Nothing here pays $OFPK holders or lockers. The burn stays off until the legal gate passes.
contract FeeSplitter is IFeeSplitter, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error AlreadySet();
    error BatchTooLarge(uint256 length, uint256 max);
    error InsufficientRewardBucket(uint256 available, uint256 requested);
    error NoSwapAdapter();
    error NotBurnKeeper(address caller);
    error NotFeeSource(address caller);
    error NotSorted();
    error RewardWeekPaid(uint64 week);
    error SettlesPaused();
    error TokenHooksDisabled();

    uint256 public constant OPS_BPS = 8_000;
    uint256 public constant TREASURY_BPS = 1_000;
    uint256 public constant HOST_REWARDS_BPS = 500;
    uint256 public constant BURN_BPS = 500;
    uint256 public constant MAX_CREDITS = 500;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    IERC20 public immutable usdg;
    IHostRegistry public immutable registry;
    address public immutable opsWallet;
    address public immutable treasury;

    IOffpeakVault public vault;
    address public windowMarket;
    address public swapAdapter;
    /// Picks `minOut`, so an open call could sandwich the burn. Stays empty until the legal gate passes.
    address public burnKeeper;
    bool public tokenHooksEnabled;
    uint256 public undistributed;
    uint256 public hostRewardBucket;
    uint256 public burnBucket;
    mapping(uint64 => bool) public rewardWeekPaid;

    constructor(address owner_, IERC20 usdg_, IHostRegistry registry_, address opsWallet_, address treasury_)
        Ownable(owner_)
    {
        usdg = usdg_;
        registry = registry_;
        opsWallet = opsWallet_;
        treasury = treasury_;
    }

    function setPeers(address vault_, address windowMarket_) external onlyOwner {
        if (vault_ != address(0)) {
            if (address(vault) != address(0)) revert AlreadySet();
            vault = IOffpeakVault(vault_);
        }
        if (windowMarket_ != address(0)) {
            if (windowMarket != address(0)) revert AlreadySet();
            windowMarket = windowMarket_;
        }
    }

    function setTokenHooksEnabled(bool enabled) external onlyOwner {
        tokenHooksEnabled = enabled;
        emit TokenHooksChanged(enabled);
    }

    function setSwapAdapter(address adapter) external onlyOwner {
        swapAdapter = adapter;
        emit SwapAdapterChanged(adapter);
    }

    function setBurnKeeper(address keeper) external onlyOwner {
        burnKeeper = keeper;
        emit BurnKeeperChanged(keeper);
    }

    /// The caller has already transferred `amount` of USDG to this contract.
    function notify(uint256 amount) external {
        if (msg.sender != address(vault) && msg.sender != windowMarket) revert NotFeeSource(msg.sender);
        undistributed += amount;
        emit FeesNotified(amount);
    }

    /// With token hooks off, the burn share goes to the treasury. Rounding dust goes to the ops wallet.
    function distribute() external nonReentrant {
        uint256 amount = undistributed;
        undistributed = 0;
        uint256 rewards = amount * HOST_REWARDS_BPS / 10_000;
        uint256 burn = tokenHooksEnabled ? amount * BURN_BPS / 10_000 : 0;
        uint256 treasuryBps = tokenHooksEnabled ? TREASURY_BPS : TREASURY_BPS + BURN_BPS;
        uint256 toTreasury = amount * treasuryBps / 10_000;
        uint256 toOps = amount - rewards - burn - toTreasury;
        hostRewardBucket += rewards;
        burnBucket += burn;
        emit FeesDistributed(toOps, toTreasury, rewards, burn);
        if (toOps > 0) usdg.safeTransfer(opsWallet, toOps);
        if (toTreasury > 0) usdg.safeTransfer(treasury, toTreasury);
    }

    function distributeRewards(RewardBatch calldata r, bytes calldata thresholdSig) external nonReentrant {
        if (vault.settlesPaused()) revert SettlesPaused();
        if (r.credits.length > MAX_CREDITS) revert BatchTooLarge(r.credits.length, MAX_CREDITS);
        if (rewardWeekPaid[r.week]) revert RewardWeekPaid(r.week);
        ThresholdSig.verify2of3(_settlers(), _rewardDigest(r), thresholdSig);

        uint256 total;
        address previous;
        for (uint256 i; i < r.credits.length; ++i) {
            if (r.credits[i].host <= previous) revert NotSorted();
            previous = r.credits[i].host;
            total += r.credits[i].amount;
        }
        if (total > hostRewardBucket) revert InsufficientRewardBucket(hostRewardBucket, total);
        rewardWeekPaid[r.week] = true;
        hostRewardBucket -= total;
        emit RewardsDistributed(r.week, total);
        if (total > 0) usdg.safeTransfer(address(registry), total);
        registry.accrueRewards(r.week, r.credits);
    }

    function executeBurn(uint256 minOut) external nonReentrant {
        if (!tokenHooksEnabled) revert TokenHooksDisabled();
        if (msg.sender != burnKeeper) revert NotBurnKeeper(msg.sender);
        address adapter = swapAdapter;
        if (adapter == address(0)) revert NoSwapAdapter();
        uint256 amount = burnBucket;
        burnBucket = 0;
        usdg.forceApprove(adapter, amount);
        uint256 burned = ISwapAdapter(adapter).swap(amount, minOut, BURN_ADDRESS);
        emit BurnExecuted(amount, burned);
    }

    function _settlers() private view returns (address[3] memory set) {
        for (uint256 i; i < 3; ++i) {
            set[i] = vault.settlers(i);
        }
    }

    /// RewardBatch is signed in the OffpeakSettlement domain, whose verifying contract is the vault.
    function _rewardDigest(RewardBatch calldata r) private view returns (bytes32) {
        bytes32 separator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("OffpeakSettlement"), keccak256("1"), block.chainid, address(vault)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", separator, Typehashes.hash(r)));
    }
}
