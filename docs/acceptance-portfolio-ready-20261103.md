# Alder portfolio-ready acceptance packet — 2026-11-03

**Readiness: `GO_PORTFOLIO` subject to final independent review.** Substantive mandatory evidence passes. R3 packet companion binding and final independent approval remain pending. Offline SSD archive round-trip is verified; restore from this new archive was not run.

## Acceptance policy

- Mandatory: correctness, security, durability, demonstrated database/private-file/chain recovery, reproducible source/build package, and honest operator handoff.
- Advisory: numerical performance, capacity, hardware, disk footprint, and RPO/RTO speed. A miss or absent measurement is **not PASS**.
- Human/accessibility, non-edge/native TLS/manual wallet, separate Windows runtime, and clean-host checks remain waived only as blockers where authorized; waived does not mean executed.
- Historical summary stays 4 executed-pass, 20 reviewed-pass, 8 partial, 0 fail, 0 not-run. Round 7 evidence does not silently rewrite it.

## Current rollout and archive snapshot

Current local rollout evidence: API `8103` and release `5113` strict-CA HTTPS health both returned 200; served `dist` index hash matches published bytes; retained chain genesis/head 3442/hash and Safe nonce 248 are preserved. The separate 13-route browser smoke passes via exact local-server SPKI pin with zero page/server errors and no financial mutation. Native Chrome CA mode failed `ERR_CERT_AUTHORITY_INVALID`; that check is waived, not passed.

Final current R3 source package is `.local/portfolio-release-20261103-r3/`: archive SHA-256 `dc2ec8cecc97dd63d25eeae60e14c6e5e1692a150eaad48a5be0b66a35fc59a1` (847,779 bytes), source-manifest SHA-256 `dd00ec4bb02e46a719912d459825156c5bc3b883a60b87cc92bb2faa4df97fa4`, release-manifest SHA-256 `851d1b2defa582f32c8f23c9869be42c875038eb143c33f280724f991218a2c6`. All 423 archived member sizes/digests verify. The mutable acceptance packet is excluded to avoid circular hashing; main will bind its companion after packet freeze. R2 is superseded; R1 is stale.

## Mandatory evidence and finalization

| Gate | State | Required closure evidence |
|---|---|---|
| Cache late-commit PostgreSQL proof | PASS | Latest three-case live PG receipt `.local/round7-readiness-pg-1793702434840.json`, SHA-256 `b78ade39118b955c327943c1b7e08ede09456d9c2076065d10a32f932a4b8ccc`; all reported flags true via `alder_app` / `SET LOCAL ROLE`, source pin `679c5b…`. |
| Private-file restore | PASS | Fresh wrapper-native run C `fullWorkflowPass=true`; copied-volume readback/modes, actual read-only API mount, strict-TLS health, chain rebuild head 3442, signer false, broadcast false. SHA-256 `7a28fe6f92a1cf4193a505cf536f4dc23e9cff9fb0cd2c7d1802ca4f3e0f933c`. |
| Settled-payable refreeze | PASS | Final-cycle v2 proves authorized preparer receives `409 PAYABLE_ALREADY_SETTLED`; not a new on-chain permanent-ID reuse proof. |
| Current reproducible source/build bundle | PASS | Final R3 archive SHA `dc2ec8cecc97dd63d25eeae60e14c6e5e1692a150eaad48a5be0b66a35fc59a1`; 423 member sizes/digests verified. Acceptance companion binding follows packet freeze. R2 superseded; R1 stale. |
| Current local rollout health | PASS | API/release strict-CA HTTPS 200; served index hash verified; 13/13 browser routes pass via exact local-server SPKI pin with zero JS/server errors. Native Chrome CA failure is preserved as waived/not passed. |
| Independent review | PENDING | Main review of the completed packet; candidate `GO_PORTFOLIO` if it passes. |
| Offline canonical backup capture | RECORDED | `.local/portfolio-final-backup-receipt-20261103.json` SHA `e1721e367cb8901445f5b6a70b32c3bc805291117585990a7fae9394ec1d0bc7`; 1,247 files, verified manifest/dump/private-copy digests, chain head 3442. Actual restore not run. |
| SSD encrypted backup round trip | VERIFIED | `.local/ssd-recovery/20261103T105513Z/receipt.json` records 1,248 members and `roundtrip_verified=true`; restore from this new backup was not run. |
| Final reconciliation | PENDING | Independent review and post-freeze R3 companion binding remain pending. SSD archive round-trip is verified; restore from this new backup was not run. |

## New round 7 evidence

| Proof | Result and boundary | SHA-256 |
|---|---|---|
| `.local/round7-current-access-20261103T104747Z/receipt.json` | PASS: exit 0, `sourceChanged=[]` across pinned app/API, web, packages, services; binds current revocation/fault proof. | `21bab3bcd08e91e9524f86995159e67445c482986edea6f046a3443ed9123020` |
| `.local/portfolio-rollout-20261103T104456Z/receipt.json` | PASS scoped health: strict-CA API/release 200, served dist index hash matches, chain head 3442 and nonce 248 preserved. Aggregate false only due waived native Chrome CA smoke. | `1bd97a1fd9584d12555475ac182e03fe8ef7b42750e7327981e2dc3304105893` |
| `.local/portfolio-rollout-20261103T104456Z/browser-smoke-spki.json` | PASS: all 13 routes with exact local-server SPKI pin; zero page/server errors; no financial mutation. | `3f06f8a39d8bd474922de37d5cb978e8621e3bb331e6dd95a6f401a2281600dc` |
| `.local/portfolio-rollout-20261103T104456Z/browser-smoke.json` | Native Chrome CA trust failure preserved: ERR_CERT_AUTHORITY_INVALID; waived, not a pass. | `d153b1693236c7e8c723bfeefc0ec2c242a1d53d20e77e453b9671ea67968c8d` |
| `evidence/round7-access/revocation-convergence-R7REV-MW0KDJ30.json` | PASS, current-source-bound: revocation SSE/401/zero sessions; RPC outage with outstanding worker request; restored worker resync converged in 1,660ms. | `ec1c6c728acdef138b5a31ed16893f359bed9c13885a9d49309e631292b261a8` |
| `.local/round7-readiness-pg-1793702434840.json` | PASS: latest live PG cache receipt, all three cases/flags; source pin matches current eligibility source. | `b78ade39118b955c327943c1b7e08ede09456d9c2076065d10a32f932a4b8ccc` |
| `.local/portfolio-release-20261103/source.tar.gz` | R1 stale/retained; not current. | `4c02a247d44dcfbe2136b0e0ab856cb318de9def29f0da006207a874845dc1d5` |
| `.local/portfolio-release-20261103/source-manifest.json` | R1 manifest retained as history; not current. | `de7334037ddf6777c58e1630759040392f6ce0b5882f866f325f54f26dad3d05` |
| `.local/portfolio-release-20261103/release-manifest.json` | R1 release manifest retained as history; not current. | `d7b192748b253ef7db303430beee83d7da87da239e7fb7a2b8f3ce3718b2f68f` |
| `.local/portfolio-release-20261103-r2/source.tar.gz` | R2 superseded by final R3; not current. | `e0a514bc13ec629590f5060bad4d54518d5d19e2467b3de10e5c60066df90eac` |
| `.local/portfolio-release-20261103-r2/source-manifest.json` | Final R2 source manifest; 423 current source pins. | `c2ac9386e0d7cb42092562509eaa7b5c7fc260a7f601419da319dc3ea2884910` |
| `.local/portfolio-release-20261103-r2/release-manifest.json` | Final R2 release manifest binds source archive/toolchain/current package pins. | `20175a7c664c2ec20eec12025d70f4df91feeebaeb0c8cc3645327578993394f` |
| `.local/portfolio-release-20261103-r3/source.tar.gz` | Final current R3 archive, 847779 bytes; hash matches manifests; all 423 member sizes/digests verified. | `dc2ec8cecc97dd63d25eeae60e14c6e5e1692a150eaad48a5be0b66a35fc59a1` |
| `.local/portfolio-release-20261103-r3/source-manifest.json` | Final R3 423-member source manifest. | `dd00ec4bb02e46a719912d459825156c5bc3b883a60b87cc92bb2faa4df97fa4` |
| `.local/portfolio-release-20261103-r3/release-manifest.json` | Final R3 release manifest; acceptance companion is separate and pending post-freeze binding. | `851d1b2defa582f32c8f23c9869be42c875038eb143c33f280724f991218a2c6` |
| `.local/round7-evidence-recovery/initial-failed-app-chain-proof.json` | Recovered byte-identically to the original failed artifact SHA `61331b1bd007ab7a92496a06bfbce7cfad1213bc22156e076537789679ecda9a`; failed assertion remains failed. | `61331b1bd007ab7a92496a06bfbce7cfad1213bc22156e076537789679ecda9a` |
| `.local/round7-evidence-recovery/receipt.json` | Recovery receipt documents reconstruction from prior complete tool output and digest match; overwrite event remains disclosed. | `957efb2dc342b79687827aa8eda2610a2cba9ab7e489df86c3db542f5a9e8caa` |
| `.local/round7-final-cycle-20261103T103955Z/proof.json` | PASS for exactly three actual local EOA payouts; exact units 1100000/2200000/3300000; actual deltas -6600000/+1100000/+2200000/+3300000; 3 verified settlements; repeated resync duplicate effects 0; sourcePins unchanged. settledPayablesRefreezeStatus=409, `PAYABLE_ALREADY_SETTLED`, actor `preparer`; this closes the API/domain refreeze assertion, not permanent on-chain ID reuse. | `1d4943eed95a4e7a114f5a072b119dfb6a6f36399364f10072401d5efb35d7de` |
| `.local/scratch-r6/runs/p6-20261103T103303Z-cacheprobe/diagnostic-summary.json` | 30s diagnostic only: 600 reads, 150 writes, 10 SSE subscribers, zero HTTP/SSE errors, zero accounting defects, zero outsider leak responses; read p95 546.29ms (advisory miss). Not a full 1800s load test and not live PostgreSQL cache concurrency proof. | `e2ceb6d15f420bfbf3e3a1bd2be9f6b0c8b4a89513b547b3b04ab6210b9eaca1` |
| `.local/round7-finish-r7finish-20261103-policy-c0ff4977d2b4-resume/receipt.json` | Source-pinned PostgreSQL policy guard helper only: unmatched result 422 POLICY_UNMATCHED and no review/event side effects. No HTTP batch-freeze route claim and not the separate cache late-commit proof. | `e2eaedec6c72708e231ed5089c32437981e768469eac4a3fca33b2cb2d9f57da` |
| `.local/backups/wal-archive/round7-20261103-scheduled/continuous/continuous-proof.json` | Executed authenticated two-cycle continuous-WAL recovery; both committed markers recovered; intervals 20.360s and 30.201s. Speed advisory. | `830a597246d9143151e4cb04f92aca0164231c5cf667cc48035c9beeb91e48f3` |
| `.local/round7-restore-20261103-appchain-c/app-chain-proof.json` | Executed isolated DB/chain/API/rebuild core. 1231 source-manifest files verified; exact chain lineage/head 3442; 3443 rebuilt headers; no signer/broadcast; RTO 22.297s excludes private destination copy/ACL. | `47b82c8d4c470a431f799adb6b6a2124bd84549c448cfc09731557ad294e7506` |
| `.local/round7-restore-20261103-appchain-d/app-chain-proof.json` | Independent repeat of DB/chain/API/rebuild core; RTO 23.565s excludes private destination copy/ACL. | `d2eddd73bd0aca81f4fb2746f1585e656363de3b9da1324f1fd8bcb6048e5f09` |
| `.local/repro/20261102-a13-linux/source-manifest.json` | Historical reproducible A13 source snapshot (417 files; source archive SHA-256 252f9bc8421dee4bcdc7d103bfed98d1501b22c953b0d984cd33e66d198131b2; uncommitted-source snapshot). Not a clean-host/current-tree replay. | `6a8c58e1a21b8f16454c6d63d5caeb2220c1b7087a58ebbdf66a5c1d82464da4` |
| `docs/final-functional-review-20261103.md` | AI source review; reviewed claims remain reviewed, never execution. | `63fb896c82d74704f9ed9561942ad9594d11a3d88495849c22366b10f8261314` |

### Recovered initial failed restore artifact

The original failed head-comparison proof was overwritten during the run-B wrapper issue. `.local/round7-evidence-recovery/initial-failed-app-chain-proof.json` is now recovered from the complete prior tool output and hashes to the exact previously recorded original SHA-256 `61331b1bd007ab7a92496a06bfbce7cfad1213bc22156e076537789679ecda9a`; recovery receipt `957efb2dc342b79687827aa8eda2610a2cba9ab7e489df86c3db542f5a9e8caa` documents the method. The overwrite event remains disclosed. This proof records a failed assertion and is not counted as a restore pass; fresh wrapper-native run C remains the passing restore evidence.

### Current-source revocation and fault proof

Current-access binding receipt `.local/round7-current-access-20261103T104747Z/receipt.json` SHA-256 `21bab3bcd08e91e9524f86995159e67445c482986edea6f046a3443ed9123020` exited 0 with `sourceChanged=[]` across pinned `apps/`, `packages/`, and `services/` sources. It links current proof `R7REV-MW0KDJ30` (SHA-256 `ec1c6c728acdef138b5a31ed16893f359bed9c13885a9d49309e631292b261a8`): revocation SSE and next-session 401/zero sessions at 1,038ms; RPC fault held worker resync outstanding, then worker-backed resync converged in 1,660ms. This closes the old source-binding limitation for the updated proof. The older unbound R7REV receipt is superseded for this current-source assertion.

### Current-source final cycle

The mandatory current-source final-cycle v2 passed its scoped assertions with listed source pins unchanged during the run. It executed three actual local EOA payouts at exact units `1100000`, `2200000`, `3300000`; balance deltas `-6600000`, `+1100000`, `+2200000`, `+3300000`; three verified settlements; and repeated resync with zero duplicate effects. This is not the separate reproducible current-tree source/build bundle gate and not a new on-chain permanent-ID reuse proof; the earlier A13 source-reviewed contract remains reviewed. The final source archive is separately hash/member verified; the 13-route local SPKI health check has passed and the offline backup receipt is linked; independent review and post-freeze companion binding remain.

**Refreeze correction:** the authoritative proof is `.local/round7-final-cycle-20261103T103955Z/proof.json` (SHA-256 `1d4943eed95a4e7a114f5a072b119dfb6a6f36399364f10072401d5efb35d7de). It records actor `preparer`, HTTP `409`, code `PAYABLE_ALREADY_SETTLED`; the domain refreeze assertion passes. Do not use the earlier 10:37:38 proof’s owner-role 403 for this assertion.

### Diagnostic cache/load observations

The 30-second diagnostic recorded 600 reads, 150 writes, 10 SSE subscribers, zero HTTP/SSE errors, zero accounting defects, zero outsider leak responses, and read p95 **546.29 ms**. This misses the frozen 300 ms read target and is not a full 1,800-second P6 run. Numerical performance is advisory and not passed. The zero-defect observations are limited to this sample; cache late-commit concurrency still requires the separate pinned PostgreSQL receipt.

### Recovery boundaries

Continuous WAL proof recovered both markers in 20.360s and 30.201s. Fresh wrapper-native run C proves actual private-file destination copy/readback/modes, API read-only mount, coherent DB/chain lineage, strict-TLS health, full rebuild, signer false and broadcast false. Speed remains advisory.

### Offline canonical backup receipt

The offline canonical backup capture receipt `.local/portfolio-final-backup-receipt-20261103.json` (SHA-256 `e1721e367cb8901445f5b6a70b32c3bc805291117585990a7fae9394ec1d0bc7`) records backup `codex-round6-20261103T105405Z`: 1,247 files, verified manifest/dump/private-copy digests, chain ID `0x7a69`, genesis `0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec`, head/best block 3442, and 3444 block files.

The SSD encrypted archive receipt `.local/ssd-recovery/20261103T105513Z/receipt.json` has SHA-256 `e005ab6e501075a0374755da9d70308fa6673d45da83be5e3a1a395d6986b642`: archive `E:/portfolio-build-archives/alder-backup-20261103T105513Z/backup.tar.aesgcm`, 1,248 members, ciphertext SHA-256 `435e2925b9c2737801004411d5a445b61d1778500ac8c06254a8cfdc102314c6`, plaintext SHA-256 `8915cc69feef3d1346ce1c1f26bc94a1f8b1fd44720880974bb63613d227f16e`, and round-trip verified. Key material is not included in this packet. Restore from this new SSD archive was **not run**; the prior full private restore proof is a separate restore run.

Coordinator reports services restarted after backup: chain 31368, API 41204, worker 39724, release 39680; retained chain head 3442, nonce 248, and genesis unchanged. Frozen post-backup rollout receipt `.local/portfolio-rollout-20261103T104456Z/receipt.json` SHA-256 `a81f6b67011cadf2221d6681d4d6c5ceaf2823b9468e6b57c30eafc18193e095` records pass=true: API/release/worker HTTP 200, worker active with zero failures, retained PostgreSQL volume, chain head 3442, Safe nonce 248 and genesis unchanged; all 13 SPKI-pinned browser routes passed. Native Chrome CA trust failure remains waived/not passed. The new SSD archive restore was not run.

### Current screen source pins

The 13 current screen component pin maps in the JSON were refreshed from the verified R3 `source-manifest.json`; prior pin values are retained per screen in `historical_component_sha256_before_refresh`. This updates source metadata only and does not upgrade any screen workflow execution status.

### Current source archive verification

Final current R3 package `.local/portfolio-release-20261103-r3/` has archive SHA-256 `dc2ec8cecc97dd63d25eeae60e14c6e5e1692a150eaad48a5be0b66a35fc59a1`, source-manifest SHA-256 `dd00ec4bb02e46a719912d459825156c5bc3b883a60b87cc92bb2faa4df97fa4`, and release-manifest SHA-256 `851d1b2defa582f32c8f23c9869be42c875038eb143c33f280724f991218a2c6`. The 847,779-byte archive hash matches both manifests; all 423 members match size and SHA-256. The mutable acceptance packet is excluded by design and will be companion-bound after freeze. R2 is superseded and R1 stale.

### Advisory measurements and waivers

| Area | Recorded result | Portfolio treatment |
|---|---|---|
| Full P6 load | Previous 1,806.8 s run: read p95 432.3 ms and 228 read errors; current 30s diagnostic: 546.29 ms read p95 | Advisory misses; neither is PASS for frozen full profile |
| RSS / disk / reference-host thresholds | Not measured; disk traversal deferred during load | Advisory, NOT MEASURED, not PASS |
| RPO/RTO speed | Bounded observed WAL and restore-core timings above | Advisory; correctness/recovery proof remains mandatory |
| Manual human/accessibility/wallet/non-edge/Windows/clean-host checks | Waived where authorized | Waived, not executed when absent |

## Exact acceptance population (original order)

| # | ID | Historical status / basis | Portfolio disposition | Current mandatory note |
|---:|---|---|---|---|
| 1 | `TR-T-FLOW` | pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 2 | `TR-T-INBOX` | reviewed-pass / mixed | evidence_carried_forward | see linked claims and open gates |
| 3 | `TR-T-REVIEW` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 4 | `TR-T-DESTINATION` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 5 | `TR-T-POLICY` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 6 | `TR-T-UNITS` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 7 | `TR-T-BINDING` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 8 | `TR-T-QUORUM` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 9 | `TR-T-1271` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 10 | `TR-T-ATOMIC` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 11 | `TR-T-REPLAY` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 12 | `TR-T-FUZZ` | pass / executed | evidence_carried_forward | see linked claims and open gates |
| 13 | `TR-T-ALLOWANCE` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 14 | `TR-T-STATUS` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 15 | `TR-T-CANCEL` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 16 | `TR-T-REORG` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 17 | `TR-T-VERIFY` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 18 | `TR-T-ISOLATION` | partial / mixed | evidence_carried_forward | partial: accepted revocation scope passes; pinned live cache late-commit proof and remaining isolation/quota assertions open |
| 19 | `TR-T-CSRF` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 20 | `TR-T-DURABLE` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 21 | `TR-T-FAULT` | partial / mixed | evidence_carried_forward | accepted scoped fault/recovery proof; no source binding in R7REV receipt; avoid broader convergence claims |
| 22 | `TR-T-SSE` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 23 | `TR-T-UX` | partial / mixed | evidence_carried_forward | see linked claims and open gates |
| 24 | `TR-T-BROWSER` | partial / mixed | current 13-route SPKI smoke executed pass; native browser CA failure waived | 13/13 routes, zero page/server errors; SPKI trust mode is not native CA trust. |
| 25 | `TR-T-LOAD` | partial / mixed | advisory_not_pass | numerical profile advisory; correctness findings still handled separately |
| 26 | `TR-T-CAPACITY` | partial / mixed | advisory_not_measured | advisory footprint/RSS metrics not measured; not a PASS |
| 27 | `TR-T-RESTORE` | partial / mixed | mandatory recovery evidence PASS; speed advisory | PASS for linked WAL and full private/DB/chain restore. RPO/RTO timing remains advisory. | The initial failed comparison proof was recovered byte-identically (digest 61331b1b…); it remains failed, and the overwrite event remains disclosed.
| 28 | `TR-T-MIGRATION` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 29 | `TR-T-REPRO` | pass / mixed | final R3 source archive verified; companion bind after freeze; clean-host replay waived | R3 is current, R2 superseded, R1 stale. Package review does not claim clean-host execution. |
| 30 | `TR-T-SUPPLY` | pass / executed | evidence_carried_forward | see linked claims and open gates |
| 31 | `TR-T-EXPORT` | reviewed-pass / reviewed | evidence_carried_forward | see linked claims and open gates |
| 32 | `TR-T-GATE` | partial / mixed | candidate GO_PORTFOLIO pending independent review | Substantive mandatory evidence passes; candidate GO_PORTFOLIO subject to final independent review. R3 companion binding pending; SSD round-trip verified, restore from this new backup not run. |

## Exact screen population (original order)

| # | Screen ID | Historical workflow status | Current-source/browse boundary |
|---:|---|---|---|
| 1 | `overview` | partial_workflow_unexecuted | Current-source browser proof of live totals/chain balance, held/pending cases and end-to-end settlement. |
| 2 | `payables` | partial_workflow_unexecuted | Visible attachment quarantine browser journey remains unverified; also execute duplicate/no-match CSV, manual intake and upload → quarantine verdict → retry/link. |
| 3 | `payable` | partial_workflow_unexecuted | Browser proof of revision conflict, review denial, destination hold and attachment expiry/recovery. |
| 4 | `policy` | partial_workflow_unexecuted | Current role-by-role browser/API workflow for mandatory review and no custody mutation. |
| 5 | `batch` | partial_workflow_unexecuted | Selection/freeze conflict, 100-item gas refusal, signed-original hold and cancel-pending browser path. |
| 6 | `intent` | partial_workflow_unexecuted | Wallet-facing exact addresses/units/ordered IDs/SafeTx and stale nonce/owner/domain refusal. |
| 7 | `signatures` | partial_workflow_unexecuted | Current wallet typed-sign/refusal, network/account change and duplicate/non-owner behavior. |
| 8 | `execution` | partial_workflow_unexecuted | Payout prepare/broadcast/lost-response/replacement and outer-vs-inner failure; zero-value cancel is not payout. |
| 9 | `settlement` | partial_workflow_unexecuted | Payout reaches depth-12 verified, then reorg retraction; cancellation report is not paid settlement. |
| 10 | `recovery` | partial_workflow_unexecuted | Current outage/deep-reorg, queue retry/exhaustion and verified recovery convergence. |
| 11 | `activity` | partial_workflow_unexecuted | Private/redacted export replay/expiry plus SSE cursor replay/410/redaction UI. |
| 12 | `contacts` | partial_workflow_unexecuted | Contact/destination edit, second-channel verify, signed-intent hold, cancellation and fresh review. |
| 13 | `settings` | partial_workflow_unexecuted | Admin membership/session revocation, last-admin guard and preferences on active source. |

## Source and preservation pins

- Acceptance register: `1b204096f084ec77515193ded3e7c48222c793ee8f3cf06fded4ac865e987551` (32 IDs).
- Screen register: `a2a3999c555c3064a9dfbdf9527cdee2942c4c8121111c44e8ca92a4a4cd4a8c` (13 screens).
- Policy: `8a496fbdc1edd01bac988d90cd3e7dfb5333de732c8995b537621e12b031fde4`.
- Historical packet: `d3592bdb1f60ed882b98861dfe0b647f91c3edc270194a0d1c8a9762e8fd2f5c`; readiness `NO_GO`; original counts preserved.
- The JSON contains the complete historical acceptance objects verbatim and screen objects in original order. The CSV is an ordered 32-row disposition index.
- Source-binding is scoped: final-cycle pins only listed files; accepted R7REV receipt has no source pins; A13 is a bounded archived snapshot and not clean-host/current-tree replay.

