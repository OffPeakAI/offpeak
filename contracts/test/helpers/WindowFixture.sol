// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// @notice A bonded, routable host with one model, and helpers around Window timing and performance.
abstract contract WindowFixture is VaultFixture {
    bytes32 internal constant MODEL = keccak256("model");
    uint32 internal constant MAX_TPS = 50_000;
    uint64 internal constant START_PRICE = 1_000_000;
    uint64 internal constant END_PRICE = 500_000;
    uint64 internal constant UNITS = 100;

    address internal host;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint64 internal t0;
    uint64 internal t1;

    function _setUpWindows() internal {
        host = hostA;
        usdg.mint(host, 100_000e6);
        vm.prank(host);
        usdg.approve(address(windows), type(uint256).max);
        _register(host);
        t0 = uint64((block.timestamp / 3600 + 24) * 3600);
        t1 = t0 + 2 hours;
        _fundWindowBuyer(alice);
        _fundWindowBuyer(bob);
    }

    function _register(address who) internal {
        bytes32[] memory models = new bytes32[](1);
        models[0] = MODEL;
        uint32[] memory tps = new uint32[](1);
        tps[0] = MAX_TPS;
        vm.prank(owner);
        registry.setGpuClass(keccak256("h100-80g-sxm"), true);
        vm.startPrank(who);
        usdg.approve(address(registry), type(uint256).max);
        registry.register(
            RegisterParams({
                modelDigests: models,
                maxTps: tps,
                imageDigest: keccak256("image"),
                gpuClass: keccak256("h100-80g-sxm"),
                endpointHash: keccak256("endpoint"),
                attestationRef: bytes32(0),
                bondUsdg: 2_000e6,
                bondOfpk: 0
            })
        );
        vm.stopPrank();
        vm.warp(block.timestamp + 72 hours);
        registry.activate(who);
    }

    function _fundWindowBuyer(address who) internal {
        usdg.mint(who, 1_000_000e6);
        vm.prank(who);
        usdg.approve(address(windows), type(uint256).max);
    }

    function _params() internal view returns (WindowParams memory) {
        return WindowParams({
            modelDigest: MODEL,
            t0: t0,
            t1: t1,
            minTps: 100,
            units: UNITS,
            startPricePerUnit: START_PRICE,
            endPricePerUnit: END_PRICE,
            auctionStart: uint64(block.timestamp),
            auctionEnd: t0
        });
    }

    function _collateral() internal pure returns (uint256) {
        return uint256(UNITS) * START_PRICE * 2_000 / 10_000;
    }

    function _createWindow() internal returns (uint256 id) {
        vm.prank(host);
        id = windows.create(_params(), _collateral());
    }

    function _buy(address who, uint256 id, uint256 units) internal {
        vm.prank(who);
        windows.buy(id, units, type(uint256).max);
    }

    function _windowsDigest(WindowPerformance memory p) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OffpeakWindows"),
                keccak256("1"),
                block.chainid,
                address(windows)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, Typehashes.hash(p)));
    }

    function _post(uint256 id, uint32 measured, uint32 below) internal {
        WindowPerformance memory p =
            WindowPerformance({windowId: id, measuredSeconds: measured, belowMinSeconds: below, evidenceRoot: keccak256("evidence")});
        bytes memory sig = _thresholdSig(_windowsDigest(p));
        vm.prank(settlers[0]);
        windows.postPerformance(p, sig);
    }

    function _draw(uint256 id, address holder, uint64 tokens) internal {
        WindowDraw[] memory draws = new WindowDraw[](1);
        draws[0] = WindowDraw({windowId: id, holder: holder, tokens: tokens});
        vm.prank(address(vault));
        windows.applyDraws(uint64(block.timestamp / 3600), draws);
    }
}
