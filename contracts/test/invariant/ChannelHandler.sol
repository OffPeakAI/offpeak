// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ChannelManager} from "../../src/ChannelManager.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {AgentFixture} from "../helpers/AgentFixture.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

/// @notice Drives channels through every path. A voucher the payer signed but the keeper has not landed yet
/// is kept, so the suite can prove the latest one always lands while the challenge is open.
contract ChannelHandler is AgentFixture {
    bytes32[] public ids;
    mapping(bytes32 => uint64) public nextSeq;
    mapping(bytes32 => uint256) public ghostClaimed;

    uint256 public ghostDeposits;
    uint256 public ghostPaid;
    uint256 public ghostRefunded;
    uint256 public closedEarly;
    uint256 public latestVoucherLost;
    uint256 public opens;
    uint256 public claims;
    uint256 public finalized;
    uint256 public coopCloses;
    uint256 public challengeClaims;

    constructor() {
        VaultFixture.setUp();
        _fundAgent(agent, 1_000_000e6);
    }

    function setUp() public override {}

    function managerAddress() external view returns (ChannelManager) {
        return manager;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function managerBalance() external view returns (uint256) {
        return usdg.balanceOf(address(manager));
    }

    function open(uint256 deposit, uint256 lifetime) external {
        deposit = bound(deposit, 1, 100e6);
        lifetime = bound(lifetime, 6 hours, 3 days);
        vm.prank(agent);
        bytes32 id = manager.open(deposit, uint64(block.timestamp + lifetime), bytes32(ids.length));
        ids.push(id);
        ghostDeposits += deposit;
        opens++;
    }

    function topUp(uint256 seed, uint256 amount) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found || c.status != 1 || block.timestamp >= c.expiry) return;
        amount = bound(amount, 1, 10e6);
        vm.prank(agent);
        manager.topUp(id, amount);
        ghostDeposits += amount;
    }

    function claim(uint256 seed, uint256 share) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found) return;
        bool open_ = c.status == 1;
        bool challenging = c.status == 2 && block.timestamp < c.challengeEndsAt;
        if ((!open_ && !challenging) || c.claimed >= c.deposit) return;
        uint256 amount = bound(share, 1, c.deposit - c.claimed);
        _claim(id, c.claimed + amount);
        if (challenging) challengeClaims++;
    }
