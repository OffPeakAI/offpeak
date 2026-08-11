// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WindowMarket} from "../../src/WindowMarket.sol";
import {IHostRegistry} from "../../src/interfaces/IHostRegistry.sol";
import {IOfpkHooks} from "../../src/interfaces/IOfpkHooks.sol";

/// @notice Reads the market's storage for tests. Production has no use for these, and no room for them.
contract WindowMarketHarness is WindowMarket {
    constructor(address owner_, IERC20 usdg_, IHostRegistry registry_, IOfpkHooks hooks_, address vault_, address feeSplitter_)
        WindowMarket(owner_, usdg_, registry_, hooks_, vault_, feeSplitter_)
    {}

    function windowState(uint256 id) external view returns (Window memory) {
        return _windows[id];
    }

    function holdingState(uint256 id, address holder) external view returns (Holding memory) {
        return _holdings[id][holder];
    }
}
