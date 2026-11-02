// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {MockSwapAdapter} from "../../src/mocks/MockSwapAdapter.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

/// @notice Feeds fees in and pays them out by every route. The ghosts recompute the split on their own, and each
/// `attack` action must be refused.
contract FeeSplitterHandler is VaultFixture {
    uint256 public ghostFed;
    uint256 public ghostDonated;
    uint256 public ghostOps;
    uint256 public ghostTreasury;
    uint256 public ghostRewards;
    uint256 public ghostBurnShare;
    uint256 public ghostRewardsPaid;
    uint256 public ghostBurned;
    bool public attackAccepted;
    uint256 public distributes;
    uint256 public rewardWeeks;
    uint256 public burns;
    uint256 internal _nextWeek = 1;
    MockSwapAdapter internal _adapter;
    address internal _keeper = makeAddr("burn-keeper");

    constructor() {
        VaultFixture.setUp();
        _adapter = new MockSwapAdapter(IERC20(address(usdg)), ofpk);
        vm.startPrank(owner);
        splitter.setSwapAdapter(address(_adapter));
        splitter.setBurnKeeper(_keeper);
        vm.stopPrank();
    }

    function setUp() public override {}

    function splitterAddress() external view returns (FeeSplitter) {
        return splitter;
    }

    function registryAddress() external view returns (HostRegistry) {
        return registry;
    }

    function usdgBalanceOf(address who) external view returns (uint256) {
        return usdg.balanceOf(who);
    }

    function ofpkBurned() external view returns (uint256) {
        return ofpk.balanceOf(splitter.BURN_ADDRESS());
    }

    function adapterAddress() external view returns (address) {
        return address(_adapter);
    }

    function adapterAllowance() external view returns (uint256) {
        return usdg.allowance(address(splitter), address(_adapter));
    }

    function opsAddress() external view returns (address) {
        return ops;
    }

    function treasuryAddress() external view returns (address) {
        return treasury;
    }

    function hostAddress(uint256 i) external view returns (address) {
        return i == 0 ? hostA : hostB;
    }

    function feed(uint256 amount, bool fromMarket) external {
        amount = bound(amount, 0, 10_000_000e6);
        usdg.mint(address(splitter), amount);
        vm.prank(fromMarket ? address(windows) : address(vault));
        splitter.notify(amount);
        ghostFed += amount;
    }

    /// USDG sent here without a `notify` is not a fee, so it must never join a bucket.
    function donate(uint256 amount) external {
        amount = bound(amount, 0, 1_000e6);
        usdg.mint(address(splitter), amount);
        ghostDonated += amount;
    }

    function distribute() external {
        uint256 amount = splitter.undistributed();
        bool on = splitter.tokenHooksEnabled();
        splitter.distribute();
        uint256 rewards = amount * 500 / 10_000;
        uint256 toBurn = on ? amount * 500 / 10_000 : 0;
        uint256 toTreasury = amount * (on ? 1_000 : 1_500) / 10_000;
        ghostRewards += rewards;
        ghostBurnShare += toBurn;
        ghostTreasury += toTreasury;
        ghostOps += amount - rewards - toBurn - toTreasury;
        distributes++;
    }

    function payRewards(uint256 amountA, uint256 amountB) external {
        uint256 bucket = splitter.hostRewardBucket();
        uint256 a = bound(amountA, 0, bucket);
        uint256 b = bound(amountB, 0, bucket - a);
        RewardBatch memory r = _rewards(_nextWeek, a, b);
        bytes memory sig = _sign(r);
        if (vault.settlesPaused()) {
            try splitter.distributeRewards(r, sig) {
                attackAccepted = true;
            } catch {}
            return;
        }
        splitter.distributeRewards(r, sig);
        _nextWeek++;
        ghostRewardsPaid += a + b;
        rewardWeeks++;
    }

    function burn() external {
        if (!splitter.tokenHooksEnabled()) return;
        uint256 amount = splitter.burnBucket();
        vm.prank(_keeper);
        splitter.executeBurn(amount);
        ghostBurned += amount;
        burns++;
    }

    function withdrawCredits(bool first, uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 0, 2 days));
        vm.prank(first ? hostA : hostB);
        registry.withdrawCredits();
    }

    function setHooks(bool enabled) external {
        vm.prank(owner);
        splitter.setTokenHooksEnabled(enabled);
    }

    function setSettlesPaused(bool paused) external {
        vm.prank(guardian);
        vault.setSettlesPaused(paused);
    }

    function attackNotify(address stranger, uint256 amount) external {
        if (stranger == address(vault) || stranger == address(windows)) return;
        vm.prank(stranger);
        try splitter.notify(amount) {
            attackAccepted = true;
        } catch {}
    }

    function attackPaidWeek(uint256 seed) external {
        if (_nextWeek == 1 || vault.settlesPaused()) return;
        RewardBatch memory r = _rewards(bound(seed, 1, _nextWeek - 1), 0, 0);
        bytes memory sig = _sign(r);
        try splitter.distributeRewards(r, sig) {
            attackAccepted = true;
        } catch {}
    }

    function attackOverdraw() external {
        if (vault.settlesPaused()) return;
        RewardBatch memory r = _rewards(_nextWeek, splitter.hostRewardBucket() + 1, 0);
        bytes memory sig = _sign(r);
        try splitter.distributeRewards(r, sig) {
            attackAccepted = true;
        } catch {}
    }

    function attackBurnWhileOff() external {
        if (splitter.tokenHooksEnabled()) return;
        vm.prank(_keeper);
        try splitter.executeBurn(0) {
            attackAccepted = true;
        } catch {}
    }

    function _rewards(uint256 week, uint256 amountA, uint256 amountB) private view returns (RewardBatch memory r) {
        r.week = uint64(week);
        r.credits = new Credit[](2);
        r.credits[0] = Credit({host: hostA, amount: uint128(amountA)});
        r.credits[1] = Credit({host: hostB, amount: uint128(amountB)});
    }

    function _sign(RewardBatch memory r) private view returns (bytes memory) {
        return _thresholdSig(_settlementDigest(Typehashes.hash(r)));
    }
}
