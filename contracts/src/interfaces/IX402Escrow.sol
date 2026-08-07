// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISignatureTransfer} from "./ISignatureTransfer.sol";
import "./OffpeakTypes.sol";

interface IX402Escrow {
    event Authorized(bytes32 indexed reqId, address indexed payer, uint256 maxAmount, uint64 validBefore);
    event Captured(bytes32 indexed reqId, uint256 actual, uint256 refunded);
    event ExactSettled(bytes32 indexed reqId, address indexed payer, uint256 amount);
    event Expired(bytes32 indexed reqId, uint256 refunded);
    event AuthorizeFailed(bytes32 indexed reqId, bytes reason);

    function authorize(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig, address payer, UptoWitness calldata w)
        external;
    function authorizeBatch(AuthorizeCall[] calldata calls) external;
    function authorizeOne(AuthorizeCall calldata call) external;
    function capture(bytes32 reqId, uint256 actual) external;
    function captureBatch(bytes32[] calldata reqIds, uint256[] calldata actuals) external;
    function settleExact(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig, address payer, ExactWitness calldata w)
        external;
    function expire(bytes32 reqId) external;
    function claimOwed() external;
    function escrowView(bytes32 reqId) external view returns (EscrowView memory);
}
