// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./OffpeakTypes.sol";

interface IWindowMarket {
    event WindowCreated(
        uint256 indexed id, address indexed host, bytes32 modelDigest, uint64 t0, uint64 t1, uint32 minTps, uint64 units
    );
    event WindowBought(uint256 indexed id, address indexed buyer, uint256 units, uint256 hostPricePerUnit, uint256 fee);
    event WindowCancelled(uint256 indexed id, address indexed holder, uint256 units, uint256 refund);
    event Listed(
        uint256 indexed listingId, uint256 indexed id, address indexed seller, uint256 units, uint256 pricePerUnit
    );
    event ListingFilled(uint256 indexed listingId, address indexed buyer, uint256 units, uint256 fee);
    event Delisted(uint256 indexed listingId);
    event Drawn(uint256 indexed id, address indexed holder, uint64 tokens, uint256 unitsBurned);
    event PerformancePosted(uint256 indexed id, uint32 measuredSeconds, uint32 belowMinSeconds, bool failed, uint64 finalAt);
    event PerformanceDisputed(uint256 indexed id);
    event Claimed(uint256 indexed id, address indexed holder, uint8 kind, uint256 amount);

    function create(WindowParams calldata w, uint256 collateral) external returns (uint256 id);
    function priceNow(uint256 id) external view returns (uint256 hostPricePerUnit, uint256 buyerPricePerUnit);
    function buy(uint256 id, uint256 units, uint256 maxBuyerPricePerUnit) external;
    function cancel(uint256 id, uint256 units) external;
    function list(uint256 id, uint256 units, uint256 pricePerUnit) external returns (uint256 listingId);
    function delist(uint256 listingId) external;
    function buyListing(uint256 listingId, uint256 units, uint256 maxPricePerUnit) external;
    function claimExpired(uint256 id) external;
    function claimFailure(uint256 id) external;
    function applyDraws(uint64 hour, WindowDraw[] calldata draws) external;
    function postPerformance(WindowPerformance calldata p, bytes calldata thresholdSig) external;
    function disputePerformance(uint256 id) external;
    function windowView(uint256 id) external view returns (WindowView memory);
    function holderView(uint256 id, address holder) external view returns (HolderView memory);
}
