// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ISwapAdapter {
    function swap(uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut);
}
