// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";
import {UsageLedger} from "../../src/UsageLedger.sol";
import {IUsageLedger} from "../../src/interfaces/IUsageLedger.sol";

contract UsageLedgerTest is Test {
    uint64 internal constant HOUR = 500_000;
    bytes32 internal constant TOTALS = keccak256("totals");

    address internal owner = makeAddr("owner");
    address internal vault = makeAddr("vault");
    UsageLedger internal ledger;

    function setUp() public {
        ledger = new UsageLedger(owner, makeAddr("router"));
        vm.prank(owner);
        ledger.setVault(vault);
    }

    function test_postRootStoresAndEmits() public {
        bytes32 root = keccak256("root");
        vm.expectEmit(address(ledger));
        emit IUsageLedger.RootPosted(HOUR, root, TOTALS, 3);
        vm.prank(vault);
        ledger.postRoot(HOUR, root, TOTALS, 3);
        (bytes32 storedRoot, bytes32 storedTotals) = ledger.rootOf(HOUR);
        assertEq(storedRoot, root);
        assertEq(storedTotals, TOTALS);
    }

    function test_postRootIsVaultOnly() public {
        vm.expectRevert(abi.encodeWithSelector(UsageLedger.NotVault.selector, address(this)));
        ledger.postRoot(HOUR, keccak256("root"), TOTALS, 1);
    }

    function test_postRootOncePerHour() public {
        vm.startPrank(vault);
        ledger.postRoot(HOUR, bytes32(0), TOTALS, 0);
        vm.expectRevert(abi.encodeWithSelector(UsageLedger.RootAlreadyPosted.selector, HOUR));
        ledger.postRoot(HOUR, keccak256("root"), TOTALS, 1);
    }

    function test_zeroRootOnlyWithZeroRecords() public {
        vm.startPrank(vault);
        vm.expectRevert(abi.encodeWithSelector(UsageLedger.RootRecordsMismatch.selector, bytes32(0), uint32(1)));
        ledger.postRoot(HOUR, bytes32(0), TOTALS, 1);
        bytes32 root = keccak256("root");
        vm.expectRevert(abi.encodeWithSelector(UsageLedger.RootRecordsMismatch.selector, root, uint32(0)));
        ledger.postRoot(HOUR, root, TOTALS, 0);
    }

    function test_verifyLeaf() public {
        bytes32 leafA = keccak256("a");
        bytes32 leafB = keccak256("b");
        (bytes32 lo, bytes32 hi) = leafA < leafB ? (leafA, leafB) : (leafB, leafA);
        vm.prank(vault);
        ledger.postRoot(HOUR, keccak256(abi.encodePacked(lo, hi)), TOTALS, 2);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafB;
        assertTrue(ledger.verifyLeaf(HOUR, leafA, proof));
        assertFalse(ledger.verifyLeaf(HOUR, keccak256("c"), proof));
        assertFalse(ledger.verifyLeaf(HOUR + 1, leafA, proof));
    }

    function test_nothingVerifiesAgainstAnEmptyHour() public {
        vm.prank(vault);
        ledger.postRoot(HOUR, bytes32(0), TOTALS, 0);
        assertFalse(ledger.verifyLeaf(HOUR, bytes32(0), new bytes32[](0)));
    }

    function test_setVaultOnce() public {
        vm.prank(owner);
        vm.expectRevert(UsageLedger.AlreadySet.selector);
        ledger.setVault(makeAddr("other"));
    }

    function test_setRouterSignerIsOwnerOnly() public {
        address next = makeAddr("next");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        ledger.setRouterSigner(next);
        vm.prank(owner);
        ledger.setRouterSigner(next);
        assertEq(ledger.routerSigner(), next);
    }
}
