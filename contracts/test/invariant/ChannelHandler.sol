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

    function requestClose(uint256 seed, bool asStranger) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found || c.status != 1) return;
        if (asStranger && block.timestamp < c.expiry) return;
        vm.prank(asStranger ? address(0xDEAD) : agent);
        manager.requestClose(id);
    }

    /// A close that has not waited out the challenge must revert, every time.
    function attemptEarlyFinalize(uint256 seed) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found || c.status != 2 || block.timestamp >= c.challengeEndsAt) return;
        try manager.finalizeClose(id) {
            closedEarly++;
        } catch {}
    }

    /// The keeper lands the payer's newest voucher in the last second of the challenge, then the close finishes.
    function closeRace(uint256 seed, uint256 share) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found || c.status != 1) return;
        vm.prank(agent);
        manager.requestClose(id);
        uint64 endsAt = manager.channelView(id).challengeEndsAt;
        vm.warp(endsAt - 1);
        uint256 target = c.claimed;
        if (c.claimed < c.deposit) {
            target = c.claimed + bound(share, 1, c.deposit - c.claimed);
            _claim(id, target);
            challengeClaims++;
        }
        vm.warp(endsAt);
        if (manager.channelView(id).claimed != target) latestVoucherLost++;
        _finalize(id);
    }

    function finalize(uint256 seed, uint256 extra) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found || c.status != 2) return;
        if (block.timestamp < c.challengeEndsAt) {
            vm.warp(uint256(c.challengeEndsAt) + bound(extra, 0, 1 hours));
        }
        _finalize(id);
    }

    function cooperativeClose(uint256 seed, uint256 share) external {
        (bytes32 id, ChannelView memory c, bool found) = _pick(seed);
        if (!found || (c.status != 1 && c.status != 2)) return;
        uint256 finalCumulative = bound(share, c.claimed, c.deposit);
        CooperativeClose memory close =
            CooperativeClose({channelId: id, finalCumulative: uint128(finalCumulative), deadline: uint64(block.timestamp + 1 hours)});
        bytes32 digest = _channelDigest(Typehashes.hash(close));
        manager.cooperativeClose(id, close, _sig(agentKey, digest), _sig(payeeKey, digest));
        ghostPaid += finalCumulative - c.claimed;
        ghostRefunded += c.deposit - finalCumulative;
        ghostClaimed[id] = finalCumulative;
        coopCloses++;
    }

    function wait(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 3 hours));
    }

    function _pick(uint256 seed) private view returns (bytes32 id, ChannelView memory c, bool found) {
        if (ids.length == 0) return (id, c, false);
        id = ids[seed % ids.length];
        return (id, manager.channelView(id), true);
    }

    function _claim(bytes32 id, uint256 cumulative) private {
        uint64 seq = ++nextSeq[id];
        Voucher memory v = _voucher(id, seq, uint128(cumulative));
        bytes memory sig = _voucherSig(agentKey, v);
        ChannelView memory before_ = manager.channelView(id);
        vm.prank(keeper);
        manager.settleChannel(id, v, sig);
        ghostPaid += cumulative - before_.claimed;
        ghostClaimed[id] = cumulative;
        claims++;
    }

    function _finalize(bytes32 id) private {
        ChannelView memory c = manager.channelView(id);
        manager.finalizeClose(id);
        ghostRefunded += c.deposit - c.claimed;
        finalized++;
    }
}
