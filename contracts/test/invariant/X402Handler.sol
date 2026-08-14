// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {X402Escrow} from "../../src/X402Escrow.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {AgentFixture} from "../helpers/AgentFixture.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

/// @notice Authorizes, revokes, captures and expires. Revoking approval between authorize and capture is the
/// attack the escrow exists to stop, so it is a first-class action here.
contract X402Handler is AgentFixture {
    bytes32[] public reqIds;
    uint256 public ghostAuthorized;
    uint256 public ghostCaptured;
    uint256 public ghostRefunded;
    uint256 public revokedThenClawedBack;
    uint256 public captures;
    uint256 public expiries;
    uint256 public revokes;
    uint256 internal _next;

    constructor() {
        VaultFixture.setUp();
        _fundAgent(agent, 10_000_000e6);
    }

    function setUp() public override {}

    function escrowAddress() external view returns (X402Escrow) {
        return x402;
    }

    function reqCount() external view returns (uint256) {
        return reqIds.length;
    }

    function escrowBalance() external view returns (uint256) {
        return usdg.balanceOf(address(x402));
    }

    function vaultBalance() external view returns (uint256) {
        return usdg.balanceOf(address(vault));
    }

    function authorize(uint256 amount) external {
        amount = bound(amount, 50_000, 10e6);
        vm.prank(agent);
        usdg.approve(PERMIT2, type(uint256).max);
        bytes32 reqId = keccak256(abi.encode("req", _next++));
        AuthorizeCall memory c = _authorizeCall(reqId, amount);
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
        reqIds.push(reqId);
        ghostAuthorized += amount;
    }

    function authorizeBatch(uint256 amount, bool withBadItem) external {
        amount = bound(amount, 50_000, 10e6);
        vm.prank(agent);
        usdg.approve(PERMIT2, type(uint256).max);
        AuthorizeCall[] memory calls = new AuthorizeCall[](2);
        calls[0] = _authorizeCall(keccak256(abi.encode("req", _next++)), amount);
        calls[1] = _authorizeCall(keccak256(abi.encode("req", _next++)), amount);
        if (withBadItem) calls[1].sig = hex"00";
        vm.prank(relay);
        x402.authorizeBatch(calls);
        reqIds.push(calls[0].w.reqId);
        ghostAuthorized += amount;
        if (!withBadItem) {
            reqIds.push(calls[1].w.reqId);
            ghostAuthorized += amount;
        }
    }

    function revoke(uint256 seed) external {
        (bytes32 reqId, EscrowView memory e, bool found) = _pick(seed);
        vm.prank(agent);
        usdg.approve(PERMIT2, 0);
        revokes++;
        if (!found || e.status != 1) return;
        if (x402.escrowView(reqId).max != e.max || usdg.balanceOf(address(x402)) < e.max) revokedThenClawedBack++;
    }

    function capture(uint256 seed, uint256 share) external {
        (bytes32 reqId, EscrowView memory e, bool found) = _pick(seed);
        if (!found || e.status != 1 || block.timestamp > uint256(e.validBefore) + 900) return;
        uint256 actual = bound(share, 0, e.max);
        vm.prank(capturer);
        x402.capture(reqId, actual);
        ghostCaptured += actual;
        ghostRefunded += e.max - actual;
        captures++;
    }

    function expire(uint256 seed) external {
        (bytes32 reqId, EscrowView memory e, bool found) = _pick(seed);
        if (!found || e.status != 1) return;
        if (block.timestamp <= uint256(e.validBefore) + 900) vm.warp(uint256(e.validBefore) + 901);
        x402.expire(reqId);
        ghostRefunded += e.max;
        expiries++;
    }

    function wait(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 20 minutes));
    }

    function _pick(uint256 seed) private view returns (bytes32 reqId, EscrowView memory e, bool found) {
        if (reqIds.length == 0) return (reqId, e, false);
        reqId = reqIds[seed % reqIds.length];
        return (reqId, x402.escrowView(reqId), true);
    }
}
