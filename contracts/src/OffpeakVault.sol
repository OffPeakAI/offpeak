// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IFeeSplitter} from "./interfaces/IFeeSplitter.sol";
import {IHostRegistry} from "./interfaces/IHostRegistry.sol";
import {IOffpeakVault} from "./interfaces/IOffpeakVault.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {IUsageLedger} from "./interfaces/IUsageLedger.sol";
import {IWindowMarket} from "./interfaces/IWindowMarket.sol";
import "./interfaces/OffpeakTypes.sol";
import {HourMath} from "./lib/HourMath.sol";
import {ThresholdSig} from "./lib/ThresholdSig.sol";
import {Typehashes} from "./lib/Typehashes.sol";

contract OffpeakVault is IOffpeakVault, EIP712, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error AlreadySet();
    error BatchTooLarge(uint256 length, uint256 max);
    error BetaCapExceeded(address buyer, uint256 balance);
    error CapExceeded(address buyer, uint64 hour, uint128 amount, uint128 cap);
    error ConservationBroken(uint256 inflow, uint256 outflow);
    error DailyCapExceeded(address buyer, uint64 day, uint128 debited, uint128 cap);
    error DebitAfterRequest(address buyer, uint64 lastTs, uint64 requestedAt);
    error DebitOutsideHour(address buyer, uint64 lastTs, uint64 hour);
    error DebitTotalMismatch(uint256 debits, uint128 prepaidDebit);
    error HourNotReady(uint64 hour, uint256 readyAt);
    error InsufficientAgentPool(uint256 available, uint128 requested);
    error InsufficientProtocolReserve(uint256 available, uint256 requested);
    error NoWithdrawRequest(address buyer);
    error NotAgentPayer(address caller);
    error NotGuardian(address caller);
    error NotSorted();
    error RefundAlreadyPaid(bytes32 refundId);
    error SettlesPaused();
    error TotalsHashMismatch(bytes32 expected, bytes32 actual);
    error UnsortedSigners();
    error WithdrawAlreadyRequested(address buyer);
    error WithdrawExceedsAvailable(uint256 amount, uint256 available);
    error WithdrawNotDue(address buyer, uint64 dueAt);
    error WithdrawPending(address buyer);
    error WrongBatchTarget();
    error WrongHour(uint64 hour, uint64 expected);
    error WrongToken(address token);
    error ZeroDebit(address buyer);

    struct Buyer {
        uint256 balance;
        uint128 hourlyCap;
        uint128 dailyCap;
        uint128 pendingHourlyCap;
        uint128 pendingDailyCap;
        /// Non-zero while a decrease is pending, so a decrease to 0 stays representable.
        uint64 capsEffectiveAfterHour;
        uint64 withdrawRequestedAt;
        uint64 lastDebitDay;
        uint128 debitedToday;
    }

    uint256 public constant BETA_CAP = 500e6;
    uint256 public constant WITHDRAW_ALL_MAX_DELAY = 7200;
    uint256 public constant HOUR_CLOSE_GRACE = 600;
    uint256 public constant MAX_DEBITS = 2000;
    uint256 public constant MAX_CREDITS = 500;
    uint256 public constant MAX_WINDOW_DRAWS = 500;
    uint256 public constant MAX_REFUNDS = 500;

    IERC20 public immutable usdg;
    ISignatureTransfer public immutable permit2;
    IUsageLedger public immutable ledger;
    IHostRegistry public immutable registry;

    IWindowMarket public windowMarket;
    IFeeSplitter public feeSplitter;
    address public x402Escrow;
    address public channelManager;
    address[3] public settlers;
    address public guardian;
    uint64 public lastSettledHour;
    uint256 public agentPool;
    uint256 public protocolReserve;
    bool public usagePaused;
    bool public settlesPaused;
    bool public betaCapEnabled = true;
    mapping(address => Buyer) internal _buyers;
    mapping(bytes32 => bool) public refundPaid;

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    constructor(
        address owner_,
        IERC20 usdg_,
        ISignatureTransfer permit2_,
        IUsageLedger ledger_,
        IHostRegistry registry_,
        address[3] memory settlers_,
        address guardian_
    ) EIP712("OffpeakSettlement", "1") Ownable(owner_) {
        _requireSorted(settlers_);
        usdg = usdg_;
        permit2 = permit2_;
        ledger = ledger_;
        registry = registry_;
        settlers = settlers_;
        guardian = guardian_;
        lastSettledHour = HourMath.hourOf(block.timestamp) - 1;
    }

    function setPeers(address windowMarket_, address feeSplitter_, address x402Escrow_, address channelManager_)
        external
        onlyOwner
    {
        windowMarket = IWindowMarket(_once(address(windowMarket), windowMarket_));
        feeSplitter = IFeeSplitter(_once(address(feeSplitter), feeSplitter_));
        x402Escrow = _once(x402Escrow, x402Escrow_);
        channelManager = _once(channelManager, channelManager_);
    }

    /// Peers arrive with their launch phase. Each can be set once; zero leaves a slot for later.
    function _once(address current, address next) private pure returns (address) {
        if (next == address(0)) return current;
        if (current != address(0)) revert AlreadySet();
        return next;
    }

    function deposit(uint256 amount) external nonReentrant {
        _credit(msg.sender, amount);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    function depositWithPermit2(ISignatureTransfer.PermitTransferFrom calldata p, bytes calldata sig) external nonReentrant {
        if (p.permitted.token != address(usdg)) revert WrongToken(p.permitted.token);
        _credit(msg.sender, p.permitted.amount);
        permit2.permitTransferFrom(
            p,
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: p.permitted.amount}),
            msg.sender,
            sig
        );
    }

    function setCaps(uint128 hourlyCap, uint128 dailyCap) external {
        Buyer storage b = _buyers[msg.sender];
        _foldCaps(msg.sender, b);
        uint128 targetDaily = dailyCap == 0 ? 4 * hourlyCap : dailyCap;
        bool hourlyDown = hourlyCap < b.hourlyCap;
        bool dailyDown = targetDaily < b.dailyCap;
        uint128 nextHourly = hourlyDown ? b.hourlyCap : hourlyCap;
        uint128 nextDaily = dailyDown ? b.dailyCap : targetDaily;
        bool raised = nextHourly != b.hourlyCap || nextDaily != b.dailyCap;
        b.hourlyCap = nextHourly;
        b.dailyCap = nextDaily;

        if (hourlyDown || dailyDown) {
            uint64 effectiveAfter = HourMath.hourOf(block.timestamp);
            b.pendingHourlyCap = hourlyCap;
            b.pendingDailyCap = targetDaily;
            b.capsEffectiveAfterHour = effectiveAfter;
            if (raised) emit CapsChanged(msg.sender, nextHourly, nextDaily);
            emit CapsChangeRequested(msg.sender, hourlyCap, targetDaily, effectiveAfter);
        } else {
            b.pendingHourlyCap = 0;
            b.pendingDailyCap = 0;
            b.capsEffectiveAfterHour = 0;
            emit CapsChanged(msg.sender, nextHourly, nextDaily);
        }
    }
