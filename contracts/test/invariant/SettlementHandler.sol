// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {HourMath} from "../../src/lib/HourMath.sol";
import {VaultHandler} from "./VaultHandler.sol";

/// @notice Adds a mirror of every host credit and batches that must be refused to the vault handler.
contract SettlementHandler is VaultHandler {
    struct Entry {
        uint64 hour;
        uint64 releasableAt;
        uint128 amount;
        bool gone;
    }

    bool public badBatchAccepted;
    bool public creditMirrorBroken;
    uint256 public refusedBatches;
    uint256 public clawsInWindow;
    uint256 public clawsAfterWindow;
    uint256 public hostWithdrawals;
    mapping(address => Entry[]) internal _entries;

    function hostAt(uint256 i) external view returns (address) {
        return i == 0 ? hostA : hostB;
    }

    function mirrored(address host) external view returns (uint256 pending, uint256 releasable) {
        Entry[] storage entries = _entries[host];
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].gone) continue;
            if (entries[i].releasableAt > block.timestamp) pending += entries[i].amount;
            else releasable += entries[i].amount;
        }
    }

    function _onSettled(Vm.Log[] memory logs) internal override {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IHostRegistry.CreditsAccrued.selector) continue;
            address host = address(uint160(uint256(logs[i].topics[1])));
            (uint128 amount, uint64 releasableAt) = abi.decode(logs[i].data, (uint128, uint64));
            _entries[host].push(Entry(uint64(uint256(logs[i].topics[2])), releasableAt, amount, false));
        }
    }

    function withdrawHostCredits(uint256 hostSeed) external {
        address host = hostSeed % 2 == 0 ? hostA : hostB;
        Entry[] storage entries = _entries[host];
        uint256 expected;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].gone || entries[i].releasableAt > block.timestamp) continue;
            expected += entries[i].amount;
            entries[i].gone = true;
        }
        uint256 before = usdg.balanceOf(host);
        vm.prank(host);
        registry.withdrawCredits();
        if (usdg.balanceOf(host) - before != expected) creditMirrorBroken = true;
        ++hostWithdrawals;
    }

    /// Exactly the entries of that hour still inside their 24 hours may be clawed.
    function clawBack(uint256 hostSeed, uint256 entrySeed) external {
        address host = hostSeed % 2 == 0 ? hostA : hostB;
        Entry[] storage entries = _entries[host];
        if (entries.length == 0) return;
        uint64 hour = entries[entrySeed % entries.length].hour;
        uint256 expected;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].gone || entries[i].hour != hour || entries[i].releasableAt <= block.timestamp) continue;
            expected += entries[i].amount;
            entries[i].gone = true;
        }
        uint256 before = vault.protocolReserve();
        vm.prank(guardian);
        registry.clawBack(host, hour, keccak256("incident"));
        if (vault.protocolReserve() - before != expected) creditMirrorBroken = true;
        if (expected > 0) ++clawsInWindow;
        else ++clawsAfterWindow;
    }
