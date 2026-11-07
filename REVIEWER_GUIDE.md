# Alder Treasury reviewer guide

Use the following checks to inspect the engineering claims. Commands run from the repository root with the documented dependencies installed.

| Claim | Implementation | Test | Command | Expected observation |
|---|---|---|---|---|
| Only the configured Safe may execute a batch | [contracts/src/BatchExecutor.sol](contracts/src/BatchExecutor.sol) | [contracts/test/BatchExecutor.t.sol](contracts/test/BatchExecutor.t.sol) | `forge test --match-test testOnlySafe -vv` | The direct unauthorized call is rejected |
| A replay cannot pay a recipient twice | [contracts/src/BatchExecutor.sol](contracts/src/BatchExecutor.sol) | [contracts/test/BatchExecutor.t.sol](contracts/test/BatchExecutor.t.sol) | `forge test --match-test testExactTransferAndReplay -vv` | Exact first effects and rejection of repeated execution |
| A failing third transfer rolls back earlier transfers and markers | [contracts/src/BatchExecutor.sol](contracts/src/BatchExecutor.sol) | [contracts/test/BatchExecutor.t.sol](contracts/test/BatchExecutor.t.sol) | `forge test --match-test testThirdTransferRollback -vv` | Prior recipient balances and replay markers roll back together |

## Evidence boundaries

The existing isolated payout report records three exact local transfers and zero duplicate effects after resynchronization. The portfolio packet still lists final independent approval and companion-manifest binding as pending. Local depth 12 is the test deployment confirmation policy.

[Current publication verification](docs/verification.md) records the checks executed for this copy. [Reproduction instructions](docs/reproduction.md) distinguish the small review path from the full application and research runs.
