// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {ThresholdSig} from "../../src/lib/ThresholdSig.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {MockSwapAdapter} from "../../src/mocks/MockSwapAdapter.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

contract FeeSplitterTest is VaultFixture {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function _feed(uint256 amount) private {
        usdg.mint(address(splitter), amount);
        vm.prank(address(vault));
        splitter.notify(amount);
    }

    function _bucket(uint256 rewards) private {
        _feed(rewards * 20);
        splitter.distribute();
    }

    function _rewards(uint64 week, uint128 amountA, uint128 amountB) private view returns (RewardBatch memory r) {
        r.week = week;
        r.credits = new Credit[](2);
        r.credits[0] = Credit({host: hostA, amount: amountA});
        r.credits[1] = Credit({host: hostB, amount: amountB});
    }

    function _sign(RewardBatch memory r) private view returns (bytes memory) {
        return _thresholdSig(_settlementDigest(Typehashes.hash(r)));
    }

    function test_notifyIsVaultOrMarketOnly() public {
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NotFeeSource.selector, address(this)));
        splitter.notify(1);
        vm.prank(address(windows));
        splitter.notify(1);
        assertEq(splitter.undistributed(), 1);
    }

    function test_hooksOffSendsTheBurnShareToTheTreasury() public {
        _feed(1_000e6);
        vm.expectEmit(address(splitter));
        emit IFeeSplitter.FeesDistributed(800e6, 150e6, 50e6, 0);
        splitter.distribute();
        assertEq(usdg.balanceOf(ops), 800e6);
        assertEq(usdg.balanceOf(treasury), 150e6);
        assertEq(splitter.hostRewardBucket(), 50e6);
        assertEq(splitter.burnBucket(), 0);
        assertEq(usdg.balanceOf(address(splitter)), 50e6);
    }

    function test_hooksOnSplitsEightyTenFiveFive() public {
        vm.prank(owner);
        splitter.setTokenHooksEnabled(true);
        _feed(1_000e6);
        splitter.distribute();
        assertEq(usdg.balanceOf(ops), 800e6);
        assertEq(usdg.balanceOf(treasury), 100e6);
        assertEq(splitter.hostRewardBucket(), 50e6);
        assertEq(splitter.burnBucket(), 50e6);
    }

    function test_roundingDustGoesToOps() public {
        _feed(19);
        splitter.distribute();
        assertEq(usdg.balanceOf(treasury), 2);
        assertEq(splitter.hostRewardBucket(), 0);
        assertEq(usdg.balanceOf(ops), 17);
    }

    function test_distributeTwicePaysOnce() public {
        _feed(1_000e6);
        splitter.distribute();
        splitter.distribute();
        assertEq(usdg.balanceOf(ops), 800e6);
    }

    function test_settledFeesReachTheSplitter() public {
        address buyer = address(0x1000);
        _fundWithCaps(buyer, 50e6, 10e6);
        uint64 next = _nextHour();
        (SettleBatch memory b, RootTotals memory t) =
            _batch(next, _oneDebit(buyer, 10e6, uint64(uint256(next) * 3600)), 9e6);
        _settle(b, t);
        assertEq(splitter.undistributed(), 1e6);
        assertEq(usdg.balanceOf(address(splitter)), 1e6);
    }

    function test_rewardsPayThroughTheRegistryAfterTheCreditDelay() public {
        _bucket(10e6);
        RewardBatch memory r = _rewards(2811, 6e6, 4e6);
        vm.expectEmit(address(splitter));
        emit IFeeSplitter.RewardsDistributed(2811, 10e6);
        splitter.distributeRewards(r, _sign(r));
        assertEq(splitter.hostRewardBucket(), 0);
        assertEq(registry.hostView(hostA).pendingCredits, 6e6);

        vm.warp(block.timestamp + 24 hours);
        vm.prank(hostB);
        registry.withdrawCredits();
        assertEq(usdg.balanceOf(hostB), 4e6);
    }

    function test_rewardWeekPaysOnce() public {
        _bucket(10e6);
        RewardBatch memory r = _rewards(2811, 1e6, 1e6);
        bytes memory sig = _sign(r);
        splitter.distributeRewards(r, sig);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.RewardWeekPaid.selector, uint64(2811)));
        splitter.distributeRewards(r, sig);
    }
