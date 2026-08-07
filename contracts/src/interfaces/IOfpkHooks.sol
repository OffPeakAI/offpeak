// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IOfpkHooks {
    event Locked(address indexed account, uint256 amount, uint256 locked);
    event UnlockRequested(address indexed account, uint256 amount, uint64 availableAt);
    event Unlocked(address indexed account, uint256 amount);

    function lock(uint256 amount) external;
    function requestUnlock(uint256 amount) external;
    function unlock() external;
    function tierOf(address a) external view returns (uint8);
    function feeDiscountBps(address a) external view returns (uint16);
    function earlyAccess(address a) external view returns (bool);
    function routingBonusBps(address host) external view returns (uint16);
}
