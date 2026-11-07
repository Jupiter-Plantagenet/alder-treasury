# Alder local release runbook

## Current portfolio acceptance — 2026-11-03

The user authorized portfolio-ready completion with correctness, security, persistence and a demonstrated DB/private-file/chain restore mandatory. Numerical performance, capacity, hardware, disk and RPO/RTO-speed targets are advisory. See [the policy](docs/acceptance-policy-20261103.md) and [the current 32-ID/13-screen evidence packet](docs/acceptance-portfolio-ready-20261103.md) for the actual readiness decision and remaining limitations. Source reviews, execution evidence and waivers remain distinct.

Current source-package and build instructions are in [TR-T-REPRO-PORTFOLIO-20261103](docs/TR-T-REPRO-PORTFOLIO-20261103.md). The application is local-only at https://127.0.0.1:5113, with HTTPS API 8103, indexer status 8113, retained Anvil 8547 and the preserved PostgreSQL Linux volume. SSD archives/backups do not relocate the live runtime. The dated records below remain historical; their former full-release NO-GO is not a decision under the newly authorized portfolio policy.

## Historical reconciled release state — 2026-11-02

**Release remains NO-GO.** The current assertion matrix preserves all 32 original IDs, 13 screens, and 133 atomic assertions: 4 executed-pass IDs, 20 reviewed-pass IDs, 8 partial IDs, zero failures, zero not-run. Source-review substitutions are labeled separately from executed checks. See `docs/acceptance-final-current-20261102.md`, `.json`, and `.csv`; the older status paragraphs below are historical snapshots and are superseded by this section.

- **Clean reproduction and workflow:** A13 completed in an isolated Linux stack using source archive SHA-256 `252f9bc8421dee4bcdc7d103bfed98d1501b22c953b0d984cd33e66d198131b2`; completion receipt `706cf984cd47d95c2615347d27d07f143b8217f3f1df36d27272785ed8f64dfe`. It exercised real MetaMask, reviewer policy, wallet refusal/recovery, one payout batch, depth-12 settlement, verifier and 15-block reorg replay. Verifier software ran on the same disposable Anvil node; this is not proof of canonical-chain continuity.
- **Inbox and browser:** Chrome visible quarantine passed 3/3. Chrome/Edge passed strict-TLS smoke; Firefox/WebKit completed functional route checks with Playwright HTTPS trust override. All 13 routes, keyboard and 360px checks were covered. Manual independent wallet and WCAG/screen-reader review remain open.
- **Capacity / UI execution:** 100k replay and all three gas-cap phases passed, including the numeric <=15M inner estimate. The 3M outer gas hardcode is removed in candidate source, but independent review found a same-chain-ID chain-instance TOCTOU in the replacement estimator. The A13 three-payable wallet/UI pass remains valid; full TypeScript/build and 100-item wallet/UI verification are pending. Full-stack RSS and total evidence/dependency disk limits remain unmeasured.
- **Load:** final run completed 1,806.8s / 44,068 samples. Read p95 was 432.3ms with 228 read errors; write p95 was 152.7ms with zero errors; overall error rate 0.56%; outsider isolation produced 29 HTTP 503 responses. The load gate remains partial. Five browser vital runs reported LCP p95 720ms and INP p95 160ms on a declared esbuild P6 UI profile; this does not establish Vite release performance.
- **Restore:** consistent PostgreSQL restore covered 54 tables, 16 catalog groups and 1,242 artifacts. Current-source scratch encrypted base+WAL PITR recovered its marker from three compressed WAL segments with a 1,270-file base inventory; proof SHA-256 `561fa54a7e454f2aa454bc58921657caa8a68e84e8b48511d3d8ec2ad5cbcb11`. Continuous 60-second archive/RPO, full app-plus-chain recovery and complete release RTO remain open.
- **Timing gates:** member revocation <=5s and healthy-RPC convergence <=120s remain unmeasured.

Exact output hashes, source pins, proof scope and assertion-by-assertion disposition are in the current matrix. The A13 execution is bound to its archived source manifest; `current_source_sha256` in the matrix describes the present checkout. Later P6 harness-only corrections are recorded separately and do not imply a new full TypeScript run. Historical failures and prior status snapshots remain preserved.

Status: local services run; final acceptance reconciliation is in progress.
The complete 32-ID/13-screen release matrix is not yet certified.

## Start and inspect

Run from `C:\Users\user\portfolio-build\alder`:

```powershell
powershell -NoProfile -File ops/round4-services.ps1 start
powershell -NoProfile -File ops/round4-services.ps1 status
```

Local endpoints: API `https://127.0.0.1:8103`, UI `https://127.0.0.1:5103`,
built release `https://127.0.0.1:5113`, worker `http://127.0.0.1:8113/status`,
chain `http://127.0.0.1:8547`. Use the private local CA and operator-provisioned
profiles. Do not create a replacement chain or database to start the app.

The retained PostgreSQL container is `alder-postgres` on 5543; its recovered
physical cluster uses volume `alder-pgdata-preserved-20261101t1400z-stream1`.
The archived Windows-bind container/data and backups preserve prior lineage.
The private Node 26.7.0 runtime is pinned by the service launcher.

## Current delivery evidence (2026-11-02)

- Additive migrations 015 and 016 are applied and journaled; previous journal
  entries were preserved. 015's actual scratch-PostgreSQL proof covered atomic
  account budgets, device bypass/overflow, the 10-failure window and success reset.
  016 supplies only the canonical-header/checkpoint reads required by hold resolution.
- Both existing cancellation targets reached canonical depth 12 with independent
  indexer verification, exact reservation release and resolved central holds.
  Their transactions paid no funds. No chain reset or payout was used.
- Current API source was activated after a new retained backup. Authenticated
  snapshot readback is 200 with both recovered holds resolved.
- Independent source review, focused tests, TypeScript and the UI build are
  recorded in the packet documents. Full load/browser/capacity reconciliation
  remains separate from these bounded results.

Raw evidence is under `.local/codex-a2/`: `015-rehearsal-result.json`,
`015-activation-result.json`, `016-rehearsal-result.json`,
`016-activation-result.json`, `first-cancel-preflight/89-first-cancel-complete.json`,
`92-second-cancel-result.json`, `94-parent-second-cancel-rpc.json`,
`20261102-current-api-backup-receipt.json`, and `96-current-source-smoke.json`.
Source/evidence pins and limitations are recorded in
`docs/parallel-delivery-round6-perf.md` and
`docs/independent-review-round6-current-20261102.md`.

No Windows scheduled task, service or Run key was created in this completion round.

### Alder clean Linux reproduction source packet — 2026-11-02

The TR-T-REPRO source lane now has an allow-listed deterministic source packager, a checksum-verifying acquisition step, a pinned local runner-image recipe, a no-host-port Compose namespace, fresh disposable database/schema/fixture bootstrap, fresh Anvil deployment helper, and an internal replay driver for the real extension-wallet app success/failure/reorg path and independent verifier replay. W5 can target the compiled release UI through `ALDER_ORIGIN=https://127.0.0.1:5113`; the shared API test client honors that same origin. Its Linux API-restart fault hook only restarts the PID file created in the private per-run proof volume.

This is source preparation and review, **not a Linux reproduction pass**. No Docker image build/pull, browser start, `npm ci`, test, database migration, service start or chain action was run by this lane. The platform-specific Chrome for Testing Linux archive SHA has not yet been established; the offline acquisition script requires that digest before it can write browser provenance. The acceptance matrix still keeps TR-T-REPRO partial and preserves its execution status as not run. Exact environment, licenses, WSL2 bootstrap, source/output handling and run/cleanup commands are documented in `docs/TR-T-REPRO-LINUX.md` and `tests/round6-repro/`.

### Latest source activation and review basis

The export crash-recovery and retryable retention cleanup corrections were activated
with a fresh paired PostgreSQL/roles/private-file/chain backup, followed by an
API-only restart. Evidence: `.local/codex-a2/20261102-export-recovery-api-activation.raw.log`,
`20261102-export-recovery-backup-receipt.json`, and
`20261102-export-recovery-activation-smoke.json`. API PID28676 uses the pinned
private Node runtime; `/health` returned200/ready. Export source SHA256 is
`2cd62cd84e00a5c631130f048160425c3beb358b71ec8987c09504d1c2e1a1ad`;
retention source SHA256 is
`1f0df090b7c23e394c44fc17c6b0d338935da6d681aaf3a62f55b9f51562c178`.
Chain head3442 and the existing genesis were preserved; no new transaction was
needed for this activation.

Per the user's current instruction, independent source review substitutes for
difficult execution checks where it supports the functional assertion. Current
matrices (`docs/current-acceptance-matrix-20261102.*` and
`docs/current-screen-matrix-20261102.*`) record21 reviewed-pass,8partial,3not-run
IDs and13 source-reviewed screens. These are simulated AI reviews, not measured
load, restore, fault-timing or browser results; empirical gaps remain explicit.

The development UI5103 is temporarily operator-paused for host resource sharing.
The compiled release at `https://127.0.0.1:5113` remains the runnable UI.
Resume only the named development UI with
`powershell -NoProfile -File ops/round4-services.ps1 start ui`.

Resource-window update (2026-11-02): the named API, worker, compiled release and
development UI have all been restored. Parent checked all four HTTP/HTTPS health
endpoints at 2026-11-01T23:35:11Z; each returned200. Chain head3442 and genesis
were unchanged. The temporary development-UI pause above is historical, not the
current startup state. Receipt:
`../goal-tracking/round5-20261101/live-health-20261102T0010Z.json`.

### Scheduled task state — 2026-11-02 08:08 UTC

`PortfolioAlderWatchdog` was registered for the current interactive user at Limited run level. It invokes Windows PowerShell hidden with `ops/alder-watchdog.ps1 tick`, the exact pinned policy/script hashes, at logon and every two minutes. The post-registration identity check failed, so it remains **Disabled**; no automatic service start occurred. Raw log: `.local/watchdog-install-limited-20261102T0809Z.private.log`. Prepared ownership and lineage evidence is retained. To remove this owned partial task after verification, run the watchdog with `recover-install`, then `uninstall`, supplying the current reviewed `-ExpectedPolicySha256` and `-ExpectedScriptSha256`; ownership mismatch refuses removal. No Windows service or Run key exists for this packet.


## Current acceptance and runtime reconciliation — 2026-11-02

This dated block supersedes earlier readiness summaries in this runbook where they differ. **Release remains NO-GO.** The original 32-ID acceptance register and 13-screen coverage are retained exactly. Current roll-up: 2 bounded executed-pass (`TR-T-SUPPLY`, `TR-T-FUZZ`), 20 reviewed-pass, 9 partial, 1 not-run. Review-only evidence is not an execution pass. Full details and assertion-level SHA pins: `docs/acceptance-final-current-20261102.md`, `.json`, and `.csv`; independent release review: `docs/independent-review-release-current-20261102.md` and `.json`.

The latest canonical restore/runtime receipt is `.local/alder-watchdog/receipts/canonical-restore-verification-20261102T091000Z.json` (SHA-256 `c5a11c12710d30619035b98f045f07605a24d931aad8ffeaf66aad714b968200`). It verifies preserved chain genesis `0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec`, head `3442`, Safe nonce `248`; API `https://127.0.0.1:8103`, worker `http://127.0.0.1:8113/status`, and compiled release UI `https://127.0.0.1:5113` are healthy. Development UI `5103` is intentionally stopped for memory. `PortfolioAlderWatchdog` remains **Disabled**; no automatic service-start claim applies.

The fresh independent A1 + seven ops review found no new source defect in the reviewed paths. It leaves the visible attachment quarantine browser journey open: keep `TR-T-INBOX` partial until current browser evidence shows upload, the visible quarantine verdict, retry/link, and no-match recovery.

`TR-T-SUPPLY` and `TR-T-FUZZ` have current bounded report evidence, pinned in the acceptance packet. `TR-T-RESTORE` remains partial: isolated PostgreSQL restore covered 54 tables, 0 invalid indexes, 0 unvalidated constraints, but only 52/54 current-live table digests matched; exact snapshot baseline for two mutable worker tables and ACL/RLS aggregate mismatch remain unresolved. Private files, chain, PITR/RPO/RTO, full restore RTO and no-broadcast behavior remain unproved.

Open release gates: visible inbox browser journey; full reference load and current 100k/gas-cap/RSS/disk capacity evidence; complete restore acceptance; clean reproduction; and browser/accessibility completion. The retained 30-minute load report is partial (42,904 samples over 1,804.5 seconds; both allowance lanes failed). No load, capacity, restore or usability pass is inferred from source review.

Reproduction entrypoints (not run for this reconciliation): `npm ci --ignore-scripts`, `npm test`, `npm run build`, `forge test -vv`, `bash tests/round6-perf/run-load-full-p6.sh`, and `powershell -NoProfile -File ops/round4-services.ps1 status`. Public/sanitized proof paths and hashes are enumerated in `docs/independent-review-release-current-20261102.json`; private raw logs, database dumps, credentials, keys, private configuration and chain-state bundles are excluded.

### Clean Linux repro attempts — 2026-11-02 (additive)

The earlier preparation-only statement is superseded by these preserved attempts; no attempt below is a clean `TR-T-REPRO` pass. Episode `20261102-a8-linux` built and ran from sanitized source archive SHA-256 `747a63ad5dfef6a0e29a7f2e756893af9b470dbcb81f7cbf12c41a0c1993d733` in a fresh no-host-port Linux namespace. Offline install, TypeScript/Vite build, unit tests (8/8), Foundry tests (19/19; 128,000 invariant calls, 0 reverts, 0 discards), fresh disposable databases with all 16 migrations, fresh Anvil deployment, compiled release HTTP security (1/1), MetaMask onboarding and the contact/payable workflow passed. The W5 driver stopped at the new policy-contact selector before any policy or wallet transaction; this is a runner locator failure, not product verification. Evidence and volumes remain preserved under `.local/repro/20261102-a8-linux/` and Compose project `alder-repro-20261102-a8-linux`.

Episode `20261102-a9-linux` used fresh source archive SHA-256 `9fecb581a7faa562003d660f28e379c3bb2c0cab3b77a70c8846ada13349397b`. It stopped at full TypeScript compilation because `tests/round6-perf/p6-read-request-350.ts:35` has catch-value properties `code`, `message`, and `name` typed as unavailable. This is outside the repro driver. Its new project and volumes remain preserved at `.local/repro/20261102-a9-linux/` and `alder-repro-20261102-a9-linux`.

The W5 driver was then corrected to select the visible unique contact multiselect and assert that A–C match while D and four pre-existing fixture payables remain held. This driver update has not yet run in a clean episode. Do not count a8 or a9 as a reproduction pass; retain their failed statuses and full archive hashes.

Episode `20261102-a10-linux` used archive SHA-256 `bf8d53c00e752b64f84fd6d59bedbe4a9ff9ec1a002a9e279997558edc619562`. The P6 catch-value typing issue was corrected before this run. Full TypeScript/Vite build, 8/8 unit tests, 19/19 Foundry tests (128,000 invariant calls; zero reverts/discards), 16-migration bootstrap, fresh Anvil deployment and compiled UI HTTP security test passed. The W5 policy preview locator collected both the current-impact and preview tables because both intentionally share the accessible name `Policy impact table`; that produced 16 rows in the driver assertion. This is a runner scoping error, not evidence of duplicated product rows. Episode volumes and raw report remain preserved under `.local/repro/20261102-a10-linux/` and project `alder-repro-20261102-a10-linux`. The driver is being scoped to the preview heading for a fresh run.

Episode `20261102-a11-linux` used archive SHA-256 `8224140fbfd48b2bb9e0ddb98d14c7f0060586b31fc2ec15ecb871e28def2f4b` and stopped before build/runtime because the concurrent `tests/round6-perf/gascap-p6.ts` source had TypeScript syntax errors at lines 27 and 30. This did not reach any application or database service. The stack/volumes remain preserved at `.local/repro/20261102-a11-linux/` and `alder-repro-20261102-a11-linux`.

Episode `20261102-a12-linux` used source archive SHA-256 `363cd675ddfb369eb1954d39745a3a01f7b935190df4bfefca516a482c790292`. Its isolated offline TypeScript/Vite build passed, unit tests 8/8, Foundry tests 19/19 (128,000 invariant calls; zero reverts/discards), exact 16-migration fresh database bootstrap, new Anvil deployment and compiled-UI HTTP-security test 1/1 passed. The real W5 UI workflow published the scoped policy, held D and the four pre-existing fixture payables, approved A–C, and refused review of D. Real MetaMask owner signatures were recorded; the owner then declined the wallet broadcast, and the application durably recorded `wallet_refused` without broadcasting. The following `/resync` returned retryable HTTP 503 `RESYNC_FAILED`. Private worker logs show repeated `PROVIDER_DISAGREEMENT_AT_BOOTSTRAP:HEADER_HASH_RECOMPUTE`, which prevented the indexer from bootstrapping. Root confirmed the a12 Compose stack omitted the supported `--hardfork shanghai` setting used by the canonical services and P6; Anvil therefore used its newer default Prague fork. This is a repro-stack configuration mismatch, not a product-code defect. The runner now pins Shanghai in both Compose profiles and records it in the stack receipt. No transaction was broadcast and no external network was used. Raw replay log SHA-256 `b676c9431518f8c4bed1f4b4d1927a84d70e96d5942d3bf1176639f38c323235`, W5 report `b8e48ad1873f4030352e2ff7f1ced080ac41f9ea4aba497774e8f55a16f8f358`, worker log `00a83b0152d885fc3c7b33f75cf15238d91ee7ec7a9238049535ab401c0d0fd0`. They remain private under `.local/repro/20261102-a12-linux/private-review/`. Project `alder-repro-20261102-a12-linux` was stopped with volumes preserved. The release matrix remains unchanged until the code owner repairs this and a fresh episode completes W5 refusal recovery plus reorg/verifier proof.

Episode `20261102-a13-linux` completed the full clean isolated TR-T-REPRO driver using source archive SHA-256 `252f9bc8421dee4bcdc7d103bfed98d1501b22c953b0d984cd33e66d198131b2` and Shanghai-hardfork Anvil (stack receipt records `anvil_hardfork=shanghai`). The pinned offline build passed, unit tests passed 8/8, Foundry tests passed 19/19 with 128,000 invariant calls, zero reverts and zero discards; fresh `alder` and `alder_v2_test` each applied all 16 migrations. Fresh chain deployment, compiled UI HTTP security 1/1, real Chrome/MetaMask W5 workflow, and independent failure/reorg/verifier replay all completed. W5 report has `passed=true`: normal reviewer UI policy, held D, three independent reviews, wallet refusal recording and nonce invalidation verified at depth 12, exact allowance, payout signature refusal, one real payout batch, three settlements at depth 12, and 13-screen navigation after API restart. The verifier report records independent verifier software on the same local Anvil node, not a separate node. This is a clean reproduction execution; it does not satisfy the separate live capacity, restore, UX, or other release gates. Public artifact inventory has 49 sanitized path/hash/size rows, no raw contents, and SHA-256 `eb74a9965010dd4455976017574facbb87e6279cdee87e483e93ae56e62706e8`; completion receipt SHA-256 `706cf984cd47d95c2615347d27d07f143b8217f3f1df36d27272785ed8f64dfe`. Exact source manifest SHA-256 `6a8c58e1a21b8f16454c6d63d5caeb2220c1b7087a58ebbdf66a5c1d82464da4`, image ID `sha256:4038fff764eaaa9de43d7274dbcd5817fcc79854c98fa335fc1285c9fd54687a`. Private raw W5 report SHA-256 `4f78ccc2aca119634670ba682444acf9630e67fe782fb8747cab519bdeae06c5`, verifier report `c48f4a9953de0a63f5b8684044bc85384db0ec8d7508a945c1e3cd7832109a4d`, reorg report `48ab86f077e8f263b6b31e939f6f341a225eae09810c771160b841aaa110aac3`; private proof remains under `.local/repro/20261102-a13-linux/private-review/` and Compose project `alder-repro-20261102-a13-linux`. Stack stopped with volumes preserved. The original 32-ID/13-screen matrix remains with root for exact assertion mapping; no overall release-complete claim is made.
