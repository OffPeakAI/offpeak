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

    function test_priceSheet() public view {
        PriceSheet memory s;
        s.host = json.readAddress(".priceSheet.host");
        s.modelDigest = json.readBytes32(".priceSheet.modelDigest");
        for (uint64 i; i < 168; ++i) {
            s.baseIn[i] = uint64(json.readUint(".priceSheet.baseIn0")) + i * 100;
            s.baseOut[i] = uint64(json.readUint(".priceSheet.baseOut0")) + i * 100;
        }
        s.floorIn = uint64(json.readUint(".priceSheet.floorIn"));
        s.floorOut = uint64(json.readUint(".priceSheet.floorOut"));
        s.validFrom = uint64(json.readUint(".priceSheet.validFrom"));
        s.nonce = uint64(json.readUint(".priceSheet.nonce"));

        bytes32 structHash = Typehashes.hash(s);
        assertEq(structHash, json.readBytes32(".priceSheet.structHash"));
        bytes32 separator = _separator("OffpeakPriceSheet", json.readAddress(".addresses.contracts.HostRegistry"));
        bytes32 digest = _digest(separator, structHash);
        assertEq(digest, json.readBytes32(".priceSheet.hash"));
        assertEq(ECDSA.recover(digest, json.readBytes(".priceSheet.signature")), s.host);
    }

    function test_ruling() public view {
        Ruling memory r = Ruling({
            challengeId: json.readUint(".ruling.challengeId"),
            outcome: uint8(json.readUint(".ruling.outcome")),
            slashBps: uint16(json.readUint(".ruling.slashBps")),
            refundRoot: json.readBytes32(".ruling.refundRoot"),
            reasonHash: json.readBytes32(".ruling.reasonHash")
        });
        bytes32 separator = _separator("OffpeakAudit", json.readAddress(".addresses.contracts.AuditCourt"));
        bytes32 digest = _digest(separator, Typehashes.hash(r));
        this.verifyThreshold(_set(".addresses.rulings"), digest, json.readBytes(".ruling.thresholdSig"));
    }

    function test_permit2WitnessStrings() public view {
        assertEq(json.readString(".permit2.uptoWitnessType"), Typehashes.UPTO_WITNESS_TYPESTRING);
        assertEq(json.readString(".permit2.exactWitnessType"), Typehashes.EXACT_WITNESS_TYPESTRING);
        assertEq(json.readString(".permit2.channelWitnessType"), Typehashes.CHANNEL_WITNESS_TYPESTRING);
    }

    function test_permit2UptoDigest() public view {
        UptoWitness memory w = UptoWitness({
            reqId: keccak256("upto-req"),
            payee: json.readAddress(".addresses.contracts.OffpeakVault"),
            maxAmount: 50_000,
            validBefore: 1_800_000_000,
            resourceHash: keccak256("resource")
        });
        ISignatureTransfer.PermitTransferFrom memory p = _permit(50_000, 1);
        bytes32 structHash = _permitHash(p, Typehashes.hash(w), Typehashes.UPTO_WITNESS_TYPESTRING);
        assertEq(structHash, json.readBytes32(".permit2.uptoStruct"));
        assertEq(_digest(_permit2Separator(), structHash), json.readBytes32(".permit2.uptoDigest"));
    }

    function test_permit2ExactDigest() public view {
        ExactWitness memory w = ExactWitness({
            reqId: keccak256("exact-req"),
            payee: json.readAddress(".addresses.contracts.OffpeakVault"),
            amount: 10_000,
            validBefore: 1_800_000_000,
            resourceHash: keccak256("resource-exact")
        });
        ISignatureTransfer.PermitTransferFrom memory p = _permit(10_000, 2);
        bytes32 structHash = _permitHash(p, Typehashes.hash(w), Typehashes.EXACT_WITNESS_TYPESTRING);
        assertEq(structHash, json.readBytes32(".permit2.exactStruct"));
        assertEq(_digest(_permit2Separator(), structHash), json.readBytes32(".permit2.exactDigest"));
    }

    function test_etchedPermit2MatchesTheVectorDomain() public {
        vm.chainId(CHAIN_ID);
        vm.etch(PERMIT2, vm.parseBytes(vm.trim(vm.readFile("test/fixtures/permit2.bin"))));
        assertEq(ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), _permit2Separator());
    }

    function verifyThreshold(address[3] calldata signers, bytes32 digest, bytes calldata sig) external pure {
        ThresholdSig.verify2of3(signers, digest, sig);
    }

    function _usageRecord(string memory at) private view returns (UsageRecord memory r) {
        r.reqId = json.readBytes32(string.concat(at, ".record.reqId"));
        r.buyerRef = json.readBytes32(string.concat(at, ".record.buyerRef"));
        r.host = json.readAddress(string.concat(at, ".record.host"));
        r.modelDigest = json.readBytes32(string.concat(at, ".record.modelDigest"));
        r.tokensIn = uint32(json.readUint(string.concat(at, ".record.tokensIn")));
        r.tokensOut = uint32(json.readUint(string.concat(at, ".record.tokensOut")));
        r.promptHash = json.readBytes32(string.concat(at, ".record.promptHash"));
        r.outputHash = json.readBytes32(string.concat(at, ".record.outputHash"));
        r.priceIn = uint64(json.readUint(string.concat(at, ".record.priceIn")));
        r.priceOut = uint64(json.readUint(string.concat(at, ".record.priceOut")));
        r.hostCostMicro = uint64(json.readUint(string.concat(at, ".record.hostCostMicro")));
        r.feeMicro = uint64(json.readUint(string.concat(at, ".record.feeMicro")));
        r.payMode = uint8(json.readUint(string.concat(at, ".record.payMode")));
        r.payRef = json.readBytes32(string.concat(at, ".record.payRef"));
        r.ts = uint64(json.readUint(string.concat(at, ".record.ts")));
        r.sheetHash = json.readBytes32(string.concat(at, ".record.sheetHash"));
    }

    function _totals() private view returns (RootTotals memory) {
        return RootTotals({
            records: uint32(json.readUint(".hourClose.totals.records")),
            tokensIn: uint64(json.readUint(".hourClose.totals.tokensIn")),
            tokensOut: uint64(json.readUint(".hourClose.totals.tokensOut")),
            prepaidDebit: uint128(json.readUint(".hourClose.totals.prepaidDebit")),
            agentCollected: uint128(json.readUint(".hourClose.totals.agentCollected")),
            windowDrawn: uint128(json.readUint(".hourClose.totals.windowDrawn")),
            hostCredit: uint128(json.readUint(".hourClose.totals.hostCredit")),
            fees: uint128(json.readUint(".hourClose.totals.fees"))
        });
    }

    function _prepaidTs() private view returns (uint64) {
        for (uint256 i; i < 5; ++i) {
            string memory at = string.concat(".usage[", vm.toString(i), "].record");
            if (json.readUint(string.concat(at, ".payMode")) == 0) return uint64(json.readUint(string.concat(at, ".ts")));
        }
        revert("no prepaid record");
    }

    function _set(string memory key) private view returns (address[3] memory set) {
        address[] memory members = json.readAddressArray(key);
        assertEq(members.length, 3);
        set = [members[0], members[1], members[2]];
    }

    function _permit(uint256 amount, uint256 nonce) private view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: json.readAddress(".addresses.contracts.MockUSDG"), amount: amount}),
            nonce: nonce,
            deadline: 1_800_000_000
        });
    }

    function _permitHash(ISignatureTransfer.PermitTransferFrom memory p, bytes32 witness, string memory witnessType)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256(abi.encodePacked(PERMIT_WITNESS_STUB, witnessType)),
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                json.readAddress(".addresses.contracts.X402Escrow"),
                p.nonce,
                p.deadline,
                witness
            )
        );
    }

    function _separator(string memory name, address verifyingContract) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), CHAIN_ID, verifyingContract));
    }

    function _permit2Separator() private pure returns (bytes32) {
        return keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), CHAIN_ID, PERMIT2));
    }

    function _digest(bytes32 separator, bytes32 structHash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }
}
