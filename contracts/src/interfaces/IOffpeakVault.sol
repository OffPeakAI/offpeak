// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISignatureTransfer} from "./ISignatureTransfer.sol";
import "./OffpeakTypes.sol";

interface IOffpeakVault {
    event Deposited(address indexed buyer, uint256 amount, uint256 balance);
    event CapsChangeRequested(address indexed buyer, uint128 hourlyCap, uint128 dailyCap, uint64 effectiveAfterHour);
    event CapsChanged(address indexed buyer, uint128 hourlyCap, uint128 dailyCap);
    event Withdrawn(address indexed buyer, uint256 amount, uint256 balance);
    event WithdrawAllRequested(address indexed buyer, uint64 requestedAt, uint64 dueAt);
    event WithdrawAllCancelled(address indexed buyer);
    event WithdrawAllExecuted(address indexed buyer, uint256 amount);
    event Settled(uint64 indexed hour, bytes32 root, bytes32 totalsHash, uint128 debited, uint128 credited, uint128 fees);
    event Debited(uint64 indexed hour, address indexed buyer, uint128 requested, uint128 debited, uint256 balance);
    event DebitClamped(uint64 indexed hour, address indexed buyer, uint128 requested, uint128 debited);
    event Refunded(address indexed payer, uint128 amount, bytes32 refundId);
    event AgentPoolCredited(bytes32 indexed paymentId, uint256 amount);
    event CreditShortfall(uint64 indexed hour, uint128 amount);
    event Paused(bool usagePaused, bool settlesPaused);
    event ReserveFunded(address indexed from, uint256 amount, uint256 reserve);
    event SignersChanged(address[3] oldSigners, address[3] newSigners);
    event GuardianChanged(address oldGuardian, address newGuardian);
    event BetaCapDisabled();
    event PeersSet(address windowMarket, address feeSplitter, address x402Escrow, address channelManager);

    function deposit(uint256 amount) external;
    function depositWithPermit2(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig) external;
    function setCaps(uint128 hourlyCap, uint128 dailyCap) external;
    function withdraw(uint256 amount) external;
    function requestWithdrawAll() external;
    function cancelWithdrawAll() external;
    function executeWithdrawAll(address buyer) external;
    function settle(SettleBatch calldata b, RootTotals calldata t, bytes calldata thresholdSig) external;
    function refund(RefundBatch calldata r, bytes calldata thresholdSig) external;
    function lastSettledHour() external view returns (uint64);
    function creditAgentPool(uint256 amount, bytes32 paymentId) external;
    function fundReserve(uint256 amount) external;
    function reserveOf(address buyer) external view returns (uint256);
    function effectiveCaps(address buyer, uint64 hour) external view returns (uint128 hourlyCap, uint128 dailyCap);
    function buyerState(address buyer) external view returns (BuyerView memory);
    function dayDebit(address buyer) external view returns (uint64 day, uint128 debited);
    function settlers(uint256 index) external view returns (address);
    function settlesPaused() external view returns (bool);
}
