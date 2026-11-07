# Alder Treasury — local portfolio workspace

**Current completion standard, November 3, 2026:** the user selected portfolio-ready acceptance: correctness, security, persistence and demonstrated recovery are mandatory; numerical performance/capacity and recovery-speed targets are advisory. The current status and evidence are in [the portfolio acceptance packet](docs/acceptance-portfolio-ready-20261103.md), under [the authorized policy](docs/acceptance-policy-20261103.md).

Use the built local application at **https://127.0.0.1:5113** after starting its documented local services. Current source-package instructions are in [the portfolio reproduction guide](docs/TR-T-REPRO-PORTFOLIO-20261103.md). E: holds archives and encrypted backups; the live workspace remains on C:. No public deployment or real-funds use is included.

## Historical development notes

The dated status statements below describe earlier snapshots. The November 3 portfolio acceptance packet supersedes their completion status while preserving the original evidence and failures.

**2026-11-01 continuation:** the live deployment is the preserved lineage2 chain
on8547 (genesis/head verified at startup), with HTTPS API8103, dev UI5103 and built
release5113; the worker remains HTTP8113. The older v2 outage notes below are
historical. Current execution and open gates are tracked in
[round6 access](docs/parallel-delivery-round6-access.md) and
[round6 performance](docs/parallel-delivery-round6-perf.md); completion is not yet
claimed. Before starting a freshly provisioned API, run
`node --import tsx ops/split-api-profile.ts` once to create the private app-only
credential profile. It preserves the operator/worker profile and prints no secrets.

The retained PostgreSQL cluster was relocated, byte-verified, from its failed
Windows bind mount to an external Docker Linux volume without resetting data or
chain lineage. Use the current `alder-postgres` container; keep the archived bind
container stopped. See [storage recovery](docs/storage-recovery-20261101.md).

**Not the completed release. All32 original acceptance IDs remain:24 partial,6 not run,2 blocked,0 release-passed.** No public network, user wallet, real funds, spend or publication.

The actual isolated browser workflow now signs a separate bounded allowance, collects a payout quorum, persists the attempt, reconciles exact chain effects into three private PostgreSQL payable records at local depth12, then retracts all three on a real15-block branch replacement. The purpose-built EIP1193 adapter signs cryptographically **in an isolated test browser** with disposable public fixture keys. Extension/manual acceptance is not claimed.

- **Current operations, reproduction and full limitations:** [docs/LOCAL-v2.md](docs/LOCAL-v2.md)
- **All32 gates:** [docs/acceptance.json](docs/acceptance.json)
- **Independent findings AL-01/AL-02 disposition:** [docs/INDEPENDENT-FINDINGS-v2.md](docs/INDEPENDENT-FINDINGS-v2.md)
- **Custody pin / rights and review gate:** [docs/CUSTODY.md](docs/CUSTODY.md)
- **Current browser evidence:** `evidence/browser-wallet-v2/report.json`, `trace.zip`,13 screen captures; private by default.

## Live original application

UI **127.0.0.1:5103**, API **127.0.0.1:8103**, PG **127.0.0.1:5543**. Product connects with SCRAM non-superuser `alder_app`, FORCE RLS and transaction-local session/workspace scope. Existing guide/accounts and four private payables are preserved and all four real sign-ins were rechecked.

**Original Anvil8547 was already unavailable at v2 arrival and remains unavailable.** No saved original state was found; do not silently reset/redeploy or migrate old signed records. Original private views now return explicit unavailable chain state. Tests use a separate Anvil18547/databasealder_v2_test and actual temporary API18103, never the retained original deployment. See `evidence/CHAIN-OUTAGE-v2.md`.

## Executed checks

- `npm ci --ignore-scripts`: actual clean installed tree; `npm audit`:0 findings. Vulnerable Safe JS/ethers/elliptic graph removed, not waived. Actual Safe Solidity45 official files, LGPL and SHA256 preserved at immutable upstream commit under `vendor/safe-1.4.1`. Independent custody/rights approval remains blocked.
- `npm test`: fast unit/render + live HTTP privacy subset, not release acceptance.
- `npm run test:integration`:10 isolated boundary/security tests passed; see `evidence/tests-v2-current-integration.log`.
- `npm run test:wallet`: actual browser allowance→payout→3 reconciled business records→real15-block retraction; all13 screen IDs. No user wallet or signing backend.
- Actual prepare-response target tamper is rejected in the browser before wallet send; sender nonce unchanged. `evidence/prepared-outer-v2-green.log`.
- `npm run proof`: fresh isolated current-code adversarial proof, including real dropped raw-broadcast response, process exit/restart,15-block reorg/replay; original5report hashes unchanged. `evidence/legacy-proof-v2-latest.json`.
- Foundry11 tests (including stateful invariant) with10000 bounded amount fuzz cases; added stateful invariant campaign1000×128 =128000 calls,0reverts. Broader malicious-token populations remain incomplete.
- Actual encrypted pg_dump restoration into isolated database;14 private-table digests match, restored sessions revoked, RLS retained, corruption rejected. **Not** coherent chain/files/PITR/RPO acceptance.
- Strict TypeScript/Vite build passes; >500KB bundle and Node26/tsx deprecation warnings remain visible.

Current detailed commands, setup cautions and evidence names are in `docs/LOCAL-v2.md`. Historical README/matrix/inventory/custody/manifest are retained separately with `v1-preserved` names; their old source hashes are not represented as current verification.

## Still incomplete

Private intake/attachments/destination/policy/admin/preferences flows, full41-command contract, cancellation/invalidation/replacement races, durable jobs/SSE/continuous separate worker/verifier, auth/a11y/browser completeness, declared load/capacity campaigns and coherent PITR/chain restoration remain implementation work. Separate independent review/manual wallet/clean reproduction and original-chain recovery are additional gates. **No real-funds safety or complete independent audit claim.**
