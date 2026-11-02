// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IUsageLedger} from "./interfaces/IUsageLedger.sol";
import "./interfaces/OffpeakTypes.sol";
import {Typehashes} from "./lib/Typehashes.sol";

contract UsageLedger is IUsageLedger, EIP712, Ownable2Step {
    error AlreadySet();
    error NotVault(address caller);
    error RootAlreadyPosted(uint64 hour);
    error RootRecordsMismatch(bytes32 root, uint32 records);

    struct PostedRoot {
        bytes32 root;
        bytes32 totalsHash;
        uint32 records;
        uint64 postedAt;
    }

    address public vault;
    address public routerSigner;
    mapping(uint64 => PostedRoot) internal _roots;

    constructor(address owner_, address routerSigner_) EIP712("OffpeakUsage", "1") Ownable(owner_) {
        routerSigner = routerSigner_;
    }

    function setVault(address vault_) external onlyOwner {
        if (vault != address(0)) revert AlreadySet();
        vault = vault_;
        emit VaultSet(vault_);
    }

    function setRouterSigner(address next) external onlyOwner {
        emit RouterSignerChanged(routerSigner, next);
        routerSigner = next;
    }

    function postRoot(uint64 hour, bytes32 root, bytes32 totalsHash, uint32 records) external {
        if (msg.sender != vault) revert NotVault(msg.sender);
        if (_roots[hour].postedAt != 0) revert RootAlreadyPosted(hour);
        if ((root == bytes32(0)) != (records == 0)) revert RootRecordsMismatch(root, records);
        _roots[hour] = PostedRoot(root, totalsHash, records, uint64(block.timestamp));
        emit RootPosted(hour, root, totalsHash, records);
    }

    function rootOf(uint64 hour) external view returns (bytes32 root, bytes32 totalsHash) {
        PostedRoot storage posted = _roots[hour];
        return (posted.root, posted.totalsHash);
    }

    function verifyLeaf(uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _roots[hour].root;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }

    function usageDigest(UsageRecord calldata r) external view returns (bytes32) {
        return _hashTypedDataV4(Typehashes.hash(r));
    }

    function leafOf(UsageRecord calldata r, bytes calldata routerSig, bytes calldata hostSig)
        external
        view
        returns (bytes32)
    {
        return Typehashes.usageLeaf(Typehashes.hash(r), routerSig, hostSig);
    }
}
