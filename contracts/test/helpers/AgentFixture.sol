// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChannelManager} from "../../src/ChannelManager.sol";
import {X402Escrow} from "../../src/X402Escrow.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import "../../src/interfaces/OffpeakTypes.sol";
import {Typehashes} from "../../src/lib/Typehashes.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// @notice The vault wired to the real payment contracts and the real Permit2 bytecode.
abstract contract AgentFixture is VaultFixture {
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string internal constant PERMIT_WITNESS_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    X402Escrow internal x402;
    ChannelManager internal manager;
    address internal relay = makeAddr("relay");
    address internal capturer = makeAddr("capturer");
    address internal keeper = makeAddr("keeper");
    address internal payee;
    uint256 internal payeeKey;
    address internal agent;
    uint256 internal agentKey;
    uint256 internal permitNonce = 1;

    function _agentPeers() internal virtual override returns (address, address) {
        (payee, payeeKey) = makeAddrAndKey("payee");
        (agent, agentKey) = makeAddrAndKey("agent");
        x402 = new X402Escrow(IERC20(address(usdg)), ISignatureTransfer(PERMIT2), address(vault), relay, capturer);
        manager = new ChannelManager(IERC20(address(usdg)), ISignatureTransfer(PERMIT2), address(vault), payee, keeper);
        return (address(x402), address(manager));
    }

    function _fundAgent(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(PERMIT2, type(uint256).max);
        usdg.approve(address(manager), type(uint256).max);
        vm.stopPrank();
    }

    function _permit(uint256 amount) internal returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(usdg), amount: amount}),
            nonce: permitNonce++,
            deadline: block.timestamp + 1 hours
        });
    }

    function _witnessSig(
        uint256 key,
        ISignatureTransfer.PermitTransferFrom memory p,
        address spender,
        bytes32 witness,
        string memory witnessType
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(abi.encodePacked(PERMIT_WITNESS_STUB, witnessType)),
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                spender,
                p.nonce,
                p.deadline,
                witness
            )
        );
        return _sig(key, keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), structHash)));
    }

    function _upto(bytes32 reqId, uint256 maxAmount) internal view returns (UptoWitness memory) {
        return UptoWitness({
            reqId: reqId,
            payee: address(vault),
            maxAmount: maxAmount,
            validBefore: uint64(block.timestamp + 10 minutes),
            resourceHash: keccak256("resource")
        });
    }

    function _authorizeCall(bytes32 reqId, uint256 maxAmount) internal returns (AuthorizeCall memory call) {
        call.p = _permit(maxAmount);
        call.w = _upto(reqId, maxAmount);
        call.payer = agent;
        call.sig = _witnessSig(agentKey, call.p, address(x402), Typehashes.hash(call.w), Typehashes.UPTO_WITNESS_TYPESTRING);
    }

    function _channelDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OffpeakChannel"),
                keccak256("1"),
                block.chainid,
                address(manager)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _voucher(bytes32 id, uint64 seq, uint128 cumulative) internal pure returns (Voucher memory) {
        return Voucher({channelId: id, seq: seq, cumulative: cumulative});
    }

    function _voucherSig(uint256 key, Voucher memory v) internal view returns (bytes memory) {
        return _sig(key, _channelDigest(Typehashes.hash(v)));
    }

    function _openChannel(uint256 deposit, bytes32 salt) internal returns (bytes32) {
        vm.prank(agent);
        return manager.open(deposit, uint64(block.timestamp + 1 days), salt);
    }
}
