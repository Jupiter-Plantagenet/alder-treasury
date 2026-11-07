# Shared product-quality charter: three portfolio flagships

## Agreed scope and controlling requirement

George has agreed to all three product briefs and demonstration domains:

1. **Document Operations Agent Workbench:** invoice / purchase-order / receipt reconciliation.
2. **Visual ML Research Workbench:** natural-image classification; flower photographs are the initial dataset candidate, pending exact asset verification.
3. **Treasury & Payments Operations Workspace:** a product team's contractor batch payouts.

All three must be built toward **enterprise-grade engineering and operations with consumer-grade usability and finish**. This charter supplements and overrides any narrower demonstration-only quality assumptions in the earlier briefs. It does not require repositioning the products as consumer businesses, changing the agreed domains, or adopting unnecessary enterprise infrastructure. A complete chosen workflow can be bounded; security, correctness, usability and operations cannot be treated as optional polish.

These are requirements, not accomplished properties, certifications or claims of current production readiness. Proposed engineering blueprints are now prepared under `portfolio-engineering/`; application implementation and runtime acceptance have not started. Approval of briefs/domains/quality targets or planning does not by itself authorize spending, public deployment, real-value transactions or publication.

## Consumer-grade product experience

Each product must have:
- A coherent original design system, consistent navigation, readable hierarchy and useful interaction feedback; no disconnected showcase screens.
- Clear onboarding and first-success workflow, appropriate examples, contextual help and understandable terminology.
- Responsive layouts for supported desktop/tablet/mobile tasks; dense technical workspaces may use intentionally different mobile interactions rather than squeezed desktop tables.
- Keyboard operation, meaningful labels/focus, screen-reader-aware semantics and tested contrast/error presentation across the supported workflows.
- Complete loading, empty, progress, validation, permission-denied, interrupted, retry, offline/service-unavailable and success states where applicable.
- Validation that preserves recoverable user work, explicit confirmation for consequential actions, and no ambiguous or falsely successful operation.
- Browser/device coverage and measured interaction-performance budgets defined before release; a polished screenshot alone does not pass.

## Enterprise-grade engineering and operations

Each product must have:
- Explicit identity, role, workspace/object permission and trust models; server-side enforcement and cross-user/workspace negative tests wherever isolation is claimed.
- Secure secrets handling, session lifecycle, input/file validation, dependency/license inventory and threat-informed controls; no privileged production credentials in the frontend or repository.
- Explicit data retention/export/deletion policies, private-data boundaries and redacted logs. Document unavoidable public-chain history or externally transmitted model data rather than promising impossible erasure/locality.
- Versioned API/data contracts, schema migrations, durable state, idempotency/concurrency rules, accountable changes and recoverable long-running work.
- Structured logs, metrics and correlation identifiers tied to actual operations; visible health/lag and useful incident diagnostics, not invented telemetry.
- Deployment/environment documentation, health checks, safe migrations, upgrade/rollback procedures and tested backup **restoration**, with recovery boundaries stated.
- Measured capacity/resource use and load/failure behavior for a declared reference workload and supported environment. Availability, latency, recovery-time, data-loss and cost targets must be specified and tested; do not invent universal scale or an unoperated uptime history.
- Automated unit, integration, browser and failure/recovery tests; reproducible builds; reviewed changes and CI release gates. Tests exercise the actual system boundaries, not only mocked happy paths.
- Actionable operating/runbook documentation, error handling, support diagnostics and maintenance instructions so someone other than the author can operate the product.

Security controls and engineering tests do not establish SOC 2, ISO certification, regulatory compliance, a security audit or real-funds safety. Such claims require their own evidence and scope; none is implied by this quality charter.

## Domain-specific quality gates

### Document Operations Agent Workbench
- Genuine document/model/tool execution with source-linked fields, clear extracted/computed/lookup-derived provenance and bounded write authority.
- Exact, versioned change proposals; stale/rejected approval prevents protected actions; conflicting or missing evidence has a complete correction/escalation path.
- Independently checked final records, duplicate prevention and interruption/recovery tests.
- Task quality, unsupported values, review burden, latency and model/API costs measured separately on a declared task population; useful behavior, not only passing infrastructure tests.

### Visual ML Research Workbench
- Real training and inference, immutable dataset/annotation/split/model identities, measured per-run outputs and meaningful example-level inspection.
- Leakage controls, independent metric recomputation, honest model usefulness criteria and clearly separated exploratory validation versus final holdout use.
- Durable worker state, atomic checkpoints, tested cancellation/resume and safe model-artifact loading.
- Reproducible acquisition/environment/model bundles with actual data/model/dependency rights reviewed; declare numerical and hardware reproducibility limits.

### Treasury & Payments Operations Workspace
- Exact signed intent and integer asset accounting; on-chain authority plus separately enforced application permissions; no backend pretending to sign as the user.
- Complete proposal/signature/execution/settlement lifecycle, correct cancellation/invalidation and independently verified contract effects.
- Contract unit/fuzz/invariant tests, API/browser integration and adversarial authorization/replay/concurrency tests. Independently review the contract/security boundary before any real-value release; local/test execution is not a safety certification.
- RPC/indexer outage, duplicate events, backfill, replacement/revert and declared reorg reconciliation tests; private payable evidence remains separate from public chain data.

## Evidence-based release gates

All gates apply to each product; acceptance is against its own requirements, not competitor/framework/baseline benchmarks.

1. **Specified:** scope, supported platforms/users, trust boundaries, data contracts, measurable quality/performance/recovery targets and test cases are committed before acceptance execution. Unresolved parameters remain visible, not silently guessed.
2. **Functional:** the complete supported workflow operates end to end with real underlying execution, negative/no-op cases and persistence across refresh/restart. No placeholders satisfy a claimed feature.
3. **Usable:** supported users can complete their tasks through the interface; onboarding, accessibility, responsive behavior and all applicable states are exercised. Automated checks supplement actual usability inspection.
4. **Secure and correct:** threat model, permission/data-isolation tests, artifact/input checks and domain invariants pass. Known critical unmitigated defects block release; high-risk issues require resolution or explicit documented review before release.
5. **Operational:** defined load/failure tests, health/observability, migration/rollback and backup/restore exercises produce retained results. Targets and achieved results are reported separately.
6. **Reproducible:** a separate clean environment follows the documented setup and independently exercises the supported workflow/tests; hidden paths, private accounts and warm caches do not silently carry the result.
7. **Deliverable:** inspectable source with intentional license/visibility when authorized, release/version, working application, architecture/operations docs, raw validation evidence, screenshots/video and truthful limitations.

A gate is complete only when the corresponding evidence exists. A full deployment manifest, unit-test count, CI file or attractive UI does not by itself establish enterprise or consumer quality. Performance/scaling/recovery measurements are own-system validation, not comparative benchmarking.

## Next phase

Product/domain selection and the requested mockups are complete. Proposed architecture and delivery blueprints for all three are prepared at `portfolio-engineering/ENGINEERING-OVERVIEW.md`, with screen contracts, critical proofs, acceptance tests, work-package DAGs and unresolved environment/rights/security gates. Next is review of those recommendations and separate authorization for local bootstrap and early technical proofs. Preserve shared quality requirements without forcing all products onto the same stack or combining them into one application. Implementation can be parallel once those contracts and the implementation authorization are settled.
