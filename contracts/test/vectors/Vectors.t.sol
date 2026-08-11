// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {ThresholdSig} from "../../src/lib/ThresholdSig.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";

/// @notice Reproduces packages/shared/fixtures/vectors.json byte for byte.
contract VectorsTest is Test {
    using stdJson for string;

    uint256 internal constant CHAIN_ID = 4663;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string internal constant PERMIT_WITNESS_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    string internal json;
    address internal router;
    address internal host;
    address internal buyer;

    function setUp() public {
        json = vm.readFile("../packages/shared/fixtures/vectors.json");
        router = json.readAddress(".addresses.router");
        host = json.readAddress(".addresses.host");
        buyer = json.readAddress(".addresses.buyer");
    }

    function test_usageRecords() public view {
        address ledger = json.readAddress(".addresses.contracts.UsageLedger");
        bytes32 root = json.readBytes32(".merkle.root");
        uint256 records = json.readUint(".hourClose.records");
        assertEq(records, 5);
        for (uint256 i; i < records; ++i) {
            string memory at = string.concat(".usage[", vm.toString(i), "]");
            UsageRecord memory r = _usageRecord(at);
            bytes32 structHash = Typehashes.hash(r);
            assertEq(structHash, json.readBytes32(string.concat(at, ".structHash")));

            bytes memory routerSig = json.readBytes(string.concat(at, ".routerSig"));
            bytes memory hostSig = json.readBytes(string.concat(at, ".hostSig"));
            bytes32 digest = _digest(_separator("OffpeakUsage", ledger), structHash);
            assertEq(ECDSA.recover(digest, routerSig), router);
            assertEq(ECDSA.recover(digest, hostSig), host);

            bytes32 leaf = Typehashes.usageLeaf(structHash, routerSig, hostSig);
            assertEq(leaf, json.readBytes32(string.concat(at, ".leaf")));
            bytes32[] memory proof = json.readBytes32Array(string.concat(".merkle.proofs[", vm.toString(i), "]"));
            assertTrue(MerkleProof.verify(proof, root, leaf));
        }
    }

    function test_hourClose() public view {
        bytes32 totalsHash = Typehashes.hash(_totals());
        assertEq(totalsHash, json.readBytes32(".hourClose.totalsHash"));

        HourClose memory close = HourClose({
            hour: uint64(json.readUint(".hourClose.hour")),
            records: uint32(json.readUint(".hourClose.records")),
            root: json.readBytes32(".hourClose.root"),
            totalsHash: totalsHash
        });
        bytes32 separator = _separator("OffpeakUsage", json.readAddress(".addresses.contracts.UsageLedger"));
        bytes32 digest = _digest(separator, Typehashes.hash(close));
        assertEq(ECDSA.recover(digest, json.readBytes(".hourClose.signature")), router);
    }

    function test_settleBatch() public view {
        RootTotals memory totals = _totals();
        Debit[] memory debits = new Debit[](1);
        debits[0] = Debit({buyer: buyer, amount: totals.prepaidDebit, lastTs: _prepaidTs()});
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({host: host, amount: totals.hostCredit});

        SettleBatch memory batch = SettleBatch({
            chainId: CHAIN_ID,
            vault: json.readAddress(".addresses.contracts.OffpeakVault"),
            hour: uint64(json.readUint(".hourClose.hour")),
            root: json.readBytes32(".hourClose.root"),
            totalsHash: json.readBytes32(".hourClose.totalsHash"),
            debits: debits,
            credits: credits,
            windowDraws: new WindowDraw[](0),
            fees: uint128(json.readUint(".settleBatch.fees")),
            agentPoolDraw: uint128(json.readUint(".settleBatch.agentPoolDraw")),
            reserveDraw: uint128(json.readUint(".settleBatch.reserveDraw")),
            agentPaymentsHash: Typehashes.agentPaymentsHash(new bytes32[](0))
        });
        bytes32 digest = _digest(_separator("OffpeakSettlement", batch.vault), Typehashes.hash(batch));
        this.verifyThreshold(_set(".addresses.settlers"), digest, json.readBytes(".settleBatch.thresholdSig"));
    }

    function test_refundBatch() public view {
        Refund[] memory refunds = new Refund[](1);
        refunds[0] = Refund({
            payer: json.readAddress(".refundBatch.payer"),
            amount: uint128(json.readUint(".refundBatch.amount")),
            refundId: json.readBytes32(".refundBatch.refundId")
        });
        RefundBatch memory batch = RefundBatch({batchId: uint64(json.readUint(".refundBatch.batchId")), refunds: refunds});
        bytes32 structHash = Typehashes.hash(batch);
        assertEq(structHash, json.readBytes32(".refundBatch.structHash"));

        address vault = json.readAddress(".addresses.contracts.OffpeakVault");
        bytes32 digest = _digest(_separator("OffpeakSettlement", vault), structHash);
        this.verifyThreshold(_set(".addresses.settlers"), digest, json.readBytes(".refundBatch.thresholdSig"));
    }

    function test_rewardBatch() public view {
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({host: json.readAddress(".rewardBatch.host"), amount: uint128(json.readUint(".rewardBatch.amount"))});
        RewardBatch memory batch = RewardBatch({week: uint64(json.readUint(".rewardBatch.week")), credits: credits});
        bytes32 structHash = Typehashes.hash(batch);
        assertEq(structHash, json.readBytes32(".rewardBatch.structHash"));

        address vault = json.readAddress(".addresses.contracts.OffpeakVault");
        bytes32 digest = _digest(_separator("OffpeakSettlement", vault), structHash);
        this.verifyThreshold(_set(".addresses.settlers"), digest, json.readBytes(".rewardBatch.thresholdSig"));
    }

    function test_voucher() public view {
        Voucher memory v = Voucher({
            channelId: json.readBytes32(".voucher.channelId"),
            seq: uint64(json.readUint(".voucher.seq")),
            cumulative: uint128(json.readUint(".voucher.cumulative"))
        });
        bytes32 separator = _separator("OffpeakChannel", json.readAddress(".addresses.contracts.ChannelManager"));
        assertEq(ECDSA.recover(_digest(separator, Typehashes.hash(v)), json.readBytes(".voucher.signature")), buyer);
    }
