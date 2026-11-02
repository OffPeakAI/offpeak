// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {AuditCourt} from "../../src/AuditCourt.sol";
import {HostRegistry} from "../../src/HostRegistry.sol";
import {AuditCourtHandler} from "./AuditCourtHandler.sol";

contract AuditCourtInvariant is StdInvariant, Test {
    AuditCourtHandler internal handler;
    AuditCourt internal court;
    HostRegistry internal registry;

    function setUp() public {
        handler = new AuditCourtHandler();
        court = AuditCourt(handler.courtAddress());
        registry = HostRegistry(handler.registryAddress());
        targetContract(address(handler));
        excludeSender(address(handler));
    }

    /// Bonds only ever fall by the amounts the mirror applied, so a full slash needs a panel Confirm.
    function invariant_noFullSlashWithoutPanelConfirm() public view {
        for (uint256 i; i < handler.hostCount(); ++i) {
            address host = handler.hosts(i);
            assertEq(registry.hostView(host).bondUsdg, handler.mirroredBond(host));
            if (registry.hostView(host).bondUsdg == 0) assertGt(handler.confirms(host), 0);
        }
    }

    function invariant_theRegistryHoldsEverythingItOwes() public view {
        assertGe(handler.usdgBalanceOf(address(registry)), registry.totalOwed());
    }

    function invariant_rulingKeysNeverReachAFullSlashAlone() public view {
        assertFalse(handler.attackAccepted());
    }

    function invariant_aDismissalByRulingPaysTheHostHalfTheBond() public view {
        assertFalse(handler.dismissalUnderpaid());
    }

    /// Every USDG in the court is an open bond, an unclaimed refund or credits held for an outcome.
    function invariant_courtHoldsExactlyWhatItOwes() public view {
        uint256 owed;
        for (uint256 i; i < handler.idCount(); ++i) {
            AuditCourt.Challenge memory c = court.challengeView(handler.ids(i));
            owed += c.refundable + c.seized;
            if (c.state != AuditCourt.State.Finalized) owed += 100e6;
        }
        assertEq(handler.usdgBalanceOf(address(court)), owed);
    }

    /// Open challenges and freezes always clear once nothing is pending on a host.
    function invariant_openChallengeCountMatchesTheCourt() public view {
        for (uint256 h; h < handler.hostCount(); ++h) {
            address host = handler.hosts(h);
            uint256 open;
            for (uint256 i; i < handler.idCount(); ++i) {
                AuditCourt.Challenge memory c = court.challengeView(handler.ids(i));
                if (c.host == host && c.state != AuditCourt.State.Finalized) ++open;
            }
            assertEq(registry.hostView(host).openChallenges, open);
        }
    }
}
