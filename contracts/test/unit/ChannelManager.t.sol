// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ChannelManager} from "../../src/ChannelManager.sol";
import {IChannelManager} from "../../src/interfaces/IChannelManager.sol";
import {IOffpeakVault} from "../../src/interfaces/IOffpeakVault.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {AgentFixture} from "../helpers/AgentFixture.sol";

contract ContractWalletPayer {
    bytes32 public approved;

    function approve(bytes32 digest) external {
        approved = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approved ? bytes4(0x1626ba7e) : bytes4(0);
    }

    function approveToken(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok);
    }

    function openChannel(ChannelManager manager, uint256 deposit, uint64 expiry, bytes32 salt) external returns (bytes32) {
        return manager.open(deposit, expiry, salt);
    }
}

contract ChannelManagerTest is AgentFixture {
    uint256 internal constant DEPOSIT = 10e6;

    bytes32 internal id;

    function setUp() public override {
        super.setUp();
        _fundAgent(agent, 100e6);
        id = _openChannel(DEPOSIT, keccak256("salt"));
    }

    function _claim(uint64 seq, uint128 cumulative) private {
        Voucher memory v = _voucher(id, seq, cumulative);
        bytes memory sig = _voucherSig(agentKey, v);
        vm.prank(keeper);
        manager.settleChannel(id, v, sig);
    }

    function _coop(uint128 finalCumulative) private view returns (CooperativeClose memory c, bytes memory payerSig, bytes memory routerSig) {
        c = CooperativeClose({channelId: id, finalCumulative: finalCumulative, deadline: uint64(block.timestamp + 1 hours)});
        bytes32 digest = _channelDigest(Typehashes.hash(c));
        payerSig = _sig(agentKey, digest);
        routerSig = _sig(payeeKey, digest);
    }

    // Opening

    function test_openPullsTheDepositAndDerivesTheId() public view {
        ChannelView memory v = manager.channelView(id);
        assertEq(id, keccak256(abi.encode(agent, keccak256("salt"))));
        assertEq(v.payer, agent);
        assertEq(v.deposit, DEPOSIT);
        assertEq(v.status, 1);
        assertEq(usdg.balanceOf(address(manager)), DEPOSIT);
    }

    function test_openNeedsSixHoursOfLife() public {
        uint64 tooSoon = uint64(block.timestamp + 6 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.ExpiryTooSoon.selector, tooSoon));
        vm.prank(agent);
        manager.open(1, tooSoon, keccak256("other"));
        vm.prank(agent);
        manager.open(1, uint64(block.timestamp + 6 hours), keccak256("other"));
    }

    function test_openNeedsADeposit() public {
        vm.expectRevert(ChannelManager.ZeroDeposit.selector);
        vm.prank(agent);
        manager.open(0, uint64(block.timestamp + 1 days), keccak256("other"));
    }

    function test_aChannelIdIsUsedOnce() public {
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.ChannelExists.selector, id));
        vm.prank(agent);
        manager.open(1, uint64(block.timestamp + 1 days), keccak256("salt"));
    }

    function test_openWithPermit2OverTheRealContract() public {
        (address other, uint256 otherKey) = makeAddrAndKey("other-agent");
        _fundAgent(other, DEPOSIT);
        ChannelOpenWitness memory w =
            ChannelOpenWitness({channelSalt: keccak256("p2"), payee: payee, expiry: uint64(block.timestamp + 1 days)});
        ISignatureTransfer.PermitTransferFrom memory p = _permit(DEPOSIT);
        bytes memory sig = _witnessSig(otherKey, p, address(manager), Typehashes.hash(w), Typehashes.CHANNEL_WITNESS_TYPESTRING);
        bytes32 channelId = manager.openWithPermit2(p, sig, other, w);
        assertEq(manager.channelView(channelId).payer, other);
        assertEq(manager.channelView(channelId).deposit, DEPOSIT);
    }

    function test_openWithPermit2ChecksThePayeeAndToken() public {
        ChannelOpenWitness memory w =
            ChannelOpenWitness({channelSalt: keccak256("p2"), payee: address(1), expiry: uint64(block.timestamp + 1 days)});
        ISignatureTransfer.PermitTransferFrom memory p = _permit(DEPOSIT);
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.WrongPayee.selector, address(1)));
        manager.openWithPermit2(p, "", agent, w);

        w.payee = payee;
        p.permitted.token = address(ofpk);
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.WrongToken.selector, address(ofpk)));
        manager.openWithPermit2(p, "", agent, w);
    }

    function test_topUpIsPayerOnlyAndBeforeExpiry() public {
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.NotAllowed.selector, address(this)));
        manager.topUp(id, 1);

        vm.expectEmit(address(manager));
        emit IChannelManager.ChannelToppedUp(id, 5e6, DEPOSIT + 5e6);
        vm.prank(agent);
        manager.topUp(id, 5e6);

        uint64 expiry = manager.channelView(id).expiry;
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.PastExpiry.selector, expiry));
        vm.prank(agent);
        manager.topUp(id, 1);
    }

    // Claims

    function test_aClaimPaysTheDeltaIntoTheAgentPool() public {
        _claim(1, 2e6);
        Voucher memory v = _voucher(id, 2, 3e6);
        bytes memory sig = _voucherSig(agentKey, v);
        vm.expectEmit(address(manager));
        emit IChannelManager.ChannelClaimed(id, 2, 3e6, 1e6);
        vm.expectEmit(address(vault));
        emit IOffpeakVault.AgentPoolCredited(keccak256(abi.encode(id, uint64(2))), 1e6);
        vm.prank(keeper);
        manager.settleChannel(id, v, sig);

        assertEq(vault.agentPool(), 3e6);
        assertEq(usdg.balanceOf(address(vault)), 3e6);
        assertEq(manager.channelView(id).claimed, 3e6);
        assertEq(manager.channelView(id).lastSeq, 2);
    }

    function test_onlyThePayeeOrKeeperCanClaim() public {
        Voucher memory v = _voucher(id, 1, 1e6);
        bytes memory sig = _voucherSig(agentKey, v);
        vm.expectRevert(abi.encodeWithSelector(ChannelManager.NotAllowed.selector, address(this)));
        manager.settleChannel(id, v, sig);
        vm.prank(payee);
        manager.settleChannel(id, v, sig);
    }

    function test_aVoucherNeedsThePayersSignature() public {
        Voucher memory v = _voucher(id, 1, 1e6);
        (, uint256 stranger) = makeAddrAndKey("stranger");
        bytes memory sig = _voucherSig(stranger, v);
        vm.expectRevert(ChannelManager.BadSignature.selector);
        vm.prank(keeper);
        manager.settleChannel(id, v, sig);
    }

    function test_theRouterCannotSignItsOwnVoucher() public {
        Voucher memory v = _voucher(id, 1, 1e6);
        bytes memory sig = _voucherSig(payeeKey, v);
        vm.expectRevert(ChannelManager.BadSignature.selector);
        vm.prank(payee);
        manager.settleChannel(id, v, sig);
    }
