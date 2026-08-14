// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WindowMarket} from "../../src/WindowMarket.sol";
import {WindowMarketHarness} from "../helpers/WindowMarketHarness.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";
import {WindowFixture} from "../helpers/WindowFixture.sol";

/// @notice Runs whole Window lives across buy, cancel, resale, gifts, draws and every kind of claim.
/// `finish` closes a window out and records anything left behind, which is how conservation is proved.
contract WindowHandler is WindowFixture {
    uint256 internal constant ACTORS = 4;
    address[ACTORS] public actors = [address(0x1100), address(0x2200), address(0x3300), address(0x4400)];

    uint256[] public ids;
    uint256[] public openListings;
    mapping(uint256 => bool) public finished;
    uint256 public leftBehind;
    uint256 public finishedCount;
    uint256 public failedCount;
    uint256 public buys;
    uint256 public cancels;
    uint256 public resales;
    uint256 public draws;
    uint256 public gifts;

    constructor() {
        VaultFixture.setUp();
        _setUpWindows();
        vm.prank(host);
        registry.topUpBond(0, 0);
        for (uint256 i; i < ACTORS; ++i) {
            _fundWindowBuyer(actors[i]);
        }
    }

    function setUp() public override {}

    function marketAddress() external view returns (WindowMarketHarness) {
        return windows;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function marketBalance() external view returns (uint256) {
        return usdg.balanceOf(address(windows));
    }

    function spawn(uint64 unitsSeed, uint64 startSeed, uint64 endSeed, uint8 hoursSeed) external {
        if (ids.length - finishedCount >= 4) return;
        uint64 start = uint64(bound(startSeed, 100_000, 2_000_000));
        uint64 end = uint64(bound(endSeed, 10_000, start));
        uint64 first = uint64((block.timestamp / 3600 + 4) * 3600);
        uint64 last = first + uint64(bound(hoursSeed, 1, 12)) * 3600;
        WindowParams memory p = WindowParams({
            modelDigest: MODEL,
            t0: first,
            t1: last,
            minTps: 100,
            units: uint64(bound(unitsSeed, 4, 20)),
            startPricePerUnit: start,
            endPricePerUnit: end,
            auctionStart: uint64(block.timestamp),
            auctionEnd: first
        });
        uint256 collateral = uint256(p.units) * start;
        vm.prank(host);
        ids.push(windows.create(p, collateral));
    }

    function buy(uint256 seed, uint256 actorSeed, uint256 units) external {
        (uint256 id, WindowMarket.Window memory w, bool found) = _pick(seed);
        if (!found || block.timestamp >= w.auctionEnd || block.timestamp < w.auctionStart || w.sold == w.units) return;
        _buy(_actor(actorSeed), id, bound(units, 1, w.units - w.sold));
        buys++;
    }

    function cancel(uint256 seed, uint256 actorSeed, uint256 units) external {
        (uint256 id, WindowMarket.Window memory w, bool found) = _pick(seed);
        address actor = _actor(actorSeed);
        uint256 balance = windows.balanceOf(actor, id);
        if (!found || block.timestamp >= w.t0 || balance == 0) return;
        vm.prank(actor);
        windows.cancel(id, bound(units, 1, balance));
        cancels++;
    }

    function list(uint256 seed, uint256 actorSeed, uint256 units, uint64 price) external {
        (uint256 id, WindowMarket.Window memory w, bool found) = _pick(seed);
        address actor = _actor(actorSeed);
        uint256 movable = _movable(id, actor);
        if (!found || block.timestamp >= w.t1 || movable == 0) return;
        vm.prank(actor);
        openListings.push(windows.list(id, bound(units, 1, movable), bound(price, 1, 3_000_000)));
    }

    function buyListing(uint256 listingSeed, uint256 actorSeed, uint256 units) external {
        (uint256 listingId, bool found) = _listing(listingSeed);
        if (!found) return;
        (uint256 id,, uint64 left, uint64 price,,,) = windows.listings(listingId);
        if (left == 0 || block.timestamp >= windows.windowState(id).t1) return;
        vm.prank(_actor(actorSeed));
        windows.buyListing(listingId, bound(units, 1, left), price);
        resales++;
    }

    function delist(uint256 listingSeed) external {
        (uint256 listingId, bool found) = _listing(listingSeed);
        if (!found) return;
        (,address seller, uint64 left,,,,) = windows.listings(listingId);
        if (left == 0) return;
        vm.prank(seller);
        windows.delist(listingId);
    }

    function gift(uint256 seed, uint256 fromSeed, uint256 toSeed, uint256 units) external {
        (uint256 id,, bool found) = _pick(seed);
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 movable = _movable(id, from);
        if (!found || from == to || movable == 0) return;
        vm.prank(from);
        windows.safeTransferFrom(from, to, id, bound(units, 1, movable), "");
        gifts++;
    }
