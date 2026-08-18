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

    function cancel(uint256 id, uint256 units) external nonReentrant {
        Window storage w = _known(id);
        if (block.timestamp >= w.t0) revert WindowStarted(id);
        if (units == 0) revert ZeroUnits();
        Holding storage h = _holdings[id][msg.sender];
        uint256 hostValue = units * h.hostBasis;
        uint256 feeValue = units * h.feeBasis;
        uint256 toHolder = hostValue * CANCEL_REFUND_BPS / 10_000;
        uint256 toHost = hostValue - toHolder;
        w.sold -= uint64(units);
        w.escrowHost -= hostValue;
        w.escrowFees -= feeValue;
        _burn(msg.sender, id, units);
        emit WindowCancelled(id, msg.sender, units, toHolder + feeValue);
        _creditHost(w.host, toHost);
        usdg.safeTransfer(msg.sender, toHolder + feeValue);
    }

    function list(uint256 id, uint256 units, uint256 pricePerUnit) external nonReentrant returns (uint256 listingId) {
        Window storage w = _known(id);
        if (block.timestamp >= w.t1) revert WindowEnded(id);
        if (units == 0) revert ZeroUnits();
        if (pricePerUnit > type(uint64).max) revert PriceAboveMax(pricePerUnit, type(uint64).max);
        _move(msg.sender, address(this), id, units);
        Holding storage h = _holdings[id][msg.sender];
        h.listed += uint64(units);
        listingId = nextListingId++;
        listings[listingId] = Listing({
            id: id,
            seller: msg.sender,
            units: uint64(units),
            pricePerUnit: uint64(pricePerUnit),
            hostBasis: h.hostBasis,
            costBasis: h.costBasis,
            feeBasis: h.feeBasis
        });
        emit Listed(listingId, id, msg.sender, units, pricePerUnit);
    }

    function delist(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.seller != msg.sender) revert NotSeller(msg.sender);
        uint256 units = l.units;
        if (units == 0) revert ListingClosed(listingId);
        uint256 id = l.id;
        _snapshot(id, msg.sender);
        _holdings[id][msg.sender].listed -= uint64(units);
        _merge(id, msg.sender, units, l.hostBasis, l.costBasis, l.feeBasis);
        l.units = 0;
        emit Delisted(listingId);
        _move(address(this), msg.sender, id, units);
    }

    function buyListing(uint256 listingId, uint256 units, uint256 maxPricePerUnit) external nonReentrant {
        Listing storage l = listings[listingId];
        if (units == 0) revert ZeroUnits();
        if (l.units == 0) revert ListingClosed(listingId);
        if (units > l.units) revert InsufficientUnits(l.units, units);
        uint256 id = l.id;
        if (block.timestamp >= _windows[id].t1) revert WindowEnded(id);
        uint256 price = l.pricePerUnit;
        if (price > maxPricePerUnit) revert PriceAboveMax(price, maxPricePerUnit);

        address seller = l.seller;
        uint256 sale = units * price;
        uint256 markup = price > l.costBasis ? (price - l.costBasis) * units : 0;
        uint256 fee = sale * RESALE_FEE_BPS / 10_000 + markup * RESALE_MARKUP_BPS / 10_000;
        _snapshot(id, seller);
        _snapshot(id, msg.sender);
        _holdings[id][seller].listed -= uint64(units);
        l.units -= uint64(units);
        _merge(id, msg.sender, units, l.hostBasis, uint64(price), l.feeBasis);
        emit ListingFilled(listingId, msg.sender, units, fee);
        usdg.safeTransferFrom(msg.sender, address(this), sale);
        _sendFees(fee);
        usdg.safeTransfer(seller, sale - fee);
        _move(address(this), msg.sender, id, units);
    }

    /// Half the host's price returns for unused tokens, the rest pays the host for holding the capacity.
    function claimExpired(uint256 id) external nonReentrant {
        Window storage w = _known(id);
        if (!_claimable(w) || _failed(w)) revert NotClaimable(id);
        Holding storage h = _holdings[id][msg.sender];
        if (h.listed > 0) revert StillListed(id, h.listed);
        uint256 balance = balanceOf(msg.sender, id);
        uint256 refund;
        uint256 toHost;
        if (balance > 0) {
            (uint256 hostValue, uint256 feeValue) = _unusedValue(w, h, balance);
            uint256 hostRefund = hostValue * EXPIRY_REFUND_BPS / 10_000;
            toHost = hostValue - hostRefund;
            refund = hostRefund + feeValue;
            w.escrowHost -= hostValue;
            w.escrowFees -= feeValue;
            h.drawnPartial = 0;
            _burn(msg.sender, id, balance);
        }
        emit Claimed(id, msg.sender, CLAIM_EXPIRED, refund);
        if (toHost > 0) _creditHost(w.host, toHost);
        _closeOut(w);
        if (refund > 0) usdg.safeTransfer(msg.sender, refund);
    }

    /// Refunds what was paid for undrawn tokens, plus a share of all the collateral by units held at the start.
    function claimFailure(uint256 id) external nonReentrant {
        Window storage w = _known(id);
        if (!_claimable(w) || !_failed(w)) revert NotClaimable(id);
        Holding storage h = _holdings[id][msg.sender];
        if (h.listed > 0) revert StillListed(id, h.listed);
        _snapshot(id, msg.sender);
        uint256 balance = balanceOf(msg.sender, id);
        (uint256 hostValue, uint256 feeValue) = _unusedValue(w, h, balance);
        uint256 share = w.collateral * h.unitsAtStart / w.sold;
        w.collateralPaid += share;
        w.sharedUnits += h.unitsAtStart;
        h.unitsAtStart = 0;
        w.escrowHost -= hostValue;
        w.escrowFees -= feeValue;
        h.drawnPartial = 0;
        if (balance > 0) _burn(msg.sender, id, balance);
        uint256 refund = hostValue + feeValue + share;
        emit Claimed(id, msg.sender, CLAIM_FAILURE, refund);
        _closeOut(w);
        if (refund > 0) usdg.safeTransfer(msg.sender, refund);
    }

    /// Inside settle, so nothing here may revert: a draw the holder cannot cover shrinks to what they hold,
    /// and settlement checks balances first, so that path only guards against a stalled hour.
    function applyDraws(uint64 hour, WindowDraw[] calldata draws) external nonReentrant {
        if (msg.sender != vault) revert NotVault(msg.sender);
        Credit[] memory credits = new Credit[](draws.length);
        uint256 hosts;
        uint256 fees;
        uint256 paid;
        for (uint256 i; i < draws.length; ++i) {
            (uint64 tokens, uint256 units, uint256 hostShare, uint256 feeShare) = _draw(draws[i], hour);
            emit Drawn(draws[i].windowId, draws[i].holder, tokens, units);
            if (tokens == 0) continue;
            fees += feeShare;
            paid += hostShare;
            hosts = _addCredit(credits, hosts, _windows[draws[i].windowId].host, hostShare);
        }
        assembly ("memory-safe") {
            mstore(credits, hosts)
        }
        if (paid > 0) {
            usdg.safeTransfer(address(registry), paid);
            registry.accrueCredits(hour, credits);
        }
        _sendFees(fees);
    }

    function postPerformance(WindowPerformance calldata p, bytes calldata thresholdSig) external nonReentrant {
        Window storage w = _known(p.windowId);
        if (block.timestamp < w.t1) revert WindowNotEnded(p.windowId);
        if (w.perfState != PERF_NONE && w.perfState != PERF_DISPUTED) revert PerformanceClosed(p.windowId);
        // Past the fallback claims have opened on what was posted, so a late post could pay collateral twice.
        if (block.timestamp >= uint256(w.t1) + CLAIM_FALLBACK_S) revert PerformanceClosed(p.windowId);
        if (IOffpeakVault(vault).settlesPaused()) revert SettlesPaused();
        address[3] memory settlers = _settlers();
        ThresholdSig.verify2of3(settlers, _hashTypedDataV4(Typehashes.hash(p)), thresholdSig);
        bool repost = w.perfState == PERF_DISPUTED;
        // The first post's signatures are still valid, so only a settler may answer a dispute with them.
        if (repost && msg.sender != settlers[0] && msg.sender != settlers[1] && msg.sender != settlers[2]) {
            revert PerformanceClosed(p.windowId);
        }
        w.measuredSeconds = p.measuredSeconds;
        w.belowMinSeconds = p.belowMinSeconds;
        w.perfState = repost ? PERF_FINAL : PERF_POSTED;
        w.perfFinalAt = uint64(repost ? block.timestamp : block.timestamp + PERF_DISPUTE_S);
        emit PerformancePosted(p.windowId, p.measuredSeconds, p.belowMinSeconds, _failed(w), w.perfFinalAt);
    }

    function disputePerformance(uint256 id) external {
        Window storage w = _known(id);
        if (msg.sender != w.host) revert NotHost(msg.sender);
        if (w.perfState != PERF_POSTED || block.timestamp >= w.perfFinalAt) revert PerformanceClosed(id);
        w.perfState = PERF_DISPUTED;
        emit PerformanceDisputed(id);
    }

    function windowView(uint256 id) external view returns (WindowView memory view_) {
        Window storage w = _windows[id];
        uint256 hostPrice = _hostPrice(w);
        view_ = WindowView({
            id: id,
            host: w.host,
            modelDigest: w.modelDigest,
            t0: w.t0,
            t1: w.t1,
            minTps: w.minTps,
            units: w.units,
            hostPricePerUnit: hostPrice,
            buyerPricePerUnit: hostPrice + _feePerUnit(hostPrice, msg.sender),
            failed: _failed(w)
        });
    }

    function holderView(uint256 id, address holder) external view returns (HolderView memory view_) {
        Holding storage h = _holdings[id][holder];
        view_ = HolderView({
            balance: balanceOf(holder, id),
            lockedPartial: h.drawnPartial > 0 ? 1 : 0,
            drawnTokens: h.drawnPartial,
            costBasis: h.costBasis
        });
    }

    function claimOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
    }

    function _known(uint256 id) private view returns (Window storage w) {
        w = _windows[id];
        if (w.host == address(0)) revert UnknownWindow(id);
    }

    function _checkParams(WindowParams calldata w) private view {
        if (w.units == 0 || w.minTps == 0) revert ZeroUnits();
        if (w.t0 % 3600 != 0 || w.t1 % 3600 != 0 || w.t1 <= w.t0 || w.t0 <= block.timestamp) revert BadTiming();
        if (w.t1 > block.timestamp + MAX_LEAD_S) revert BadTiming();
        if (w.t1 - w.t0 > MAX_WINDOW_S) revert WindowTooLong();
        if (w.auctionStart >= w.auctionEnd || w.auctionEnd > w.t0) revert BadTiming();
        if (w.startPricePerUnit < w.endPricePerUnit || w.endPricePerUnit == 0) revert BadTiming();
    }

    /// Hosts keep at least 30% of every hour out of Windows.
    function _reserve(address host, WindowParams calldata w, uint32 maxTps) private {
        uint256 hours_ = (w.t1 - w.t0) / 3600;
        uint256 perHour = _ceilDiv(uint256(w.units) * UNIT_TOKENS, hours_);
        uint256 limit = uint256(maxTps) * 3600 * MAX_SHARE_BPS / 10_000;
        uint64 first = HourMath.hourOf(w.t0);
        for (uint64 i; i < hours_; ++i) {
            uint64 hour = first + i;
            uint256 reserved = reservedTokensPerHour[host][hour] + perHour;
            if (reserved > limit) revert MarketShareExceeded(hour);
            reservedTokensPerHour[host][hour] = uint64(reserved);
        }
    }

    function _hostPrice(Window storage w) private view returns (uint256) {
        uint256 start = w.auctionStart;
        uint256 end = w.auctionEnd;
        if (block.timestamp <= start) return w.startPrice;
        if (block.timestamp >= end) return w.endPrice;
        uint256 drop = w.startPrice - w.endPrice;
        return w.startPrice - drop * (block.timestamp - start) / (end - start);
    }

    function _feePerUnit(uint256 hostPrice, address buyer) private view returns (uint256) {
        uint256 discount = _hooksOn() ? hooks.feeDiscountBps(buyer) : 0;
        uint256 feeBps = FEE_BPS_DEFAULT > discount + FEE_BPS_MIN ? FEE_BPS_DEFAULT - discount : FEE_BPS_MIN;
        return _ceilDiv(hostPrice * feeBps, 10_000);
    }

    function _hooksOn() private view returns (bool) {
        return IFeeSplitter(feeSplitter).tokenHooksEnabled();
    }

    function _failed(Window storage w) private view returns (bool) {
        if (w.sold == 0) return false;
        return uint256(w.belowMinSeconds) * 10_000 > FAILURE_BELOW_BPS * uint256(w.measuredSeconds);
    }

    function _hoursSettled(Window storage w) private view returns (bool) {
        return IOffpeakVault(vault).lastSettledHour() + 1 >= HourMath.hourOf(w.t1);
    }

    /// Claims can never wait on a person forever: past the fallback they open on whatever was posted.
    function _claimable(Window storage w) private view returns (bool) {
        if (block.timestamp >= uint256(w.t1) + CLAIM_FALLBACK_S) return true;
        if (!_hoursSettled(w)) return false;
        if (w.perfState == PERF_FINAL) return true;
        if (w.perfState == PERF_POSTED) return block.timestamp >= w.perfFinalAt;
        return w.sold == 0 && block.timestamp >= w.t1;
    }

    function _unusedValue(Window storage w, Holding storage h, uint256 balance)
        private
        view
        returns (uint256 hostValue, uint256 feeValue)
    {
        uint256 unused = balance * UNIT_TOKENS - h.drawnPartial;
        hostValue = _min(unused * h.hostBasis / UNIT_TOKENS, w.escrowHost);
        feeValue = _min(unused * h.feeBasis / UNIT_TOKENS, w.escrowFees);
    }

    function _draw(WindowDraw calldata d, uint64 hour)
        private
        returns (uint64 tokens, uint256 units, uint256 hostShare, uint256 feeShare)
    {
        Window storage w = _windows[d.windowId];
        if (hour < HourMath.hourOf(w.t0) || hour >= HourMath.hourOf(w.t1)) return (0, 0, 0, 0);
        Holding storage h = _holdings[d.windowId][d.holder];
        uint256 total = balanceOf(d.holder, d.windowId) * UNIT_TOKENS;
        if (total <= h.drawnPartial) return (0, 0, 0, 0);
        tokens = uint64(_min(d.tokens, total - h.drawnPartial));
        if (tokens == 0) return (0, 0, 0, 0);
        _snapshot(d.windowId, d.holder);
        hostShare = _min(uint256(tokens) * h.hostBasis / UNIT_TOKENS, w.escrowHost);
        feeShare = _min(uint256(tokens) * h.feeBasis / UNIT_TOKENS, w.escrowFees);
        w.escrowHost -= hostShare;
        w.escrowFees -= feeShare;
        uint256 drawn = uint256(h.drawnPartial) + tokens;
        units = drawn / UNIT_TOKENS;
        h.drawnPartial = uint64(drawn % UNIT_TOKENS);
        if (units > 0) _burn(d.holder, d.windowId, units);
    }

    function _addCredit(Credit[] memory credits, uint256 hosts, address host, uint256 amount) private pure returns (uint256) {
        for (uint256 i; i < hosts; ++i) {
            if (credits[i].host == host) {
                credits[i].amount += uint128(amount);
                return hosts;
            }
        }
        credits[hosts] = Credit({host: host, amount: uint128(amount)});
        return hosts + 1;
    }

    function _creditHost(address host, uint256 amount) private {
        if (amount == 0) return;
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({host: host, amount: uint128(amount)});
        usdg.safeTransfer(address(registry), amount);
        registry.accrueCredits(HourMath.hourOf(uint64(block.timestamp)), credits);
    }

    function _sendFees(uint256 amount) private {
        if (amount == 0) return;
        usdg.safeTransfer(feeSplitter, amount);
        IFeeSplitter(feeSplitter).notify(amount);
    }

    /// Once nothing is left to claim, collateral and rounding dust leave. Past the fallback, a good window's
    /// collateral leaves anyway, so a holder who never claims cannot trap it.
    function _closeOut(Window storage w) private {
        bool failed = _failed(w);
        bool finished = w.live == 0 && (!failed || w.sharedUnits == w.sold);
        if (!failed && !w.collateralSettled && (finished || block.timestamp >= uint256(w.t1) + CLAIM_FALLBACK_S)) {
            w.collateralSettled = true;
            if (!usdg.trySafeTransfer(w.host, w.collateral)) owed[w.host] += w.collateral;
        }
        if (!finished) return;
        uint256 dustHost = w.escrowHost;
        uint256 dustFees = w.escrowFees;
        w.escrowHost = 0;
        w.escrowFees = 0;
        if (failed && !w.collateralSettled) {
            w.collateralSettled = true;
            dustFees += w.collateral - w.collateralPaid;
        }
        _creditHost(w.host, dustHost);
        _sendFees(dustFees);
    }

    function _snapshot(uint256 id, address who) private {
        Holding storage h = _holdings[id][who];
        if (h.snapped || block.timestamp < _windows[id].t0) return;
        h.snapped = true;
        h.unitsAtStart = uint64(balanceOf(who, id)) + h.listed;
    }

    /// Weighted over unused tokens. Call it before the new units reach the balance.
    function _merge(uint256 id, address who, uint256 units, uint64 hostBasis, uint64 costBasis, uint64 feeBasis) private {
        Holding storage h = _holdings[id][who];
        uint256 held = balanceOf(who, id) * UNIT_TOKENS - h.drawnPartial;
        uint256 incoming = units * UNIT_TOKENS;
        uint256 total = held + incoming;
        h.hostBasis = uint64((held * h.hostBasis + incoming * hostBasis) / total);
        h.costBasis = uint64((held * h.costBasis + incoming * costBasis) / total);
        h.feeBasis = uint64((held * h.feeBasis + incoming * feeBasis) / total);
    }

    /// Market escrow moves go straight through `_update`, so the market needs no receiver hook and refuses stray transfers.
    function _move(address from, address to, uint256 id, uint256 units) private {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        ids[0] = id;
        values[0] = units;
        _update(from, to, ids, values);
    }

    /// Batches are off: the same id twice in one would slip past every per-transfer check below.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (ids.length != 1) revert BatchTransfersOff();
        _beforeMove(from, to, ids[0], values[0]);
        super._update(from, to, ids, values);
    }

    function _beforeMove(address from, address to, uint256 id, uint256 units) private {
        Window storage w = _windows[id];
        if (from == address(0)) {
            w.live += uint64(units);
            return;
        }
        if (to == address(0)) {
            _snapshot(id, from);
            w.live -= uint64(units);
            return;
        }
        if (from == address(this)) return;
        // Tokens used this hour settle later, so a holder must not move the units that will pay for them.
        if (block.timestamp >= w.t0 && !_hoursSettled(w)) revert UnitsLocked(id);
        Holding storage sender = _holdings[id][from];
        uint256 balance = balanceOf(from, id);
        if (sender.drawnPartial > 0 && units >= balance) revert InsufficientUnits(balance - 1, units);
        _snapshot(id, from);
        if (to == address(this)) return;
        _snapshot(id, to);
        _merge(id, to, units, sender.hostBasis, sender.costBasis, sender.feeBasis);
    }

    function _settlers() private view returns (address[3] memory set) {
        for (uint256 i; i < 3; ++i) {
            set[i] = IOffpeakVault(vault).settlers(i);
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
