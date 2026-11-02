// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import {FeeSplitterHandler} from "./FeeSplitterHandler.sol";

contract FeeSplitterInvariant is StdInvariant, Test {
    FeeSplitterHandler internal handler;
    FeeSplitter internal splitter;
    HostRegistry internal registry;

    function setUp() public {
        handler = new FeeSplitterHandler();
        splitter = handler.splitterAddress();
        registry = handler.registryAddress();
        targetContract(address(handler));
    }

    function _held() private view returns (uint256) {
        return splitter.undistributed() + splitter.hostRewardBucket() + splitter.burnBucket();
    }

    /// Stray USDG is never counted, so it can never be paid out as fees.
    function invariant_splitterHoldsExactlyItsBuckets() public view {
        assertEq(handler.usdgBalanceOf(address(splitter)), _held() + handler.ghostDonated());
    }

    /// Every fee unit is still here or sits with exactly one recipient.
    function invariant_everyFeeUnitIsConserved() public view {
        uint256 paidOut = handler.usdgBalanceOf(handler.opsAddress()) + handler.usdgBalanceOf(handler.treasuryAddress())
            + handler.usdgBalanceOf(address(registry)) + handler.usdgBalanceOf(handler.hostAddress(0))
            + handler.usdgBalanceOf(handler.hostAddress(1)) + handler.usdgBalanceOf(handler.adapterAddress());
        assertEq(handler.ghostFed(), _held() + paidOut);
    }

    function invariant_eachRecipientGetsItsShare() public view {
        assertEq(handler.usdgBalanceOf(handler.opsAddress()), handler.ghostOps());
        assertEq(handler.usdgBalanceOf(handler.treasuryAddress()), handler.ghostTreasury());
        assertEq(splitter.hostRewardBucket() + handler.ghostRewardsPaid(), handler.ghostRewards());
        assertEq(splitter.burnBucket() + handler.ghostBurned(), handler.ghostBurnShare());
    }

    function invariant_paidRewardsStayBackedOrReachTheHosts() public view {
        assertEq(handler.usdgBalanceOf(address(registry)), registry.totalOwed());
        assertEq(
            handler.usdgBalanceOf(address(registry)) + handler.usdgBalanceOf(handler.hostAddress(0))
                + handler.usdgBalanceOf(handler.hostAddress(1)),
            handler.ghostRewardsPaid()
        );
    }

    function invariant_theBurnSpendsOnlyItsBucketAndLeavesNoAllowance() public view {
        assertEq(handler.usdgBalanceOf(handler.adapterAddress()), handler.ghostBurned());
        assertEq(handler.ofpkBurned(), handler.ghostBurned());
        assertEq(handler.adapterAllowance(), 0);
    }

    function invariant_everyAttackIsRefused() public view {
        assertFalse(handler.attackAccepted());
    }

    function afterInvariant() public view {
        console2.log("distributes", handler.distributes());
        console2.log("reward weeks", handler.rewardWeeks());
        console2.log("burns", handler.burns());
    }
}
