// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISignatureTransfer} from "./ISignatureTransfer.sol";

struct UsageRecord {
    bytes32 reqId;
    bytes32 buyerRef;
    address host;
    bytes32 modelDigest;
    uint32 tokensIn;
    uint32 tokensOut;
    bytes32 promptHash;
    bytes32 outputHash;
    uint64 priceIn;
    uint64 priceOut;
    uint64 hostCostMicro;
    uint64 feeMicro;
    uint8 payMode;
    bytes32 payRef;
    uint64 ts;
    bytes32 sheetHash;
}

struct HourClose {
    uint64 hour;
    uint32 records;
    bytes32 root;
    bytes32 totalsHash;
}

struct RootTotals {
    uint32 records;
    uint64 tokensIn;
    uint64 tokensOut;
    uint128 prepaidDebit;
    uint128 agentCollected;
    uint128 windowDrawn;
    uint128 hostCredit;
    uint128 fees;
}

struct Debit {
    address buyer;
    uint128 amount;
    uint64 lastTs;
}

struct Credit {
    address host;
    uint128 amount;
}

struct WindowDraw {
    uint256 windowId;
    address holder;
    uint64 tokens;
}

struct SettleBatch {
    uint256 chainId;
    address vault;
    uint64 hour;
    bytes32 root;
    bytes32 totalsHash;
    Debit[] debits;
    Credit[] credits;
    WindowDraw[] windowDraws;
    uint128 fees;
    uint128 agentPoolDraw;
    uint128 reserveDraw;
    bytes32 agentPaymentsHash;
}

struct Refund {
    address payer;
    uint128 amount;
    bytes32 refundId;
}

struct RefundBatch {
    uint64 batchId;
    Refund[] refunds;
}

struct RewardBatch {
    uint64 week;
    Credit[] credits;
}

struct Voucher {
    bytes32 channelId;
    uint64 seq;
    uint128 cumulative;
}

struct CooperativeClose {
    bytes32 channelId;
    uint128 finalCumulative;
    uint64 deadline;
}

struct PriceSheet {
    address host;
    bytes32 modelDigest;
    uint64[168] baseIn;
    uint64[168] baseOut;
    uint64 floorIn;
    uint64 floorOut;
    uint64 validFrom;
    uint64 nonce;
}

struct Ruling {
    uint256 challengeId;
    uint8 outcome;
    uint16 slashBps;
    bytes32 refundRoot;
    bytes32 reasonHash;
}

struct PanelDecision {
    uint256 challengeId;
    uint8 decision;
    uint16 finalSlashBps;
    bytes32 refundRoot;
    bytes32 reasonHash;
}
