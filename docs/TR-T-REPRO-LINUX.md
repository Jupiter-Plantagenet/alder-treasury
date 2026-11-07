# Alder TR-T-REPRO: isolated Linux replay

**State:** the clean isolated Linux `TR-T-REPRO` execution completed in episode `20261102-a13-linux` (source archive SHA-256 `252f9bc8421dee4bcdc7d103bfed98d1501b22c953b0d984cd33e66d198131b2`). This establishes the bounded reproduction results recorded below; it does not by itself close the original 32-ID / 13-screen acceptance matrix or separate live capacity, restore, UX, and other release gates. The Windows bootstrap builds the pinned runner image locally from the already-present base image, acquires the Linux toolchain/browser into ignored private `.local` storage, then creates only a unique Compose project with no published host ports.

## Replay scope

The driver runs Alder by itself. It does not launch or import Folio or Fieldwork. It builds from an allow-listed source archive, creates fresh private app/verifier databases, deploys a new Safe/token/executor to a disposable Anvil instance, starts the real API, indexer worker and compiled release UI, then runs the real MetaMask extension workflow and the independent failure/reorganization/verifier replay.

`tests/round6-repro/compose.yaml` creates a unique Compose project for each episode. The Node hub has `network_mode: none`; the Postgres and Anvil sidecars share the hub's network namespace. Their only app-facing addresses are `127.0.0.1:5543` (Postgres), `127.0.0.1:8547` (wallet and chain truth), `127.0.0.1:8103` (API), `127.0.0.1:5113` (compiled UI), and `127.0.0.1:8113` (worker status). Loopback bridges at 15543 and 18547 serve the already scoped worker/RPC interfaces. Compose publishes no host ports. The browser runs as the image's unprivileged `node` user with the local CA imported into that user's disposable NSS profile and the existing certificate SPKI pin supplied to Chromium.

The project owns its PostgreSQL volume; Anvil starts without a state volume and is fresh per container start. It is pinned to `--hardfork shanghai` to match `ops/round4-services.ps1` and the P6 runtime, and the stack receipt records the selected fork. The bootstrap refuses an existing verifier database or deployment manifest. Runtime credentials, generated accounts, TLS keys, browser profile, and raw proof remain in ignored local or per-run private volumes. The source archive and public artifact manifest contain no wallet profiles, private auth files, runtime data, or raw proof contents. Failed attempts stay in the private proof volume for inspection; cleanup is explicit and scoped to the recorded Compose project.

## Exact pins and rights

See [`tests/round6-repro/toolchain.json`](../tests/round6-repro/toolchain.json) for the machine-readable pins and license notes. The source archive pins `package-lock.json` SHA-256 `195104c5b7187ef47ebfd14fd435aac386ede27f86ecfc8bded3d02d31aac965`. The build base is Debian Bookworm Node `26.7.0` OCI digest `sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32`; the pinned snapshot timestamp is `20261102T000000Z`. Postgres is pinned by OCI digest `sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`. Foundry 1.5.1 archive SHA-256 is `73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88`; solc 0.8.24 SHA-256 is `fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f`.

MetaMask Chrome 13.50.0 is locally acquired from its official release URL and verified against SHA-256 `b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c`. Its custom source-available license permits this local test use; the extension is not redistributed in the source archive. Chrome for Testing Linux is fetched from the official versioned CFT URL after the versioned URL is checked against Google's `known-good-versions-with-downloads.json`. The acquisition records the official metadata file digest, Google Storage generation/ETag/MD5 and content length, then computes and records local SHA-256 values for the downloaded archive and executable in private `browser-linux.json`. Google Storage MD5 is transport integrity metadata, not a publisher signature; the Windows CFT hash is not used as a Linux hash.

The source package preserves Safe 1.4.1 LGPL-3.0 notices and OpenZeppelin 5.0.2 MIT notices. Complete custody, advisory, license and bytecode review remains the separate `TR-T-SUPPLY` scope; this toolchain list is not legal approval.

## Linux execution commands

Run these on a Linux x86_64 Docker host (or in a WSL2 Linux distribution using Docker Desktop's Linux engine). Use one unique lowercase run ID for all steps. The acquisition/build steps are deliberately separate from the isolated runtime so the browser and wallet are not silently fetched during acceptance execution.

```bash
cd /path/to/portfolio-build/alder
export ALDER_REPRO_RUN_ID=20261102-a1-linux
bash tests/round6-repro/source-bundle-linux.sh
export ALDER_REPRO_SOURCE_ARCHIVE="$PWD/.local/repro/$ALDER_REPRO_RUN_ID/source.tar.gz"
bash tests/round6-repro/acquire-linux.sh
docker pull node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32
docker pull postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
ALDER_REPRO_RUN_ID="$ALDER_REPRO_RUN_ID" bash tests/round6-repro/build-image-linux.sh
ALDER_REPRO_RUN_ID="$ALDER_REPRO_RUN_ID" ALDER_REPRO_IMAGE="alder-repro:$ALDER_REPRO_RUN_ID" \
  bash tests/round6-repro/repro-linux.sh
```

The image acquisition commands above are explicit; the runtime scripts use `--pull never` and fail if pinned images are absent. `source-bundle-linux.sh` and `acquire-linux.sh` write only under ignored `.local` directories and refuse to overwrite an existing run artifact. The local acquisition script fills the npm cache against the lockfile and verifies Foundry, solc, MetaMask and the supplied CFT archive hash. The container replay installs from that cache with npm offline mode. `run-internal-linux.sh` drives the build, unit and contract suites, private DB/bootstrap, fresh chain deployment, API/worker/release UI, the W5 browser wallet success/failure/reorg flow, and isolated verifier/replay episode.

At completion, `artifact-manifest.json` is copied to `.local/repro/<run-id>/`; it lists relative artifact paths, byte sizes and full SHA-256 values but not their contents. Raw proof is retained in the Compose project's private `repro_proof` volume. The stack receipt binds the source archive digest, local runner image ID, base images, browser and wallet digests, namespace endpoints and an empty host-published-port list. The private logs and raw reports must be reviewed before any assertion status changes.

To stop while preserving the episode's databases and proof volume:

```bash
bash tests/round6-repro/stack-stop-linux.sh 20261102-a1-linux
```

After exporting and reviewing the proof, deleting only this episode's disposable volumes is explicit:

```bash
bash tests/round6-repro/stack-stop-linux.sh 20261102-a1-linux --delete-owned-disposable-volume
```

## Windows bootstrap boundary

The reproducible target is a Linux x86_64 container namespace, not a Windows-native PostgreSQL/Anvil substitute and not a second physical host. From Windows, use Docker Desktop's Linux/WSL2 engine. Native PowerShell plus the Windows Docker CLI is supported; WSL Docker integration is not required. The wrapper invokes the pinned runner container to create the allow-listed source archive and acquire Linux artifacts, then runs Compose from Windows. No host-installed Node, npm, browser, PostgreSQL or Anvil is substituted.

```powershell
Set-Location C:\Users\user\portfolio-build\alder
powershell -NoProfile -File tests/round6-repro/repro-windows.ps1 -RunId 20261102-a1-linux
```

The run ID must be unique. The wrapper refuses an existing run output, Compose project, or project-labeled volume, builds from the digest-pinned Node base with `--pull=false`, and records a stack receipt before starting the stack so failures can be stopped safely. It does not remove or reuse host containers, persistent chains, databases, volumes or app processes. Stop the recorded episode with `powershell -NoProfile -File tests/round6-repro/stack-stop-windows.ps1 -RunId 20261102-a1-linux`; volumes remain by default. Add `-DeleteOwnedDisposableVolume` only after the private evidence is no longer needed.

The bootstrap confirms that the Docker CLI is connected to a Linux amd64 engine. A Windows container engine or the old `tests/round5-ops/repro-linux.sh` fixed-name harness is not the clean reproduction target. On a native Linux Docker host, the separate acquisition/build/replay commands above remain available.

## Current run history and limits

The following fresh Linux-namespace attempts are preserved as separate episodes. Episode a13 is the completed bounded `TR-T-REPRO` execution; earlier episodes remain historical failures and are not overwritten:

| Episode | Sanitized source archive SHA-256 | Result |
|---|---|---|
| `20261102-a7-linux` | `ae504132d0d25111573fb9b4c2e1ace13824f6dd09fcdcbd817e8e51ea23918f` | Build, unit, contract, HTTP-security and fresh-stack stages passed; W5 stopped because no review policy was created. |
| `20261102-a8-linux` | `747a63ad5dfef6a0e29a7f2e756893af9b470dbcb81f7cbf12c41a0c1993d733` | Build, unit, contract, 16-migration DB, fresh chain and HTTP-security passed; W5 stopped on an exact-label locator mismatch for the visible contact multiselect. |
| `20261102-a9-linux` | `9fecb581a7faa562003d660f28e379c3bb2c0cab3b77a70c8846ada13349397b` | Stopped at full TypeScript compilation due catch-value properties in `tests/round6-perf/p6-read-request-350.ts`. |
| `20261102-a10-linux` | `bf8d53c00e752b64f84fd6d59bedbe4a9ff9ec1a002a9e279997558edc619562` | Build, unit, contract (128,000 invariant calls; zero reverts/discards), 16-migration DB, fresh chain and HTTP-security passed. W5's locator matched both current-impact and preview tables with the same accessible name, so its row-count assertion was invalid. |
| `20261102-a11-linux` | `8224140fbfd48b2bb9e0ddb98d14c7f0060586b31fc2ec15ecb871e28def2f4b` | Stopped at full TypeScript parsing: the concurrent `tests/round6-perf/gascap-p6.ts` update had syntax errors at lines 27 and 30. |
| `20261102-a12-linux` | `363cd675ddfb369eb1954d39745a3a01f7b935190df4bfefca516a482c790292` | Full offline build, unit (8/8), contract (19/19; 128,000 invariant calls, zero reverts/discards), 16-migration bootstrap, fresh chain and HTTP-security (1/1) passed. W5 published the policy through the reviewer UI, held D and all four fixtures, approved A–C, refused the held D review, signed allowance in real MetaMask and captured the owner's wallet refusal. Next `/resync` returned retryable 503 because the stack's Anvil hardfork defaulted to Prague while the supported worker/profile expects Shanghai. |
| `20261102-a13-linux` | `252f9bc8421dee4bcdc7d103bfed98d1501b22c953b0d984cd33e66d198131b2` | Completed the full driver with `--hardfork shanghai`: offline build, unit (8/8), contracts (19/19; 128,000 invariant calls, zero reverts/discards), 16 migrations, fresh chain, HTTP security (1/1), W5 real MetaMask/refusal/invalidation/payout/13-screen flow, plus independent verifier, failure and reorganization replay. Public artifact-manifest SHA-256: `eb74a9965010dd4455976017574facbb87e6279cdee87e483e93ae56e62706e8` (49 artifacts). |

Each project was stopped with its run-specific volumes preserved. Failed attempts remain immutable. A fresh rerun must use a new run ID and current source archive with the Anvil hardfork pinned to Shanghai. A8 and a10 errors were in the driver; neither demonstrated a product failure. A12 went beyond those setup steps but failed because it used Anvil's default Prague fork, not the supported Shanghai configuration; it did not complete the wallet-refusal recovery, failure/reorganization replay or independent verifier episode. No external network or host-published port was used.

The a12 raw replay log SHA-256 is `b676c9431518f8c4bed1f4b4d1927a84d70e96d5942d3bf1176639f38c323235`; W5 report SHA-256 is `b8e48ad1873f4030352e2ff7f1ced080ac41f9ea4aba497774e8f55a16f8f358`; worker log SHA-256 is `00a83b0152d885fc3c7b33f75cf15238d91ee7ec7a9238049535ab401c0d0fd0`. These artifacts remain private under `.local/repro/20261102-a12-linux/private-review/`. Root confirmed the supported runtime and P6 use Shanghai; a12's Compose command omitted `--hardfork shanghai` and therefore started Anvil with its newer default Prague fork. This is an isolated-stack configuration mismatch, not a reason to weaken the worker's supported header checks.

Episode a13's source-manifest SHA-256 is `6a8c58e1a21b8f16454c6d63d5caeb2220c1b7087a58ebbdf66a5c1d82464da4`; its runner image ID is `sha256:4038fff764eaaa9de43d7274dbcd5817fcc79854c98fa335fc1285c9fd54687a`. It used Chrome for Testing `151.0.7922.34` (locally computed executable SHA-256 `0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71`) and MetaMask `13.50.0` (archive SHA-256 `b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c`). The public artifact manifest lists 49 artifact path/size/hash records only; it claims inventory, not acceptance. Its SHA-256 is `eb74a9965010dd4455976017574facbb87e6279cdee87e483e93ae56e62706e8`; completion receipt SHA-256 is `706cf984cd47d95c2615347d27d07f143b8217f3f1df36d27272785ed8f64dfe`. The private W5 report SHA-256 is `4f78ccc2aca119634670ba682444acf9630e67fe782fb8747cab519bdeae06c5`, verifier report `c48f4a9953de0a63f5b8684044bc85384db0ec8d7508a945c1e3cd7832109a4d`, and reorg report `48ab86f077e8f263b6b31e939f6f341a225eae09810c771160b841aaa110aac3`. Raw proof remains under the private `alder-repro-20261102-a13-linux` Compose proof volume and private `.local/repro/20261102-a13-linux/private-review/`; the stack was stopped with volumes preserved.

The complete a13 driver finished with W5 `passed=true`, the allowance refusal and recovery, destination hold, exact depth-12 payment settlement, all 13 screens visited after restart, plus independent software verifier, third-transfer atomic failure, nonce replay, proxy lost-response/crash recovery, and real 15-block reorganization/rebuild checks. It operated only against the one local disposable Shanghai Anvil node; the verifier report records `nodeTrust=single local Anvil; independent software, not independent node`. The release owner must map these artifacts to the original acceptance assertions; this source packet does not change other release gates. Three P6 test-helper files were edited after the a13 archive capture (`load-seed-p6.ts` SHA-256 `0b7300cc182da8ec7041faf1270325b9ad50f49bff7f631152cbb1d53fb5caf4`, `run-load-full-p6.sh` `c2ccf1b12782d0535162638f19ae508bf025e819ad37f03bd6f95243061cacfb`, `start-p6-reference-load-reviewed.ps1` `9fa628a80fb07809acac4d6ba662f71240fcc00df178f4919e7ed7e7923d7561`); those source-only changes were not invoked by a13. The clean Linux TR-T-REPRO driver is now executed, pending assertion-by-assertion matrix reconciliation.
