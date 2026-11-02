// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./OffpeakTypes.sol";

interface IFeeSplitter {
    event FeesNotified(uint256 amount);
    event FeesDistributed(uint256 ops, uint256 treasury, uint256 hostRewards, uint256 burn);
    event RewardsDistributed(uint64 indexed week, uint256 total);
    event BurnExecuted(uint256 usdgIn, uint256 ofpkBurned);
    event TokenHooksChanged(bool enabled);
    event SwapAdapterChanged(address adapter);
    event BurnKeeperChanged(address keeper);
    event PeersSet(address vault, address windowMarket);

    function tokenHooksEnabled() external view returns (bool);
    function notify(uint256 amount) external;
    function distribute() external;
    function distributeRewards(RewardBatch calldata r, bytes calldata thresholdSig) external;
    function executeBurn(uint256 minOut) external;
}
