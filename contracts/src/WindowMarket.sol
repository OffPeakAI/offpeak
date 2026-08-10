// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IFeeSplitter} from "./interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "./interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import {IOfpkHooks} from "./interfaces/IOfpkHooks.sol";
import {IWindowMarket} from "./interfaces/IWindowMarket.sol";
import "./interfaces/OffpeakTypes.sol";
import {HourMath} from "./lib/HourMath.sol";
import {ThresholdSig} from "./lib/ThresholdSig.sol";
import {Typehashes} from "./lib/Typehashes.sol";

/// @notice Reserved capacity sold as ERC-1155 units of 1,000,000 tokens. Payments sit in escrow until the tokens
/// are served, resold, cancelled or refunded. No owner path can move escrow or collateral.
contract WindowMarket is IWindowMarket, ERC1155, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error AuctionClosed(uint256 id);
    error BadTiming();
    error BatchTransfersOff();
    error CollateralTooLow(uint256 collateral, uint256 required);
    error EarlyAccessOnly(address buyer);
    error InsufficientUnits(uint256 available, uint256 requested);
    error ListingClosed(uint256 listingId);
    error MarketShareExceeded(uint64 hour);
    error NotClaimable(uint256 id);
    error NotHost(address caller);
    error NotOwner(address caller);
    error NotRoutable(address host);
    error NotSeller(address caller);
    error NotVault(address caller);
    error PerformanceClosed(uint256 id);
    error PriceAboveMax(uint256 price, uint256 max);
    error SettlesPaused();
    error StillListed(uint256 id, uint64 units);
    error UnitsLocked(uint256 id);
    error UnknownWindow(uint256 id);
    error WindowStarted(uint256 id);
    error WindowTooLong();
    error WindowEnded(uint256 id);
    error WindowNotEnded(uint256 id);
    error ZeroUnits();

    struct Window {
        address host;
        bytes32 modelDigest;
        uint64 t0;
        uint64 t1;
        uint32 minTps;
        uint64 units;
        uint64 sold;
        uint64 live;
        uint64 startPrice;
        uint64 endPrice;
        uint64 auctionStart;
        uint64 auctionEnd;
        uint64 sharedUnits;
        uint64 perfFinalAt;
        uint32 measuredSeconds;
        uint32 belowMinSeconds;
        uint8 perfState;
        bool collateralSettled;
        uint256 collateral;
        uint256 collateralPaid;
        uint256 escrowHost;
        uint256 escrowFees;
    }

    /// Bases are µUSDG per unit, averaged over unused tokens so a nearly spent unit cannot lift a fresh one.
    struct Holding {
        uint64 hostBasis;
        uint64 costBasis;
        uint64 feeBasis;
        uint64 drawnPartial;
        uint64 unitsAtStart;
        uint64 listed;
        bool snapped;
    }

    struct Listing {
        uint256 id;
        address seller;
        uint64 units;
        uint64 pricePerUnit;
        uint64 hostBasis;
        uint64 costBasis;
        uint64 feeBasis;
    }

    uint256 internal constant UNIT_TOKENS = 1_000_000;
    uint256 internal constant FEE_BPS_DEFAULT = 400;
    uint256 internal constant FEE_BPS_MIN = 100;
    uint256 internal constant MAX_SHARE_BPS = 7_000;
    uint256 internal constant COLLATERAL_BPS = 2_000;
    uint256 internal constant CANCEL_REFUND_BPS = 9_500;
    uint256 internal constant EXPIRY_REFUND_BPS = 5_000;
    uint256 internal constant FAILURE_BELOW_BPS = 2_000;
    uint256 internal constant RESALE_FEE_BPS = 100;
    uint256 internal constant RESALE_MARKUP_BPS = 1_000;
    uint256 internal constant MAX_WINDOW_S = 168 hours;
    uint256 internal constant PERF_DISPUTE_S = 24 hours;
    uint256 internal constant CLAIM_FALLBACK_S = 30 days;
    uint256 internal constant MAX_LEAD_S = 365 days;
    uint256 internal constant MAX_EARLY_ACCESS_S = 7 days;
    uint8 internal constant PERF_NONE = 0;
    uint8 internal constant PERF_POSTED = 1;
    uint8 internal constant PERF_DISPUTED = 2;
    uint8 internal constant PERF_FINAL = 3;
    uint8 internal constant CLAIM_EXPIRED = 0;
    uint8 internal constant CLAIM_FAILURE = 1;

    /// The timelock from birth. Its only power is the early access period, so it never needs handing over.
    address public immutable owner;
    IERC20 public immutable usdg;
    IHostRegistry public immutable registry;
    IOfpkHooks public immutable hooks;
    address public immutable vault;
    address public immutable feeSplitter;
    uint256 public earlyAccessSeconds = 2 hours;
    uint256 public nextId = 1;
    uint256 public nextListingId = 1;

    mapping(uint256 => Window) internal _windows;
    mapping(uint256 => mapping(address => Holding)) internal _holdings;
    mapping(uint256 => Listing) public listings;
    /// Tokens rather than whole units, because a host below 400 tps reserves less than a unit an hour.
    mapping(address => mapping(uint64 => uint64)) public reservedTokensPerHour;
    /// Collateral a frozen host could not take. It collects it with `claimOwed` once it can.
    mapping(address => uint256) public owed;

    constructor(address owner_, IERC20 usdg_, IHostRegistry registry_, IOfpkHooks hooks_, address vault_, address feeSplitter_)
        ERC1155("")
        EIP712("OffpeakWindows", "1")
    {
        owner = owner_;
        usdg = usdg_;
        registry = registry_;
        hooks = hooks_;
        vault = vault_;
        feeSplitter = feeSplitter_;
    }

    function setEarlyAccessSeconds(uint256 seconds_) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (seconds_ > MAX_EARLY_ACCESS_S) revert BadTiming();
        earlyAccessSeconds = seconds_;
    }

    function create(WindowParams calldata w, uint256 collateral) external nonReentrant returns (uint256 id) {
        if (!registry.routable(msg.sender)) revert NotRoutable(msg.sender);
        uint32 maxTps = registry.maxTpsOf(msg.sender, w.modelDigest);
        if (maxTps == 0) revert NotRoutable(msg.sender);
        _checkParams(w);
        uint256 required = _ceilDiv(uint256(w.units) * w.startPricePerUnit * COLLATERAL_BPS, 10_000);
        if (collateral < required) revert CollateralTooLow(collateral, required);
        _reserve(msg.sender, w, maxTps);

        id = nextId++;
        Window storage window = _windows[id];
        window.host = msg.sender;
        window.modelDigest = w.modelDigest;
        window.t0 = w.t0;
        window.t1 = w.t1;
        window.minTps = w.minTps;
        window.units = w.units;
        window.startPrice = w.startPricePerUnit;
        window.endPrice = w.endPricePerUnit;
        window.auctionStart = w.auctionStart;
        window.auctionEnd = w.auctionEnd;
        window.collateral = collateral;
        emit WindowCreated(id, msg.sender, w.modelDigest, w.t0, w.t1, w.minTps, w.units);
        usdg.safeTransferFrom(msg.sender, address(this), collateral);
    }

    function priceNow(uint256 id) external view returns (uint256 hostPricePerUnit, uint256 buyerPricePerUnit) {
        Window storage w = _windows[id];
        hostPricePerUnit = _hostPrice(w);
        buyerPricePerUnit = hostPricePerUnit + _feePerUnit(hostPricePerUnit, msg.sender);
    }

    function buy(uint256 id, uint256 units, uint256 maxBuyerPricePerUnit) external nonReentrant {
        Window storage w = _known(id);
        if (block.timestamp < w.auctionStart || block.timestamp >= w.auctionEnd) revert AuctionClosed(id);
        if (block.timestamp < w.auctionStart + earlyAccessSeconds && _hooksOn() && !hooks.earlyAccess(msg.sender)) {
            revert EarlyAccessOnly(msg.sender);
        }
        if (units == 0) revert ZeroUnits();
        uint256 left = w.units - w.sold;
        if (units > left) revert InsufficientUnits(left, units);
        uint256 hostPrice = _hostPrice(w);
        uint256 fee = _feePerUnit(hostPrice, msg.sender);
        uint256 price = hostPrice + fee;
        if (price > maxBuyerPricePerUnit) revert PriceAboveMax(price, maxBuyerPricePerUnit);

        w.sold += uint64(units);
        w.escrowHost += units * hostPrice;
        w.escrowFees += units * fee;
        _merge(id, msg.sender, units, uint64(hostPrice), uint64(price), uint64(fee));
        emit WindowBought(id, msg.sender, units, hostPrice, units * fee);
        usdg.safeTransferFrom(msg.sender, address(this), units * price);
        _mint(msg.sender, id, units, "");
    }
