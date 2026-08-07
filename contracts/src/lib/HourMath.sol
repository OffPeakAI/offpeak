// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library HourMath {
    function hourOf(uint256 ts) internal pure returns (uint64) {
        return uint64(ts / 3600);
    }

    function hourEnd(uint64 hour) internal pure returns (uint256) {
        return (uint256(hour) + 1) * 3600;
    }

    function dayOf(uint64 hour) internal pure returns (uint64) {
        return hour / 24;
    }
}
