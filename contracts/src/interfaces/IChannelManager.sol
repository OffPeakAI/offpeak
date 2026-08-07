// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISignatureTransfer} from "./ISignatureTransfer.sol";
import "./OffpeakTypes.sol";

interface IChannelManager {
    event ChannelOpened(bytes32 indexed channelId, address indexed payer, uint256 deposit, uint64 expiry);
    event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 deposit);
    event ChannelClaimed(bytes32 indexed channelId, uint64 seq, uint128 cumulative, uint128 paid);
    event CloseRequested(bytes32 indexed channelId, uint64 challengeEndsAt);
    event ChannelClosed(bytes32 indexed channelId, uint128 paidToPayee, uint256 refundedToPayer);

    function open(uint256 deposit, uint64 expiry, bytes32 salt) external returns (bytes32 channelId);
    function openWithPermit2(
        ISignatureTransfer.PermitTransferFrom calldata p,
        bytes calldata sig,
        address payer,
        ChannelOpenWitness calldata w
    ) external returns (bytes32 channelId);
    function topUp(bytes32 channelId, uint256 amount) external;
    function settleChannel(bytes32 channelId, Voucher calldata v, bytes calldata payerSig) external;
    function requestClose(bytes32 channelId) external;
    function finalizeClose(bytes32 channelId) external;
    function cooperativeClose(bytes32 channelId, CooperativeClose calldata c, bytes calldata payerSig, bytes calldata routerSig)
        external;
    function claimOwed() external;
    function channelView(bytes32 channelId) external view returns (ChannelView memory);
}
