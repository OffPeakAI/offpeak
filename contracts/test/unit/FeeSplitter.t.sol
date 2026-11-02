// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {IFeeSplitter} from "../../src/interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
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

    function test_rewardsCannotExceedTheBucket() public {
        _bucket(1e6);
        RewardBatch memory r = _rewards(1, 1e6, 1);
        bytes memory sig = _sign(r);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.InsufficientRewardBucket.selector, 1e6, 1e6 + 1));
        splitter.distributeRewards(r, sig);
    }

    function test_rewardsNeedTwoSettlers() public {
        _bucket(1e6);
        RewardBatch memory r = _rewards(1, 1, 1);
        bytes memory one = _sig(settlerKeys[0], _settlementDigest(Typehashes.hash(r)));
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        splitter.distributeRewards(r, one);
    }

    function test_rewardsFollowRotatedSigners() public {
        _bucket(1e6);
        RewardBatch memory r = _rewards(1, 1, 1);
        bytes memory sig = _sign(r);
        vm.prank(owner);
        vault.setSettlers([address(0x11), address(0x22), address(0x33)]);
        vm.expectRevert(ThresholdSig.BadThresholdSig.selector);
        splitter.distributeRewards(r, sig);
    }

    function test_rewardsRequireSortedHosts() public {
        _bucket(1e6);
        RewardBatch memory r = _rewards(1, 1, 1);
        r.credits[0].host = hostB;
        r.credits[1].host = hostA;
        bytes memory sig = _sign(r);
        vm.expectRevert(FeeSplitter.NotSorted.selector);
        splitter.distributeRewards(r, sig);
    }

    function test_rewardsStopWhenSettlesArePaused() public {
        _bucket(1e6);
        vm.prank(guardian);
        vault.setSettlesPaused(true);
        RewardBatch memory r = _rewards(1, 1, 1);
        bytes memory sig = _sign(r);
        vm.expectRevert(FeeSplitter.SettlesPaused.selector);
        splitter.distributeRewards(r, sig);
    }

    function test_rewardsEnforceTheBatchLimit() public {
        RewardBatch memory r;
        r.credits = new Credit[](501);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.BatchTooLarge.selector, 501, 500));
        splitter.distributeRewards(r, "");
    }

    function test_burnIsOffByDefault() public view {
        assertFalse(splitter.tokenHooksEnabled());
    }

    function test_burnRevertsWhileHooksAreOff() public {
        vm.expectRevert(FeeSplitter.TokenHooksDisabled.selector);
        splitter.executeBurn(0);
    }

    function test_burnNeedsAnAdapter() public {
        vm.startPrank(owner);
        splitter.setTokenHooksEnabled(true);
        splitter.setBurnKeeper(address(this));
        vm.stopPrank();
        vm.expectRevert(FeeSplitter.NoSwapAdapter.selector);
        splitter.executeBurn(0);
    }

    function test_onlyTheBurnKeeperPicksTheFloor() public {
        vm.prank(owner);
        splitter.setTokenHooksEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NotBurnKeeper.selector, address(this)));
        splitter.executeBurn(0);
    }

    function test_settingTheBurnKeeperIsOwnerOnly() public {
        vm.expectRevert();
        splitter.setBurnKeeper(address(this));
    }

    function test_burnSwapsTheBucketToTheDeadAddress() public {
        MockSwapAdapter adapter = new MockSwapAdapter(IERC20(address(usdg)), ofpk);
        vm.startPrank(owner);
        splitter.setTokenHooksEnabled(true);
        splitter.setSwapAdapter(address(adapter));
        splitter.setBurnKeeper(address(this));
        vm.stopPrank();
        _feed(1_000e6);
        splitter.distribute();

        vm.expectRevert(abi.encodeWithSelector(MockSwapAdapter.InsufficientOutput.selector, 50e6, 50e6 + 1));
        splitter.executeBurn(50e6 + 1);

        vm.expectEmit(address(splitter));
        emit IFeeSplitter.BurnExecuted(50e6, 50e6);
        splitter.executeBurn(50e6);
        assertEq(ofpk.balanceOf(DEAD), 50e6);
        assertEq(splitter.burnBucket(), 0);
    }

    function test_settingsAreOwnerOnly() public {
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(denied);
        splitter.setTokenHooksEnabled(true);
        vm.expectRevert(denied);
        splitter.setSwapAdapter(address(1));
        vm.expectRevert(denied);
        splitter.setPeers(address(1), address(2));
    }

    function test_setPeersOnce() public {
        vm.prank(owner);
        vm.expectRevert(FeeSplitter.AlreadySet.selector);
        splitter.setPeers(address(1), address(2));
    }

    function test_setPeersEmits() public {
        FeeSplitter fresh = new FeeSplitter(owner, IERC20(address(usdg)), IHostRegistry(address(registry)), ops, treasury);
        vm.startPrank(owner);
        vm.expectEmit(address(fresh));
        emit IFeeSplitter.PeersSet(address(1), address(0));
        fresh.setPeers(address(1), address(0));
        vm.expectEmit(address(fresh));
        emit IFeeSplitter.PeersSet(address(1), address(2));
        fresh.setPeers(address(0), address(2));
        vm.stopPrank();
    }

    function testFuzz_distributeAccountsForEveryUnit(uint128 amount, bool hooksOn) public {
        amount = uint128(bound(amount, 0, 1e15));
        vm.prank(owner);
        splitter.setTokenHooksEnabled(hooksOn);
        _feed(amount);
        splitter.distribute();
        uint256 kept = splitter.hostRewardBucket() + splitter.burnBucket();
        assertEq(usdg.balanceOf(address(splitter)), kept);
        assertEq(usdg.balanceOf(ops) + usdg.balanceOf(treasury) + kept, amount);
        assertLe(usdg.balanceOf(ops), uint256(amount) * 8_000 / 10_000 + 3);
    }
}
