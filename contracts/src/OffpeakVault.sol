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
        emit PeersSet(address(windowMarket), address(feeSplitter), x402Escrow, channelManager);
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

    function withdraw(uint256 amount) external nonReentrant {
        Buyer storage b = _buyers[msg.sender];
        _foldCaps(msg.sender, b);
        uint256 available = b.balance - _reserveOf(b);
        if (amount > available) revert WithdrawExceedsAvailable(amount, available);
        b.balance -= amount;
        emit Withdrawn(msg.sender, amount, b.balance);
        usdg.safeTransfer(msg.sender, amount);
    }

    function requestWithdrawAll() external {
        Buyer storage b = _buyers[msg.sender];
        if (b.withdrawRequestedAt != 0) revert WithdrawAlreadyRequested(msg.sender);
        uint64 requestedAt = uint64(block.timestamp);
        b.withdrawRequestedAt = requestedAt;
        emit WithdrawAllRequested(msg.sender, requestedAt, requestedAt + uint64(WITHDRAW_ALL_MAX_DELAY));
    }

    function cancelWithdrawAll() external {
        Buyer storage b = _buyers[msg.sender];
        if (b.withdrawRequestedAt == 0) revert NoWithdrawRequest(msg.sender);
        b.withdrawRequestedAt = 0;
        emit WithdrawAllCancelled(msg.sender);
    }

    function executeWithdrawAll(address buyer) external nonReentrant {
        Buyer storage b = _buyers[buyer];
        uint64 requestedAt = b.withdrawRequestedAt;
        if (requestedAt == 0) revert NoWithdrawRequest(buyer);
        uint64 dueAt = requestedAt + uint64(WITHDRAW_ALL_MAX_DELAY);
        if (block.timestamp < dueAt && lastSettledHour < HourMath.hourOf(requestedAt)) {
            revert WithdrawNotDue(buyer, dueAt);
        }
        uint256 amount = b.balance;
        b.balance = 0;
        b.withdrawRequestedAt = 0;
        emit WithdrawAllExecuted(buyer, amount);
        usdg.safeTransfer(buyer, amount);
    }

    function settle(SettleBatch calldata b, RootTotals calldata t, bytes calldata thresholdSig) external nonReentrant {
        _checkBatch(b, t, thresholdSig);
        (uint256 credited, Credit[] memory credits) = _sumCredits(b.credits);
        uint256 inflow = uint256(t.prepaidDebit) + b.agentPoolDraw + b.reserveDraw;
        if (inflow != credited + b.fees) revert ConservationBroken(inflow, credited + b.fees);

        (uint256 taken, uint256 shortfall) = _applyDebits(b.debits, b.hour, t.prepaidDebit);
        if (agentPool < b.agentPoolDraw) revert InsufficientAgentPool(agentPool, b.agentPoolDraw);
        if (protocolReserve < b.reserveDraw) revert InsufficientProtocolReserve(protocolReserve, b.reserveDraw);
        agentPool -= b.agentPoolDraw;
        protocolReserve -= b.reserveDraw;

        uint256 fees = b.fees;
        if (shortfall > 0) (credited, fees) = _coverShortfall(b.hour, shortfall, credits, credited, fees);
        lastSettledHour = b.hour;

        ledger.postRoot(b.hour, b.root, b.totalsHash, t.records);
        if (credited > 0) {
            usdg.safeTransfer(address(registry), credited);
            registry.accrueCredits(b.hour, credits);
        }
        if (fees > 0) {
            usdg.safeTransfer(address(feeSplitter), fees);
            feeSplitter.notify(fees);
        }
        if (b.windowDraws.length > 0) windowMarket.applyDraws(b.hour, b.windowDraws);
        emit Settled(b.hour, b.root, b.totalsHash, uint128(taken), uint128(credited), uint128(fees));
    }

    function refund(RefundBatch calldata r, bytes calldata thresholdSig) external nonReentrant {
        if (settlesPaused) revert SettlesPaused();
        if (r.refunds.length > MAX_REFUNDS) revert BatchTooLarge(r.refunds.length, MAX_REFUNDS);
        ThresholdSig.verify2of3(settlers, _hashTypedDataV4(Typehashes.hash(r)), thresholdSig);
        for (uint256 i; i < r.refunds.length; ++i) {
            Refund calldata item = r.refunds[i];
            if (refundPaid[item.refundId]) revert RefundAlreadyPaid(item.refundId);
            if (protocolReserve < item.amount) revert InsufficientProtocolReserve(protocolReserve, item.amount);
            refundPaid[item.refundId] = true;
            protocolReserve -= item.amount;
            _buyers[item.payer].balance += item.amount;
            emit Refunded(item.payer, item.amount, item.refundId);
        }
    }

    /// The caller has already transferred `amount` of USDG to this contract.
    function creditAgentPool(uint256 amount, bytes32 paymentId) external {
        if (msg.sender != x402Escrow && msg.sender != channelManager) revert NotAgentPayer(msg.sender);
        agentPool += amount;
        emit AgentPoolCredited(paymentId, amount);
    }

    function fundReserve(uint256 amount) external nonReentrant {
        protocolReserve += amount;
        emit ReserveFunded(msg.sender, amount, protocolReserve);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    function setUsagePaused(bool paused) external onlyGuardian {
        usagePaused = paused;
        emit Paused(usagePaused, settlesPaused);
    }

    function setSettlesPaused(bool paused) external onlyGuardian {
        settlesPaused = paused;
        emit Paused(usagePaused, settlesPaused);
    }

    function setSettlers(address[3] calldata next) external onlyOwner {
        _requireSorted(next);
        emit SignersChanged(settlers, next);
        settlers = next;
    }

    function setGuardian(address next) external onlyOwner {
        emit GuardianChanged(guardian, next);
        guardian = next;
    }

    function disableBetaCap() external onlyOwner {
        betaCapEnabled = false;
        emit BetaCapDisabled();
    }

    function reserveOf(address buyer) external view returns (uint256) {
        return _reserveOf(_buyers[buyer]);
    }

    function effectiveCaps(address buyer, uint64 hour) external view returns (uint128 hourlyCap, uint128 dailyCap) {
        return _effectiveCaps(_buyers[buyer], hour);
    }

    function dayDebit(address buyer) external view returns (uint64 day, uint128 debited) {
        Buyer storage b = _buyers[buyer];
        return (b.lastDebitDay, b.debitedToday);
    }

    function buyerState(address buyer) external view returns (BuyerView memory v) {
        Buyer storage b = _buyers[buyer];
        (uint128 hourlyCap, uint128 dailyCap) = _capsNow(b);
        bool decreasePending = b.capsEffectiveAfterHour != 0 && lastSettledHour < b.capsEffectiveAfterHour;
        v.balance = b.balance;
        v.reserve = _reserveOf(b);
        v.hourlyCap = hourlyCap;
        v.dailyCap = dailyCap;
        if (decreasePending) {
            v.pendingHourlyCap = b.pendingHourlyCap;
            v.pendingDailyCap = b.pendingDailyCap;
            v.capsEffectiveAfterHour = b.capsEffectiveAfterHour;
        }
        v.withdrawRequestedAt = b.withdrawRequestedAt;
        if (b.withdrawRequestedAt != 0) v.withdrawDueAt = b.withdrawRequestedAt + uint64(WITHDRAW_ALL_MAX_DELAY);
        v.lastSettledHour = lastSettledHour;
        v.usagePaused = usagePaused;
    }

    function _credit(address buyer, uint256 amount) private {
        Buyer storage b = _buyers[buyer];
        if (b.withdrawRequestedAt != 0) revert WithdrawPending(buyer);
        _foldCaps(buyer, b);
        b.balance += amount;
        if (betaCapEnabled && b.balance > BETA_CAP) revert BetaCapExceeded(buyer, b.balance);
        emit Deposited(buyer, amount, b.balance);
    }

    function _checkBatch(SettleBatch calldata b, RootTotals calldata t, bytes calldata thresholdSig) private view {
        if (settlesPaused) revert SettlesPaused();
        if (b.chainId != block.chainid || b.vault != address(this)) revert WrongBatchTarget();
        uint64 expected = lastSettledHour + 1;
        if (b.hour != expected) revert WrongHour(b.hour, expected);
        uint256 readyAt = HourMath.hourEnd(b.hour) + HOUR_CLOSE_GRACE;
        if (block.timestamp < readyAt) revert HourNotReady(b.hour, readyAt);
        if (b.debits.length > MAX_DEBITS) revert BatchTooLarge(b.debits.length, MAX_DEBITS);
        if (b.credits.length > MAX_CREDITS) revert BatchTooLarge(b.credits.length, MAX_CREDITS);
        if (b.windowDraws.length > MAX_WINDOW_DRAWS) revert BatchTooLarge(b.windowDraws.length, MAX_WINDOW_DRAWS);
        ThresholdSig.verify2of3(settlers, _hashTypedDataV4(Typehashes.hash(b)), thresholdSig);
        bytes32 totalsHash = Typehashes.hash(t);
        if (totalsHash != b.totalsHash) revert TotalsHashMismatch(b.totalsHash, totalsHash);
    }

    function _sumCredits(Credit[] calldata list) private pure returns (uint256 total, Credit[] memory credits) {
        credits = list;
        address previous;
        for (uint256 i; i < credits.length; ++i) {
            if (credits[i].host <= previous) revert NotSorted();
            previous = credits[i].host;
            total += credits[i].amount;
        }
    }

    function _applyDebits(Debit[] calldata debits, uint64 hour, uint128 prepaidDebit)
        private
        returns (uint256 taken, uint256 shortfall)
    {
        uint256 requested;
        address previous;
        for (uint256 i; i < debits.length; ++i) {
            Debit calldata d = debits[i];
            if (d.buyer <= previous) revert NotSorted();
            previous = d.buyer;
            requested += d.amount;
            uint128 debited = _applyDebit(d, hour);
            taken += debited;
            shortfall += d.amount - debited;
        }
        if (requested != prepaidDebit) revert DebitTotalMismatch(requested, prepaidDebit);
    }

    function _applyDebit(Debit calldata d, uint64 hour) private returns (uint128 debited) {
        if (d.amount == 0) revert ZeroDebit(d.buyer);
        if (HourMath.hourOf(d.lastTs) != hour) revert DebitOutsideHour(d.buyer, d.lastTs, hour);
        Buyer storage b = _buyers[d.buyer];
        uint64 requestedAt = b.withdrawRequestedAt;
        if (requestedAt != 0 && d.lastTs > requestedAt) revert DebitAfterRequest(d.buyer, d.lastTs, requestedAt);

        _foldCaps(d.buyer, b);
        (uint128 hourlyCap, uint128 dailyCap) = _effectiveCaps(b, hour);
        if (d.amount > hourlyCap) revert CapExceeded(d.buyer, hour, d.amount, hourlyCap);
        uint64 day = HourMath.dayOf(hour);
        if (b.lastDebitDay != day) {
            b.lastDebitDay = day;
            b.debitedToday = 0;
        }
        b.debitedToday += d.amount;
        if (b.debitedToday > dailyCap) revert DailyCapExceeded(d.buyer, day, b.debitedToday, dailyCap);

        debited = d.amount;
        if (d.amount > b.balance) {
            debited = uint128(b.balance);
            emit DebitClamped(hour, d.buyer, d.amount, debited);
        }
        b.balance -= debited;
        emit Debited(hour, d.buyer, d.amount, debited, b.balance);
    }

    /// Fees absorb a shortfall first, then the reserve, then every credit pro rata with dust left in the reserve.
    function _coverShortfall(uint64 hour, uint256 shortfall, Credit[] memory credits, uint256 credited, uint256 fees)
        private
        returns (uint256, uint256)
    {
        uint256 fromFees = shortfall < fees ? shortfall : fees;
        fees -= fromFees;
        uint256 left = shortfall - fromFees;
        uint256 fromReserve = left < protocolReserve ? left : protocolReserve;
        protocolReserve -= fromReserve;
        left -= fromReserve;
        if (left == 0) return (credited, fees);

        uint256 remaining = credited - left;
        uint256 paid;
        for (uint256 i; i < credits.length; ++i) {
            credits[i].amount = uint128(uint256(credits[i].amount) * remaining / credited);
            paid += credits[i].amount;
        }
        protocolReserve += remaining - paid;
        emit CreditShortfall(hour, uint128(left));
        return (paid, fees);
    }

    function _foldCaps(address buyer, Buyer storage b) private {
        uint64 effectiveAfter = b.capsEffectiveAfterHour;
        if (effectiveAfter == 0 || lastSettledHour < effectiveAfter) return;
        b.hourlyCap = b.pendingHourlyCap;
        b.dailyCap = b.pendingDailyCap;
        b.pendingHourlyCap = 0;
        b.pendingDailyCap = 0;
        b.capsEffectiveAfterHour = 0;
        emit CapsChanged(buyer, b.hourlyCap, b.dailyCap);
    }

    function _capsNow(Buyer storage b) private view returns (uint128, uint128) {
        return _effectiveCaps(b, lastSettledHour + 1);
    }

    function _effectiveCaps(Buyer storage b, uint64 hour) private view returns (uint128, uint128) {
        uint64 effectiveAfter = b.capsEffectiveAfterHour;
        if (effectiveAfter != 0 && hour > effectiveAfter) return (b.pendingHourlyCap, b.pendingDailyCap);
        return (b.hourlyCap, b.dailyCap);
    }

    function _reserveOf(Buyer storage b) private view returns (uint256) {
        if (b.balance == 0) return 0;
        uint64 lastHour =
            HourMath.hourOf(b.withdrawRequestedAt != 0 ? b.withdrawRequestedAt : block.timestamp);
        if (lastHour <= lastSettledHour) return 0;
        uint256 openHours = lastHour - lastSettledHour;
        // Counted by UTC day touched: two open hours around midnight can each spend a full daily cap.
        uint256 openDays = HourMath.dayOf(lastHour) - HourMath.dayOf(lastSettledHour + 1) + 1;
        (uint128 hourlyCap, uint128 dailyCap) = _capsNow(b);
        uint256 byHour = uint256(hourlyCap) * openHours;
        uint256 byDay = uint256(dailyCap) * openDays;
        uint256 reserve = byHour < byDay ? byHour : byDay;
        return reserve < b.balance ? reserve : b.balance;
    }

    function _requireSorted(address[3] memory set) private pure {
        if (set[0] == address(0) || set[0] >= set[1] || set[1] >= set[2]) revert UnsortedSigners();
    }
}
