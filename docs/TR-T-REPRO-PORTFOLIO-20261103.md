# Alder portfolio source package and replay

**Current source package:** R3 is an immutable source archive under `.local/portfolio-release-20261103-r3/`. It excludes the mutable final portfolio acceptance packet (`docs/acceptance-portfolio-ready-20261103.{md,json,csv}`) to prevent a circular archive-hash reference. The frozen `docs/acceptance-policy-20261103.md` and historical `docs/acceptance-final-current-20261102.json` remain source members. Deliver the completed acceptance packet alongside R3; after the packet is frozen, bind its three file hashes to the R3 archive with the companion delivery manifest command below. R1 and R2 remain preserved.

**W14 source review disposition:** reviewed, not executed. The archive records current source, package-lock and toolchain pins, the current UI candidate and served `dist` inventories, plus build and replay commands. Clean-host and independent runtime execution are waived by the acceptance policy and are not claimed here.

## Package contents and exclusions

`ops/package-portfolio-source.py` creates a deterministic, allowlisted source archive and complete per-file SHA-256 inventory for `apps/`, `packages/`, `services/`, `db/`, `ops/`, `tests/`, `contracts/src/`, `contracts/test/`, `vendor/`, release documentation, and root build/config files. It excludes the mutable acceptance packet, `.local`, evidence, runtime logs, database/private runtime state, dependency trees, `dist`, caches, compiler outputs, credentials, wallet profiles, and key/database files; it refuses symlinks and overwrites. The coordinator-built `.local/release-candidate-20261103` UI is recorded separately and its files are not added to the source archive.

The current staged UI was built after the Destination ActionForm accessibility fix. The coordinator reports the published `dist` contains the same four UI assets as the candidate. R3 pins candidate and served trees separately while excluding generated `dist` bytes from the source-only archive. Build/HTTP rollout receipts remain separate evidence. The historical A13 archive and R1/R2 packages are not modified.

## Finalize the immutable source archive

After source freeze, from the Alder checkout:

```powershell
Set-Location C:/Users/user/portfolio-build/alder
python ops/package-portfolio-source.py --finalize-after-freeze --revision 3
Get-FileHash .local/portfolio-release-20261103-r3/source.tar.gz, .local/portfolio-release-20261103-r3/source-manifest.json, .local/portfolio-release-20261103-r3/release-manifest.json -Algorithm SHA256
```

R3 contains `source.tar.gz`, `source-manifest.json` (every archived path, byte count, file hash and archive hash), and `release-manifest.json` (archive/manifest binding, package-lock and toolchain pins, candidate and served UI inventories, and executable commands). Final outputs are never overwritten.

## Bind the separately delivered acceptance packet

Once the final packet files are frozen, generate `delivery-manifest.json`:

```powershell
python ops/package-portfolio-source.py --bind-acceptance-companion --revision 3
Get-FileHash .local/portfolio-release-20261103-r3/delivery-manifest.json -Algorithm SHA256
```

The companion manifest records the R3 archive, source-manifest and release-manifest hashes plus path, byte count and SHA-256 for the final Markdown, JSON and CSV packet. It deliberately has no self-hash. Deliver the three packet files and this manifest alongside the immutable archive. If the acceptance packet changes after binding, do not rewrite R3; retain the existing delivery manifest and create a separately named updated companion manifest through an explicit new command/revision.

## Executable build and isolated replay

Runtime pins are Node `v26.7.0`, npm `11.19.0`, Foundry `1.5.1`, solc `0.8.24`, Postgres by OCI digest, MetaMask Chrome `13.50.0`, and Chrome for Testing Linux `151.0.7922.34`. Linux Chrome archive and executable digests are in the release manifest. Browser and wallet binaries, profiles and acquisition cache are not in the source archive.

Build from an extracted source package in a pinned Node environment:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

For the isolated Linux replay, use a unique run ID and commands in `docs/TR-T-REPRO-LINUX.md`: acquire pinned artifacts with `tests/round6-repro/acquire-linux.sh`; pull exact digest-pinned Node/Postgres images; build the runner with `tests/round6-repro/build-image-linux.sh`; then run `tests/round6-repro/repro-linux.sh`. Copy the archive and source manifest into `.local/repro/<run-id>/` first, because the replay driver reads them there. Use a fresh ID and do not modify A13. Keep the Shanghai hardfork pin in `tests/round6-repro/compose.yaml`.

The replay script covers offline install/build, unit/Foundry suites, disposable DB bootstrap, fresh Anvil deployment, API/worker/UI, HTTP security, wallet flow, and verifier/reorg episode. These are executable commands, not a new execution claim. Clean-host independent execution, separate Windows runtime, and additional non-edge checks remain waived/not executed under `docs/acceptance-policy-20261103.md`.

## Toolchain metadata note

`tests/round6-repro/toolchain.json` leaves the Linux browser digest null. The archived A13 acquisition records the Linux Chrome archive SHA-256 `ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8` and executable SHA-256 `0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71`. The release manifest carries these pins without bundling browser bytes. Compare fresh acquisition outputs to those pins before a replay.
