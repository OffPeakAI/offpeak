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

    function draw(uint256 seed, uint256 actorSeed, uint64 tokens) external {
        (uint256 id, WindowMarket.Window memory w, bool found) = _pick(seed);
        if (!found || block.timestamp < w.t0 || block.timestamp >= w.t1) return;
        address actor = _actor(actorSeed);
        if (windows.balanceOf(actor, id) == 0) return;
        _draw(id, actor, uint64(bound(tokens, 1, 3_000_000)));
        draws++;
    }

    function wait(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 2 hours));
    }

    function enterWindow(uint256 seed) external {
        (, WindowMarket.Window memory w, bool found) = _pick(seed);
        if (found && block.timestamp < w.t0) vm.warp(w.t0);
    }

    /// Walks one window through a whole life, because random steps rarely reach the hard paths.
    function cycle(uint256 seed, uint64 tokens, uint64 price, bool failing) external {
        if (ids.length - finishedCount >= 4) return;
        seed %= 1_000_000;
        WindowParams memory p = _lifeParams(uint64((block.timestamp / 3600 + 4) * 3600), seed);
        vm.prank(host);
        uint256 id = windows.create(p, uint256(p.units) * p.startPricePerUnit);
        ids.push(id);
        _sell(id, seed, bound(price, 1, 3_000_000));
        vm.warp(p.t0);
        _use(id, _actor(seed + 1), _actor(seed + 2), tokens);
        _finish(id, failing, false);
    }

    function _sell(uint256 id, uint256 seed, uint256 price) private {
        address a = _actor(seed);
        address b = _actor(seed + 1);
        address c = _actor(seed + 2);
        _buy(a, id, 3);
        vm.warp(block.timestamp + bound(seed % 3 hours, 60, 3 hours));
        _buy(b, id, 3);
        _buy(c, id, 2);
        buys += 3;
        vm.prank(c);
        windows.cancel(id, 1);
        cancels++;
        vm.prank(a);
        uint256 sold = windows.list(id, 2, price);
        openListings.push(sold);
        vm.prank(b);
        windows.buyListing(sold, 1, price);
        resales++;
    }

    function _use(uint256 id, address b, address c, uint64 tokens) private {
        _draw(id, b, uint64(bound(tokens, 1, 2_500_000)));
        _draw(id, c, uint64(bound(tokens / 2, 1, 1_500_000)));
        draws += 2;
    }

    function _lifeParams(uint64 first, uint256 seed) private view returns (WindowParams memory) {
        uint64 start = uint64(bound(seed % 2_000_000, 100_000, 2_000_000));
        return WindowParams({
            modelDigest: MODEL,
            t0: first,
            t1: first + 4 hours,
            minTps: 100,
            units: 12,
            startPricePerUnit: start,
            endPricePerUnit: start / 3 + 1,
            auctionStart: uint64(block.timestamp),
            auctionEnd: first
        });
    }

    /// Rarely called directly, so that windows stay open long enough for the other actions to reach them.
    function finish(uint256 seed, bool failing, bool neverPosted) external {
        if (seed % 8 != 0) return;
        (uint256 id,, bool found) = _pick(seed);
        if (found) _finish(id, failing, neverPosted);
    }

    /// Closes one window out: posts, clears listings, lets everyone claim, then records what stayed.
    function _finish(uint256 id, bool failing, bool neverPosted) private {
        WindowMarket.Window memory w = windows.windowState(id);
        if (block.timestamp < w.t1) vm.warp(w.t1);
        _settleEmptyThrough(uint64(w.t1 / 3600) - 1);
        _giftAfterSettling(id);
        if (neverPosted) {
            if (block.timestamp < uint256(w.t1) + 30 days) vm.warp(uint256(w.t1) + 30 days);
        } else {
            if (block.timestamp >= uint256(w.t1) + 30 days) return;
            _post(id, 3600, failing ? 3600 : 0);
            vm.warp(block.timestamp + 24 hours);
        }
        _clearListings(id);
        bool failed = windows.windowView(id).failed;
        for (uint256 i; i < ACTORS; ++i) {
            vm.prank(actors[i]);
            if (failed) windows.claimFailure(id);
            else windows.claimExpired(id);
        }
        if (!failed) {
            vm.prank(host);
            windows.claimExpired(id);
        }
        WindowMarket.Window memory end = windows.windowState(id);
        leftBehind += end.escrowHost + end.escrowFees + (end.collateralSettled ? 0 : end.collateral);
        finished[id] = true;
        finishedCount++;
        if (failed) failedCount++;
    }

    /// Once a Window's hours settle, units may move again, except a partly used one.
    function _giftAfterSettling(uint256 id) private {
        for (uint256 i; i < ACTORS; ++i) {
            address from = actors[i];
            uint256 movable = _movable(id, from);
            if (movable == 0) continue;
            vm.prank(from);
            windows.safeTransferFrom(from, actors[(i + 1) % ACTORS], id, 1, "");
            gifts++;
            return;
        }
    }

    function _clearListings(uint256 id) private {
        for (uint256 i; i < openListings.length; ++i) {
            (uint256 listed, address seller, uint64 left,,,,) = windows.listings(openListings[i]);
            if (listed != id || left == 0) continue;
            vm.prank(seller);
            windows.delist(openListings[i]);
        }
    }

    function _movable(uint256 id, address who) private view returns (uint256) {
        uint256 balance = windows.balanceOf(who, id);
        WindowMarket.Window memory w = windows.windowState(id);
        bool hoursSettled = vault.lastSettledHour() + 1 >= w.t1 / 3600;
        if (balance == 0 || (block.timestamp >= w.t0 && !hoursSettled)) return 0;
        return windows.holdingState(id, who).drawnPartial > 0 ? balance - 1 : balance;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % ACTORS];
    }

    function _listing(uint256 seed) private view returns (uint256, bool) {
        if (openListings.length == 0) return (0, false);
        return (openListings[seed % openListings.length], true);
    }

    function _pick(uint256 seed) private view returns (uint256 id, WindowMarket.Window memory w, bool found) {
        if (ids.length == 0) return (0, w, false);
        uint256 start = seed % ids.length;
        for (uint256 i; i < ids.length; ++i) {
            id = ids[(start + i) % ids.length];
            if (!finished[id]) return (id, windows.windowState(id), true);
        }
        return (0, w, false);
    }
}
