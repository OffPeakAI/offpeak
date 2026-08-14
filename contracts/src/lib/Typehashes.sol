// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/OffpeakTypes.sol";

/// @notice EIP-712 struct hashes for the types in the interface contract, section 3.3.
library Typehashes {
    bytes32 internal constant USAGE_RECORD_TYPEHASH = keccak256(
        "UsageRecord(bytes32 reqId,bytes32 buyerRef,address host,bytes32 modelDigest,uint32 tokensIn,uint32 tokensOut,bytes32 promptHash,bytes32 outputHash,uint64 priceIn,uint64 priceOut,uint64 hostCostMicro,uint64 feeMicro,uint8 payMode,bytes32 payRef,uint64 ts,bytes32 sheetHash)"
    );
    bytes32 internal constant HOUR_CLOSE_TYPEHASH =
        keccak256("HourClose(uint64 hour,uint32 records,bytes32 root,bytes32 totalsHash)");
    bytes32 internal constant SETTLE_BATCH_TYPEHASH = keccak256(
        "SettleBatch(uint256 chainId,address vault,uint64 hour,bytes32 root,bytes32 totalsHash,Debit[] debits,Credit[] credits,WindowDraw[] windowDraws,uint128 fees,uint128 agentPoolDraw,uint128 reserveDraw,bytes32 agentPaymentsHash)Credit(address host,uint128 amount)Debit(address buyer,uint128 amount,uint64 lastTs)WindowDraw(uint256 windowId,address holder,uint64 tokens)"
    );
    bytes32 internal constant DEBIT_TYPEHASH = keccak256("Debit(address buyer,uint128 amount,uint64 lastTs)");
    bytes32 internal constant CREDIT_TYPEHASH = keccak256("Credit(address host,uint128 amount)");
    bytes32 internal constant WINDOW_DRAW_TYPEHASH =
        keccak256("WindowDraw(uint256 windowId,address holder,uint64 tokens)");
    bytes32 internal constant REFUND_BATCH_TYPEHASH =
        keccak256("RefundBatch(uint64 batchId,Refund[] refunds)Refund(address payer,uint128 amount,bytes32 refundId)");
    bytes32 internal constant REFUND_TYPEHASH = keccak256("Refund(address payer,uint128 amount,bytes32 refundId)");
    bytes32 internal constant REWARD_BATCH_TYPEHASH =
        keccak256("RewardBatch(uint64 week,Credit[] credits)Credit(address host,uint128 amount)");
    bytes32 internal constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint64 seq,uint128 cumulative)");
    bytes32 internal constant COOPERATIVE_CLOSE_TYPEHASH =
        keccak256("CooperativeClose(bytes32 channelId,uint128 finalCumulative,uint64 deadline)");
    bytes32 internal constant PRICE_SHEET_TYPEHASH = keccak256(
        "PriceSheet(address host,bytes32 modelDigest,uint64[168] baseIn,uint64[168] baseOut,uint64 floorIn,uint64 floorOut,uint64 validFrom,uint64 nonce)"
    );
    bytes32 internal constant RULING_TYPEHASH = keccak256(
        "Ruling(uint256 challengeId,uint8 outcome,uint16 slashBps,bytes32 refundRoot,bytes32 reasonHash)"
    );
    bytes32 internal constant PANEL_DECISION_TYPEHASH = keccak256(
        "PanelDecision(uint256 challengeId,uint8 decision,uint16 finalSlashBps,bytes32 refundRoot,bytes32 reasonHash)"
    );
    bytes32 internal constant WINDOW_PERFORMANCE_TYPEHASH = keccak256(
        "WindowPerformance(uint256 windowId,uint32 measuredSeconds,uint32 belowMinSeconds,bytes32 evidenceRoot)"
    );
    bytes32 internal constant UPTO_WITNESS_TYPEHASH = keccak256(
        "UptoWitness(bytes32 reqId,address payee,uint256 maxAmount,uint64 validBefore,bytes32 resourceHash)"
    );
    bytes32 internal constant EXACT_WITNESS_TYPEHASH = keccak256(
        "ExactWitness(bytes32 reqId,address payee,uint256 amount,uint64 validBefore,bytes32 resourceHash)"
    );
    bytes32 internal constant CHANNEL_OPEN_WITNESS_TYPEHASH =
        keccak256("ChannelOpenWitness(bytes32 channelSalt,address payee,uint64 expiry)");

    string internal constant UPTO_WITNESS_TYPESTRING =
        "UptoWitness witness)TokenPermissions(address token,uint256 amount)UptoWitness(bytes32 reqId,address payee,uint256 maxAmount,uint64 validBefore,bytes32 resourceHash)";
    string internal constant EXACT_WITNESS_TYPESTRING =
        "ExactWitness witness)ExactWitness(bytes32 reqId,address payee,uint256 amount,uint64 validBefore,bytes32 resourceHash)TokenPermissions(address token,uint256 amount)";
    string internal constant CHANNEL_WITNESS_TYPESTRING =
        "ChannelOpenWitness witness)ChannelOpenWitness(bytes32 channelSalt,address payee,uint64 expiry)TokenPermissions(address token,uint256 amount)";

    function hash(UsageRecord memory r) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    USAGE_RECORD_TYPEHASH, r.reqId, r.buyerRef, r.host, r.modelDigest, r.tokensIn, r.tokensOut, r.promptHash
                ),
                abi.encode(
                    r.outputHash, r.priceIn, r.priceOut, r.hostCostMicro, r.feeMicro, r.payMode, r.payRef, r.ts, r.sheetHash
                )
            )
        );
    }

    function hash(HourClose memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(HOUR_CLOSE_TYPEHASH, c.hour, c.records, c.root, c.totalsHash));
    }

    function hash(RootTotals memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t));
    }

    function hash(SettleBatch memory b) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(SETTLE_BATCH_TYPEHASH, b.chainId, b.vault, b.hour, b.root, b.totalsHash),
                abi.encode(hash(b.debits), hash(b.credits), hash(b.windowDraws)),
                abi.encode(b.fees, b.agentPoolDraw, b.reserveDraw, b.agentPaymentsHash)
            )
        );
    }

    function hash(Debit[] memory debits) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](debits.length);
        for (uint256 i; i < debits.length; ++i) {
            hashes[i] = keccak256(abi.encode(DEBIT_TYPEHASH, debits[i].buyer, debits[i].amount, debits[i].lastTs));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hash(Credit[] memory credits) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](credits.length);
        for (uint256 i; i < credits.length; ++i) {
            hashes[i] = keccak256(abi.encode(CREDIT_TYPEHASH, credits[i].host, credits[i].amount));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hash(WindowDraw[] memory draws) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](draws.length);
        for (uint256 i; i < draws.length; ++i) {
            hashes[i] = keccak256(abi.encode(WINDOW_DRAW_TYPEHASH, draws[i].windowId, draws[i].holder, draws[i].tokens));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hash(RefundBatch memory r) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](r.refunds.length);
        for (uint256 i; i < r.refunds.length; ++i) {
            Refund memory refund = r.refunds[i];
            hashes[i] = keccak256(abi.encode(REFUND_TYPEHASH, refund.payer, refund.amount, refund.refundId));
        }
        return keccak256(abi.encode(REFUND_BATCH_TYPEHASH, r.batchId, keccak256(abi.encodePacked(hashes))));
    }

    function hash(RewardBatch memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(REWARD_BATCH_TYPEHASH, r.week, hash(r.credits)));
    }

    function hash(Voucher memory v) internal pure returns (bytes32) {
        return keccak256(abi.encode(VOUCHER_TYPEHASH, v.channelId, v.seq, v.cumulative));
    }

    function hash(CooperativeClose memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(COOPERATIVE_CLOSE_TYPEHASH, c.channelId, c.finalCumulative, c.deadline));
    }

    function hash(PriceSheet memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PRICE_SHEET_TYPEHASH,
                s.host,
                s.modelDigest,
                keccak256(abi.encodePacked(s.baseIn)),
                keccak256(abi.encodePacked(s.baseOut)),
                s.floorIn,
                s.floorOut,
                s.validFrom,
                s.nonce
            )
        );
    }

    function hash(Ruling memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(RULING_TYPEHASH, r.challengeId, r.outcome, r.slashBps, r.refundRoot, r.reasonHash));
    }

    function hash(PanelDecision memory d) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(PANEL_DECISION_TYPEHASH, d.challengeId, d.decision, d.finalSlashBps, d.refundRoot, d.reasonHash)
        );
    }

    function hash(WindowPerformance memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(WINDOW_PERFORMANCE_TYPEHASH, p.windowId, p.measuredSeconds, p.belowMinSeconds, p.evidenceRoot)
        );
    }

    function hash(UptoWitness memory w) internal pure returns (bytes32) {
        return keccak256(abi.encode(UPTO_WITNESS_TYPEHASH, w.reqId, w.payee, w.maxAmount, w.validBefore, w.resourceHash));
    }

    function hash(ExactWitness memory w) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXACT_WITNESS_TYPEHASH, w.reqId, w.payee, w.amount, w.validBefore, w.resourceHash));
    }

    function hash(ChannelOpenWitness memory w) internal pure returns (bytes32) {
        return keccak256(abi.encode(CHANNEL_OPEN_WITNESS_TYPEHASH, w.channelSalt, w.payee, w.expiry));
    }

    function usageLeaf(bytes32 usageStructHash, bytes memory routerSig, bytes memory hostSig)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            bytes.concat(keccak256(abi.encode(usageStructHash, keccak256(routerSig), keccak256(hostSig))))
        );
    }

    function agentPaymentsHash(bytes32[] memory paymentIds) internal pure returns (bytes32) {
        return keccak256(abi.encode(paymentIds));
    }
}
