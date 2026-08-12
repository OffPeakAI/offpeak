// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../../src/interfaces/OffpeakTypes.sol";
import {AgentFixture} from "../helpers/AgentFixture.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";
import {WindowFixture} from "../helpers/WindowFixture.sol";

/// @notice The calls whose gas `bun run contracts:gas` holds to the checked-in snapshot.
contract GasTest is AgentFixture, WindowFixture {
    function setUp() public override {
        super.setUp();
        _fundAgent(agent, 1_000e6);
    }

    function _agentPeers() internal override(AgentFixture, VaultFixture) returns (address, address) {
        return AgentFixture._agentPeers();
    }

    function testGas_settle500Debits() public {
        vm.pauseGasMetering();
        uint64 hour = _nextHour();
        Debit[] memory debits = new Debit[](500);
        uint256 ts = uint256(hour) * 3600 + 1;
        for (uint160 i; i < 500; ++i) {
            address buyer = address(0x10000 + i);
            _fundWithCaps(buyer, 10e6, 5e6);
            debits[i] = Debit({buyer: buyer, amount: 1e6, lastTs: uint64(ts)});
        }
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, debits, 450e6);
        _warpPast(hour);
        bytes memory sig = _signBatch(b);
        vm.resumeGasMetering();
        vault.settle(b, t, sig);
    }

    /// Buyers already debited today cost far less than first-time ones, and most hours look like this.
    function testGas_settle500RepeatDebits() public {
        vm.pauseGasMetering();
        Debit[] memory debits = new Debit[](500);
        for (uint160 i; i < 500; ++i) {
            _fundWithCaps(address(0x10000 + i), 10e6, 5e6);
        }
        uint64 hour = _nextHour();
        for (uint160 i; i < 500; ++i) {
            debits[i] = Debit({buyer: address(0x10000 + i), amount: 1e6, lastTs: uint64(uint256(hour) * 3600 + 1)});
        }
        (SettleBatch memory first, RootTotals memory firstTotals) = _batch(hour, debits, 450e6);
        _settle(first, firstTotals);
        hour = _nextHour();
        for (uint160 i; i < 500; ++i) {
            debits[i].lastTs = uint64(uint256(hour) * 3600 + 1);
        }
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, debits, 450e6);
        _warpPast(hour);
        bytes memory sig = _signBatch(b);
        vm.resumeGasMetering();
        vault.settle(b, t, sig);
    }

    function testGas_settle100Credits() public {
        vm.pauseGasMetering();
        uint64 hour = _nextHour();
        _fundWithCaps(address(0x10000), 200e6, 100e6);
        (SettleBatch memory b, RootTotals memory t) = _batch(hour, _oneDebit(address(0x10000), 100e6, uint64(uint256(hour) * 3600 + 1)), 0);
        b.credits = new Credit[](100);
        for (uint160 i; i < 100; ++i) {
            b.credits[i] = Credit({host: address(0x20000 + i), amount: 1e6});
        }
        b.fees = 0;
        t.hostCredit = 100e6;
        t.fees = 0;
        _seal(b, t);
        _warpPast(hour);
        bytes memory sig = _signBatch(b);
        vm.resumeGasMetering();
        vault.settle(b, t, sig);
    }

    function testGas_applyDraws100() public {
        vm.pauseGasMetering();
        _setUpWindows();
        uint256 id = _createWindow();
        WindowDraw[] memory draws = new WindowDraw[](100);
        for (uint160 i; i < 100; ++i) {
            address holder = address(0x30000 + i);
            _fundWindowBuyer(holder);
            _buy(holder, id, 1);
            draws[i] = WindowDraw({windowId: id, holder: holder, tokens: 1_000});
        }
        vm.warp(t0);
        vm.prank(address(vault));
        vm.resumeGasMetering();
        windows.applyDraws(uint64(block.timestamp / 3600), draws);
    }

    function testGas_authorizeBatch20() public {
        vm.pauseGasMetering();
        AuthorizeCall[] memory calls = new AuthorizeCall[](20);
        for (uint256 i; i < 20; ++i) {
            calls[i] = _authorizeCall(keccak256(abi.encode("gas", i)), 1e6);
        }
        vm.prank(relay);
        vm.resumeGasMetering();
        x402.authorizeBatch(calls);
    }

    function testGas_captureBatch50() public {
        vm.pauseGasMetering();
        bytes32[] memory ids = new bytes32[](50);
        uint256[] memory actuals = new uint256[](50);
        for (uint256 i; i < 50; ++i) {
            ids[i] = keccak256(abi.encode("gas", i));
            actuals[i] = 500_000;
            AuthorizeCall memory c = _authorizeCall(ids[i], 1e6);
            vm.prank(relay);
            x402.authorize(c.p, c.sig, c.payer, c.w);
        }
        vm.prank(capturer);
        vm.resumeGasMetering();
        x402.captureBatch(ids, actuals);
    }

    function testGas_settleChannel() public {
        vm.pauseGasMetering();
        bytes32 id = _openChannel(10e6, keccak256("gas"));
        Voucher memory v = _voucher(id, 1, 1e6);
        bytes memory sig = _voucherSig(agentKey, v);
        vm.prank(keeper);
        vm.resumeGasMetering();
        manager.settleChannel(id, v, sig);
    }
}
