# Publication-candidate verification

Executed on 7 November 2026 using the local review copy.

- Fresh `npm ci` and the TypeScript/Vite build passed.
- `python verify.py` passed eight unit/render/supply tests and three Solidity checks.
- The Solidity checks exercised only-Safe access, exact transfers with replay rejection, and third-transfer rollback.
- The current npm advisory query reported zero findings.
- The build reports a main JavaScript chunk larger than 500 kB. The warning remains visible in the build log.

## Evidence

[Command receipt](verification/review-checks.json) records each command and its exit status. The command logs are in the same directory. [The npm audit result](verification/npm-audit.json) records the advisory query at verification time.

## Scope

The installs used fresh local environments and dependency directories on the original host. The broader original project results are historical measurements, with their original datasets, private runtime state, platform assumptions, and waivers. The full public deployment and full integration campaigns remain separate from these focused publication checks.

The small commands are documented in [the reproduction guide](reproduction.md). The test-to-claim mapping is in [the reviewer guide](../REVIEWER_GUIDE.md).
