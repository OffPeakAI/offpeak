# Invariants

These are the properties the Solidity invariant suites check after every random call sequence. Each row is one `invariant_*` function in `contracts/test`, with a link to where it lives.

Run them with `bun run contracts:invariant`. `foundry.toml` sets 256 runs at depth 128 by default, and `FOUNDRY_PROFILE=audit` sets 1,024 runs at depth 128.

The suites cover the contracts below. `FeeSplitter` and `OfpkHooks` have no invariant suite yet. Passing suites do not prove a property, and they do not replace the external audit.

## Audit court

[`AuditCourt.invariant.t.sol`](../contracts/test/invariant/AuditCourt.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_noFullSlashWithoutPanelConfirm` | A host's bond only ever falls by the amounts slashes applied, and it reaches zero only after a panel Confirm. | [23](../contracts/test/invariant/AuditCourt.invariant.t.sol#L23) |
| `invariant_theRegistryHoldsEverythingItOwes` | The registry always holds at least as much USDG as `totalOwed`. | [31](../contracts/test/invariant/AuditCourt.invariant.t.sol#L31) |
| `invariant_rulingKeysNeverReachAFullSlashAlone` | Ruling keys acting alone never get a full slash accepted. | [35](../contracts/test/invariant/AuditCourt.invariant.t.sol#L35) |
| `invariant_aDismissalByRulingPaysTheHostHalfTheBond` | When a ruling dismisses a challenge, the host receives half the challenge bond. | [39](../contracts/test/invariant/AuditCourt.invariant.t.sol#L39) |
| `invariant_courtHoldsExactlyWhatItOwes` | Every USDG in the court is an open bond, an unclaimed refund or credits held for an outcome. | [44](../contracts/test/invariant/AuditCourt.invariant.t.sol#L44) |
| `invariant_openChallengeCountMatchesTheCourt` | A host's open challenge count always equals its challenges in the court that have not finalized. | [55](../contracts/test/invariant/AuditCourt.invariant.t.sol#L55) |

## Payment channels

[`Channel.invariant.t.sol`](../contracts/test/invariant/Channel.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_everyDepositIsHeldPaidOrRefunded` | Every channel deposit is still held, paid to the vault or refunded. | [21](../contracts/test/invariant/Channel.invariant.t.sol#L21) |
| `invariant_theManagerHoldsExactlyWhatIsUnclaimedOnLiveChannels` | The manager's USDG equals the unclaimed deposits on live channels. | [25](../contracts/test/invariant/Channel.invariant.t.sol#L25) |
| `invariant_noChannelOverclaims` | A channel never pays out more than its deposit, and its claimed total matches what was paid. | [34](../contracts/test/invariant/Channel.invariant.t.sol#L34) |
| `invariant_noCloseBeforeTheChallengeEnds` | A channel in its challenge period cannot close before that period ends. | [42](../contracts/test/invariant/Channel.invariant.t.sol#L42) |
| `invariant_theLatestVoucherInTheChallengeLands` | The latest voucher submitted inside the challenge period always lands. | [46](../contracts/test/invariant/Channel.invariant.t.sol#L46) |

## Window partial units

[`PartialUnits.invariant.t.sol`](../contracts/test/invariant/PartialUnits.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_aPartlyUsedUnitIsNeverLost` | A holder with a partly used Window unit always still holds a unit. | [20](../contracts/test/invariant/PartialUnits.invariant.t.sol#L20) |
| `invariant_escrowCoversEveryHoldersUnusedValue` | A Window's host escrow covers the unused value of every holder. | [30](../contracts/test/invariant/PartialUnits.invariant.t.sol#L30) |

## Buyer reserve

[`Reserve.invariant.t.sol`](../contracts/test/invariant/Reserve.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_debitsAreNeverClampedOnTime` | With a router obeying the chain, every debit is taken in full, unless settlement ran past the 2 hour exit. | [17](../contracts/test/invariant/Reserve.invariant.t.sol#L17) |
| `invariant_reserveCoversUnsettledUsage` | Usage served but not yet settled is always covered by what the buyer cannot withdraw. | [22](../contracts/test/invariant/Reserve.invariant.t.sol#L22) |

## Settlement

[`Settlement.invariant.t.sol`](../contracts/test/invariant/Settlement.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_settlesAreOnePerHourInOrder` | Settlement moves one hour at a time, in order. | [23](../contracts/test/invariant/Settlement.invariant.t.sol#L23) |
| `invariant_noBadBatchEverLands` | Over-cap debits, debits above totals, unbalanced batches, skipped hours and replays never land. | [28](../contracts/test/invariant/Settlement.invariant.t.sol#L28) |
| `invariant_hostCreditsMatchTheMirror` | Host credits can be clawed back for exactly 24 hours, and can be paid only after them. | [33](../contracts/test/invariant/Settlement.invariant.t.sol#L33) |
| `invariant_registryHoldsEveryUnpaidCredit` | The registry's USDG equals every unpaid credit, pending or releasable. | [44](../contracts/test/invariant/Settlement.invariant.t.sol#L44) |

## Vault conservation

[`VaultConservation.invariant.t.sol`](../contracts/test/invariant/VaultConservation.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_usdgEqualsBalancesPlusPoolPlusReserve` | The vault's USDG equals the buyers' balances plus the pool plus the reserve. | [19](../contracts/test/invariant/VaultConservation.invariant.t.sol#L19) |
| `invariant_settlesAreSequential` | The vault's last settled hour always matches the sequence of accepted settles. | [27](../contracts/test/invariant/VaultConservation.invariant.t.sol#L27) |

## Vault exit

[`VaultExit.invariant.t.sol`](../contracts/test/invariant/VaultExit.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_noDebitAfterARequestIsEverAccepted` | Once a buyer asks to withdraw all, no debit for a later request is accepted. | [20](../contracts/test/invariant/VaultExit.invariant.t.sol#L20) |
| `invariant_reserveNeverExceedsBalance` | A buyer's reserve never exceeds their balance. | [24](../contracts/test/invariant/VaultExit.invariant.t.sol#L24) |
| `invariant_withdrawingTheUnreservedPartAlwaysWorks` | In any reachable state, paused or not, everyone can take out their balance minus their reserve right away. | [32](../contracts/test/invariant/VaultExit.invariant.t.sol#L32) |
| `invariant_exitCompletesTwoHoursAfterRequest` | A pending exit always completes within 2 hours of the request, with settlement halted or not. | [45](../contracts/test/invariant/VaultExit.invariant.t.sol#L45) |

## Window conservation

[`WindowConservation.invariant.t.sol`](../contracts/test/invariant/WindowConservation.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_theMarketHoldsExactlyItsEscrowsAndCollateral` | The market's USDG equals the escrows and collateral of its Windows. | [21](../contracts/test/invariant/WindowConservation.invariant.t.sol#L21) |
| `invariant_nothingStaysBehindAfterTheLastClaim` | Nothing is left in a Window after its last claim. | [31](../contracts/test/invariant/WindowConservation.invariant.t.sol#L31) |

## x402 escrow

[`X402.invariant.t.sol`](../contracts/test/invariant/X402.invariant.t.sol)

| Invariant | Property | Line |
|---|---|---|
| `invariant_escrowHoldsExactlyTheOpenMaxes` | The escrow's USDG equals the maximum amounts of its open payments. | [21](../contracts/test/invariant/X402.invariant.t.sol#L21) |
| `invariant_everyAuthorizedUnitIsHeldCapturedOrRefunded` | Every authorized unit is still held, captured or refunded. | [30](../contracts/test/invariant/X402.invariant.t.sol#L30) |
| `invariant_capturedFundsReachTheVault` | Everything captured reaches the vault. | [34](../contracts/test/invariant/X402.invariant.t.sol#L34) |
| `invariant_aRevokedApprovalCannotReduceAnEscrow` | A payer who revokes an approval cannot reduce an open escrow. | [38](../contracts/test/invariant/X402.invariant.t.sol#L38) |
