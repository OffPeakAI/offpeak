// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockOFPK} from "./MockOFPK.sol";

/// @notice Swaps USDG for freshly minted OFPK at 1:1 base units, for FeeSplitter burn tests.
contract MockSwapAdapter {
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    IERC20 public immutable usdg;
    MockOFPK public immutable ofpk;

    constructor(IERC20 usdg_, MockOFPK ofpk_) {
        usdg = usdg_;
        ofpk = ofpk_;
    }

    function swap(uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut) {
        amountOut = amountIn;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        usdg.transferFrom(msg.sender, address(this), amountIn);
        ofpk.mint(to, amountOut);
    }
}
