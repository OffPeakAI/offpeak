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

struct WindowPerformance {
    uint256 windowId;
    uint32 measuredSeconds;
    uint32 belowMinSeconds;
    bytes32 evidenceRoot;
}

struct UptoWitness {
    bytes32 reqId;
    address payee;
    uint256 maxAmount;
    uint64 validBefore;
    bytes32 resourceHash;
}

struct ExactWitness {
    bytes32 reqId;
    address payee;
    uint256 amount;
    uint64 validBefore;
    bytes32 resourceHash;
}

struct ChannelOpenWitness {
    bytes32 channelSalt;
    address payee;
    uint64 expiry;
}

struct AuthorizeCall {
    ISignatureTransfer.PermitTransferFrom p;
    bytes sig;
    address payer;
    UptoWitness w;
}

struct EscrowView {
    address payer;
    uint128 max;
    uint128 captured;
    uint64 validBefore;
    uint8 status;
}

struct BuyerView {
    uint256 balance;
    uint256 reserve;
    uint128 hourlyCap;
    uint128 dailyCap;
    uint128 pendingHourlyCap;
    uint128 pendingDailyCap;
    uint64 capsEffectiveAfterHour;
    uint64 withdrawRequestedAt;
    uint64 withdrawDueAt;
    uint64 lastSettledHour;
    bool usagePaused;
}

struct RegisterParams {
    bytes32[] modelDigests;
    uint32[] maxTps;
    bytes32 imageDigest;
    bytes32 gpuClass;
    bytes32 endpointHash;
    bytes32 attestationRef;
    uint256 bondUsdg;
    uint256 bondOfpk;
}

struct HostView {
    address operator;
    uint8 status;
    uint256 bondUsdg;
    uint256 bondOfpk;
    uint256 requiredBond;
    bytes32 imageDigest;
    bytes32 gpuClass;
    bytes32 attestationRef;
    uint64 probationEnds;
    uint8 strikes;
    uint32 openChallenges;
    uint256 releasableCredits;
    uint256 pendingCredits;
}

struct ChannelView {
    address payer;
    uint256 deposit;
    uint128 claimed;
    uint64 lastSeq;
    uint64 expiry;
    uint64 challengeEndsAt;
    uint8 status;
}

struct WindowParams {
    bytes32 modelDigest;
    uint64 t0;
    uint64 t1;
    uint32 minTps;
    uint64 units;
    uint64 startPricePerUnit;
    uint64 endPricePerUnit;
    uint64 auctionStart;
    uint64 auctionEnd;
}

struct WindowView {
    uint256 id;
    address host;
    bytes32 modelDigest;
    uint64 t0;
    uint64 t1;
    uint32 minTps;
    uint64 units;
    uint256 hostPricePerUnit;
    uint256 buyerPricePerUnit;
    bool failed;
}

struct HolderView {
    uint256 balance;
    uint64 lockedPartial;
    uint64 drawnTokens;
    uint64 costBasis;
}

struct Evidence {
    address host;
    uint8 kind;
    bytes32 modelDigest;
    bytes32 samplesRoot;
    uint32 sampleCount;
    bytes32 testId;
    int256 statistic;
    int256 threshold;
    string uri;
}
