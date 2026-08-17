// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {X402Escrow} from "../../src/X402Escrow.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {IX402Escrow} from "../../src/interfaces/IX402Escrow.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {AgentFixture} from "../helpers/AgentFixture.sol";

contract GasBurningWallet {
    constructor(MockUSDG usdg) {
        usdg.approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, type(uint256).max);
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        while (true) {}
        return 0x1626ba7e;
    }
}

contract X402EscrowTest is AgentFixture {
    bytes32 internal constant REQ = keccak256("req");
    uint256 internal constant MAX = 1_000_000;

    function setUp() public override {
        super.setUp();
        _fundAgent(agent, 100e6);
    }

    function _authorize(bytes32 reqId, uint256 amount) private {
        AuthorizeCall memory c = _authorizeCall(reqId, amount);
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function _exactWitness(uint256 amount) private view returns (ExactWitness memory) {
        return ExactWitness({
            reqId: REQ,
            payee: address(vault),
            amount: amount,
            validBefore: uint64(block.timestamp + 10 minutes),
            resourceHash: keccak256("resource")
        });
    }

    function test_authorizePullsTheWholeMaxUpFront() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        vm.expectEmit(address(x402));
        emit IX402Escrow.Authorized(REQ, agent, MAX, c.w.validBefore);
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
        assertEq(usdg.balanceOf(address(x402)), MAX);
        assertEq(usdg.balanceOf(agent), 100e6 - MAX);
        assertEq(x402.escrowView(REQ).status, 1);
    }

    function test_aRevokedApprovalCannotClawBackAnAuthorizedEscrow() public {
        _authorize(REQ, MAX);
        vm.prank(agent);
        usdg.approve(PERMIT2, 0);
        vm.prank(capturer);
        x402.capture(REQ, MAX);
        assertEq(usdg.balanceOf(address(vault)), MAX);
    }

    function test_onlyTheRelayAuthorizes() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.NotRelay.selector, address(this)));
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_theMaxMustReachTheMinimum() public {
        AuthorizeCall memory c = _authorizeCall(REQ, 49_999);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.MaxTooLow.selector, 49_999));
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_theWitnessMustNameTheVault() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        c.w.payee = makeAddr("thief");
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.WrongPayee.selector, c.w.payee));
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_thePermitMustMatchTheWitness() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        c.p.permitted.amount = MAX + 1;
        vm.expectRevert(X402Escrow.WrongPermit.selector);
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_onlyUsdg() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        c.p.permitted.token = address(ofpk);
        vm.expectRevert(X402Escrow.WrongPermit.selector);
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_anExpiredWitnessIsRefused() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        vm.warp(c.w.validBefore);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.ExpiredAuthorization.selector, c.w.validBefore));
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_aReqIdIsUsedOnce() public {
        _authorize(REQ, MAX);
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.ReqIdUsed.selector, REQ));
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_aForgedSignatureFailsInsidePermit2() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        (, uint256 stranger) = makeAddrAndKey("stranger");
        c.sig = _witnessSig(stranger, c.p, address(x402), Typehashes.hash(c.w), Typehashes.UPTO_WITNESS_TYPESTRING);
        vm.expectRevert();
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
        assertEq(usdg.balanceOf(address(x402)), 0);
    }

    function test_aChangedWitnessBreaksTheSignature() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        c.w.resourceHash = keccak256("something else");
        vm.expectRevert();
        vm.prank(relay);
        x402.authorize(c.p, c.sig, c.payer, c.w);
    }

    function test_oneBadItemDoesNotSinkABatch() public {
        AuthorizeCall[] memory calls = new AuthorizeCall[](3);
        calls[0] = _authorizeCall(keccak256("a"), MAX);
        calls[1] = _authorizeCall(keccak256("b"), MAX);
        calls[1].sig = hex"00";
        calls[2] = _authorizeCall(keccak256("c"), MAX);

        vm.expectEmit(true, false, false, false, address(x402));
        emit IX402Escrow.AuthorizeFailed(keccak256("b"), "");
        vm.prank(relay);
        x402.authorizeBatch(calls);

        assertEq(x402.escrowView(keccak256("a")).status, 1);
        assertEq(x402.escrowView(keccak256("b")).status, 0);
        assertEq(x402.escrowView(keccak256("c")).status, 1);
        assertEq(usdg.balanceOf(address(x402)), 2 * MAX);
    }

    function test_aBatchShortOfGasRevertsRatherThanRefusingAGoodPayment() public {
        AuthorizeCall[] memory calls = new AuthorizeCall[](1);
        calls[0] = _authorizeCall(REQ, MAX);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.NotEnoughGasForItem.selector, 0));
        vm.prank(relay);
        x402.authorizeBatch{gas: 300_000}(calls);
        assertEq(x402.escrowView(REQ).status, 0);
    }

    function test_theGasFloorLeavesEachItemEnoughToFinish() public {
        AuthorizeCall[] memory calls = new AuthorizeCall[](1);
        calls[0] = _authorizeCall(REQ, MAX);
        uint256 gasLimit = x402.MIN_ITEM_GAS() + 30_000;
        vm.prank(relay);
        x402.authorizeBatch{gas: gasLimit}(calls);
        assertEq(x402.escrowView(REQ).status, 1);
    }

    function test_aGasBurningWalletSinksOnlyItself() public {
        GasBurningWallet bomb = new GasBurningWallet(usdg);
        usdg.mint(address(bomb), 10e6);
        AuthorizeCall[] memory calls = new AuthorizeCall[](3);
        calls[0] = _authorizeCall(keccak256("a"), MAX);
        calls[1] = _authorizeCall(keccak256("b"), MAX);
        calls[1].payer = address(bomb);
        calls[2] = _authorizeCall(keccak256("c"), MAX);
        vm.prank(relay);
        x402.authorizeBatch{gas: 2_000_000}(calls);
        assertEq(x402.escrowView(keccak256("a")).status, 1);
        assertEq(x402.escrowView(keccak256("b")).status, 0);
        assertEq(x402.escrowView(keccak256("c")).status, 1);
    }

    function test_aFrozenPayerCannotHoldUpACapture() public {
        _authorize(REQ, MAX);
        vm.mockCallRevert(address(usdg), abi.encodeWithSelector(usdg.transfer.selector, agent, MAX - 1), "frozen");
        vm.prank(capturer);
        x402.capture(REQ, 1);
        vm.clearMockedCalls();
        assertEq(vault.agentPool(), 1);
        assertEq(x402.owed(agent), MAX - 1);
        vm.prank(agent);
        x402.claimOwed();
        assertEq(usdg.balanceOf(agent), 100e6 - 1);
    }

    function test_aFrozenPayerCannotHoldUpAnExpiry() public {
        _authorize(REQ, MAX);
        vm.warp(block.timestamp + 1 hours);
        vm.mockCallRevert(address(usdg), abi.encodeWithSelector(usdg.transfer.selector, agent, MAX), "frozen");
        x402.expire(REQ);
        vm.clearMockedCalls();
        assertEq(x402.owed(agent), MAX);
    }

    function test_batchItemsCannotBeCalledFromOutside() public {
        AuthorizeCall memory c = _authorizeCall(REQ, MAX);
        vm.expectRevert(X402Escrow.OnlySelf.selector);
        vm.prank(relay);
        x402.authorizeOne(c);
    }

    function test_batchesAreBounded() public {
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.BatchTooLarge.selector, 101, 100));
        vm.prank(relay);
        x402.authorizeBatch(new AuthorizeCall[](101));
    }

    function test_captureSendsActualToThePoolAndRefundsTheRest() public {
        _authorize(REQ, MAX);
        vm.expectEmit(address(x402));
        emit IX402Escrow.Captured(REQ, 300_000, 700_000);
        vm.prank(capturer);
        x402.capture(REQ, 300_000);
        assertEq(vault.agentPool(), 300_000);
        assertEq(usdg.balanceOf(address(vault)), 300_000);
        assertEq(usdg.balanceOf(agent), 100e6 - 300_000);
        assertEq(usdg.balanceOf(address(x402)), 0);
    }

    function test_captureOfZeroRefundsEverything() public {
        _authorize(REQ, MAX);
        vm.prank(capturer);
        x402.capture(REQ, 0);
        assertEq(usdg.balanceOf(agent), 100e6);
    }

    function test_onlyTheCapturerCaptures() public {
        _authorize(REQ, MAX);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.NotCapturer.selector, relay));
        vm.prank(relay);
        x402.capture(REQ, 1);
    }

    function test_captureCannotExceedTheMax() public {
        _authorize(REQ, MAX);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.OverMax.selector, MAX + 1, uint128(MAX)));
        vm.prank(capturer);
        x402.capture(REQ, MAX + 1);
    }

    function test_aCaptureHappensOnce() public {
        _authorize(REQ, MAX);
        vm.startPrank(capturer);
        x402.capture(REQ, 1);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.EscrowClosed.selector, REQ));
        x402.capture(REQ, 1);
    }

    function test_captureClosesAfterTheGrace() public {
        _authorize(REQ, MAX);
        uint64 validBefore = x402.escrowView(REQ).validBefore;
        vm.warp(uint256(validBefore) + 901);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.ExpiredAuthorization.selector, validBefore));
        vm.prank(capturer);
        x402.capture(REQ, 1);
    }

    function test_captureBatchSettlesEach() public {
        _authorize(keccak256("a"), MAX);
        _authorize(keccak256("b"), MAX);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256("a");
        ids[1] = keccak256("b");
        uint256[] memory actuals = new uint256[](2);
        actuals[0] = 100;
        actuals[1] = 200;
        vm.prank(capturer);
        x402.captureBatch(ids, actuals);
        assertEq(vault.agentPool(), 300);
    }

    function test_captureBatchChecksLengths() public {
        vm.expectRevert(X402Escrow.LengthMismatch.selector);
        vm.prank(capturer);
        x402.captureBatch(new bytes32[](2), new uint256[](1));
    }

    function test_expiryRefundsAnyoneCanTriggerIt() public {
        _authorize(REQ, MAX);
        uint256 at = uint256(x402.escrowView(REQ).validBefore) + 900;
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.NotExpired.selector, at));
        x402.expire(REQ);

        vm.warp(at + 1);
        vm.expectEmit(address(x402));
        emit IX402Escrow.Expired(REQ, MAX);
        x402.expire(REQ);
        assertEq(usdg.balanceOf(agent), 100e6);
    }

    function test_aCapturedEscrowCannotExpire() public {
        _authorize(REQ, MAX);
        vm.prank(capturer);
        x402.capture(REQ, 1);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.EscrowClosed.selector, REQ));
        x402.expire(REQ);
    }

    function test_exactGoesStraightToThePool() public {
        ExactWitness memory w = _exactWitness(40_000);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(40_000);
        bytes memory sig = _witnessSig(agentKey, p, address(x402), Typehashes.hash(w), Typehashes.EXACT_WITNESS_TYPESTRING);
        vm.expectEmit(address(x402));
        emit IX402Escrow.ExactSettled(REQ, agent, 40_000);
        vm.prank(relay);
        x402.settleExact(p, sig, agent, w);
        assertEq(vault.agentPool(), 40_000);
        assertEq(usdg.balanceOf(address(vault)), 40_000);
        assertEq(usdg.balanceOf(address(x402)), 0);
    }

    function test_exactIsRelayOnlyAndOneShot() public {
        ExactWitness memory w = _exactWitness(40_000);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(40_000);
        bytes memory sig = _witnessSig(agentKey, p, address(x402), Typehashes.hash(w), Typehashes.EXACT_WITNESS_TYPESTRING);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.NotRelay.selector, address(this)));
        x402.settleExact(p, sig, agent, w);

        vm.startPrank(relay);
        x402.settleExact(p, sig, agent, w);
        vm.expectRevert(abi.encodeWithSelector(X402Escrow.ReqIdUsed.selector, REQ));
        x402.settleExact(p, sig, agent, w);
    }

    function testFuzz_captureConserves(uint128 maxAmount, uint128 actual) public {
        maxAmount = uint128(bound(maxAmount, 50_000, 100e6));
        actual = uint128(bound(actual, 0, maxAmount));
        _authorize(REQ, maxAmount);
        vm.prank(capturer);
        x402.capture(REQ, actual);
        assertEq(usdg.balanceOf(address(vault)), actual);
        assertEq(usdg.balanceOf(agent), 100e6 - actual);
        assertEq(usdg.balanceOf(address(x402)), 0);
    }
}
