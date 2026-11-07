# Reproduce Alder Treasury checks

## Toolchain

Use Node 26.7.0, npm 11.19.0, Foundry 1.5.1, and Solidity 0.8.24. `.node-version` records the Node version and `foundry.toml` pins the compiler and Shanghai EVM target. Put `forge` on PATH. `verify.py` requires Python 3.12 or later as its standard-library command runner.

## Install and verify

```powershell
npm ci --ignore-scripts --no-audit --no-fund
python verify.py
```

The review command builds the TypeScript/React application, runs eight unit/render/supply checks, and executes three Solidity checks for unauthorized callers, repeat execution, and atomic rollback when the third transfer fails. Logs and the execution receipt are written to `.local/review-checks/`.

## Run the contract campaigns

```powershell
forge test --fuzz-runs 10000 -vv
forge test --match-contract TreasuryInvariantTest -vv
```

The invariant campaign is configured in `foundry.toml`. The contracts execute on Foundry's local EVM. Vendored Safe 1.4.1 source is retained under `vendor/` with its original license and provenance.

## Full application replay

The application adds PostgreSQL, a local Anvil chain, wallet accounts, local TLS, and a separate verifier/indexer worker. The isolated Linux replay performs its own acquisition, build, database initialization, wallet episode, and chain verification.

Read [the Linux reproduction guide](TR-T-REPRO-LINUX.md) and [the source-package guide](TR-T-REPRO-PORTFOLIO-20261103.md) before running it. Its stages are acquisition, container build, and isolated replay.

```bash
bash tests/round6-repro/acquire-linux.sh
bash tests/round6-repro/build-image-linux.sh
bash tests/round6-repro/repro-linux.sh
```

The acquisition step requires Linux x86_64 and the exact Node/npm pins. It verifies checksums for Foundry, the compiler, Chromium, and the test wallet. The replay requires Docker and creates its own named project and private volumes. The source-bundle script gathers source from this checkout. Historical R3 archive hashes identify the original package and must be distinguished from this publication candidate.

The fresh portable check command verifies the contract and UI subset. The full wallet/backend replay has a separate execution record and resource requirements. Test wallet keys embedded in the harness are public disposable fixtures for a local chain.
