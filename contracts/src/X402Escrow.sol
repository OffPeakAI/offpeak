// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {IX402Escrow} from "./interfaces/IX402Escrow.sol";
import "./interfaces/OffpeakTypes.sol";
import {Typehashes} from "./lib/Typehashes.sol";

/// @notice Pulls an `upto` maximum before serving goes past the pre-confirmation budget, so a revoked
/// approval cannot buy free inference. No owner path can move escrowed funds.
contract X402Escrow is IX402Escrow, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error BatchTooLarge(uint256 length, uint256 max);
    error EscrowClosed(bytes32 reqId);
    error ExpiredAuthorization(uint64 validBefore);
    error LengthMismatch();
    error MaxTooLow(uint256 maxAmount);
    error NotCapturer(address caller);
    error NotEnoughGasForItem(uint256 index);
    error NotExpired(uint256 at);
    error NotRelay(address caller);
    error OnlySelf();
    error OverMax(uint256 actual, uint128 max);
    error ReqIdUsed(bytes32 reqId);
    error WrongPayee(address payee);
    error WrongPermit();

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_AUTHORIZED = 1;
    uint8 public constant STATUS_CAPTURED = 2;
    uint8 public constant STATUS_EXPIRED = 3;
    uint8 public constant STATUS_EXACT = 4;
    uint256 public constant UPTO_MIN_MAX = 50_000;
    uint256 public constant EXPIRY_GRACE = 900;
    uint256 public constant MAX_BATCH = 100;
    /// Without this floor a gas estimate can settle on a limit where an item runs out inside the try,
    /// which refuses a good payment while the batch still succeeds.
    uint256 public constant MIN_ITEM_GAS = 350_000;
    /// Each item runs on this much, so a contract wallet that burns gas sinks only itself.
    uint256 public constant ITEM_GAS = 300_000;

    IERC20 public immutable usdg;
    ISignatureTransfer public immutable permit2;
    address public immutable payee;
    address public immutable relay;
    address public immutable capturer;

    mapping(bytes32 => EscrowView) internal _escrows;
    /// Refunds a frozen address could not take. It collects them with `claimOwed` once it can.
    mapping(address => uint256) public owed;

    modifier onlyRelay() {
        if (msg.sender != relay) revert NotRelay(msg.sender);
        _;
    }

    modifier onlyCapturer() {
        if (msg.sender != capturer) revert NotCapturer(msg.sender);
        _;
    }

    constructor(IERC20 usdg_, ISignatureTransfer permit2_, address payee_, address relay_, address capturer_) {
        usdg = usdg_;
        permit2 = permit2_;
        payee = payee_;
        relay = relay_;
        capturer = capturer_;
    }

    function authorize(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig, address payer, UptoWitness calldata w)
        external
        onlyRelay
        nonReentrant
    {
        _authorize(p, sig, payer, w);
    }

    /// One bad item must not sink the rest, so each runs in its own call frame.
    function authorizeBatch(AuthorizeCall[] calldata calls) external onlyRelay nonReentrant {
        if (calls.length > MAX_BATCH) revert BatchTooLarge(calls.length, MAX_BATCH);
        for (uint256 i; i < calls.length; ++i) {
            if (gasleft() < MIN_ITEM_GAS) revert NotEnoughGasForItem(i);
            try this.authorizeOne{gas: ITEM_GAS}(calls[i]) {} catch (bytes memory reason) {
                emit AuthorizeFailed(calls[i].w.reqId, reason);
            }
        }
    }

    function authorizeOne(AuthorizeCall calldata call) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _authorize(call.p, call.sig, call.payer, call.w);
    }
