// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./OffpeakTypes.sol";

interface IUsageLedger {
    event RootPosted(uint64 indexed hour, bytes32 root, bytes32 totalsHash, uint32 records);
    event RouterSignerChanged(address oldSigner, address newSigner);
    event VaultSet(address vault);

    function postRoot(uint64 hour, bytes32 root, bytes32 totalsHash, uint32 records) external;
    function rootOf(uint64 hour) external view returns (bytes32 root, bytes32 totalsHash);
    function verifyLeaf(uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool);
    function usageDigest(UsageRecord calldata r) external view returns (bytes32);
    function leafOf(UsageRecord calldata r, bytes calldata routerSig, bytes calldata hostSig)
        external
        view
        returns (bytes32);
}
