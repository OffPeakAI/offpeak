// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IChannelManager} from "./interfaces/IChannelManager.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import "./interfaces/OffpeakTypes.sol";
import {Typehashes} from "./lib/Typehashes.sol";

/// @notice Holds agent deposits. Nothing reaches the payee without a payer voucher or a cooperative close,
/// and a close always waits out the challenge period, so the latest voucher can land.
contract ChannelManager is IChannelManager, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error BadCumulative(uint128 cumulative, uint128 claimed, uint256 deposit);
    error BadSignature();
    error ChallengeNotOver(uint64 endsAt);
    error ChallengeOver(uint64 endsAt);
    error ChannelExists(bytes32 channelId);
    error DeadlinePassed(uint64 deadline);
    error ExpiryTooSoon(uint64 expiry);
    error NotAllowed(address caller);
    error PastExpiry(uint64 expiry);
    error StaleVoucher(uint64 seq, uint64 lastSeq);
    error WrongChannel(bytes32 channelId);
    error WrongPayee(address payee);
    error WrongStatus(bytes32 channelId, uint8 status);
    error WrongToken(address token);
    error ZeroDeposit();

    struct Channel {
        address payer;
        uint8 status;
        uint64 expiry;
        uint64 lastSeq;
        uint64 challengeEndsAt;
        uint128 claimed;
        uint256 deposit;
    }

    uint8 public constant STATUS_NONE = 0;
    uint8 public constant STATUS_OPEN = 1;
    uint8 public constant STATUS_CLOSING = 2;
    uint8 public constant STATUS_CLOSED = 3;
    uint256 public constant MIN_LIFETIME = 6 hours;
    uint256 public constant CHALLENGE_PERIOD = 2 hours;

    IERC20 public immutable usdg;
    ISignatureTransfer public immutable permit2;
    address public immutable vault;
    address public immutable payee;
    address public immutable keeper;

    mapping(bytes32 => Channel) internal _channels;
    /// Refunds a frozen address could not take. It collects them with `claimOwed` once it can.
    mapping(address => uint256) public owed;

    constructor(IERC20 usdg_, ISignatureTransfer permit2_, address vault_, address payee_, address keeper_)
        EIP712("OffpeakChannel", "1")
    {
        usdg = usdg_;
        permit2 = permit2_;
        vault = vault_;
        payee = payee_;
        keeper = keeper_;
    }

    function open(uint256 deposit, uint64 expiry, bytes32 salt) external nonReentrant returns (bytes32 channelId) {
        channelId = _open(msg.sender, deposit, expiry, salt);
        usdg.safeTransferFrom(msg.sender, address(this), deposit);
    }

    function openWithPermit2(
        ISignatureTransfer.PermitTransferFrom calldata p,
        bytes calldata sig,
        address payer,
        ChannelOpenWitness calldata w
    ) external nonReentrant returns (bytes32 channelId) {
        if (w.payee != payee) revert WrongPayee(w.payee);
        if (p.permitted.token != address(usdg)) revert WrongToken(p.permitted.token);
        channelId = _open(payer, p.permitted.amount, w.expiry, w.channelSalt);
        permit2.permitWitnessTransferFrom(
            p,
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: p.permitted.amount}),
            payer,
            Typehashes.hash(w),
            Typehashes.CHANNEL_WITNESS_TYPESTRING,
            sig
        );
    }

    function topUp(bytes32 channelId, uint256 amount) external nonReentrant {
        Channel storage c = _channels[channelId];
        if (msg.sender != c.payer) revert NotAllowed(msg.sender);
        if (c.status != STATUS_OPEN) revert WrongStatus(channelId, c.status);
        if (block.timestamp >= c.expiry) revert PastExpiry(c.expiry);
        c.deposit += amount;
        emit ChannelToppedUp(channelId, amount, c.deposit);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }
