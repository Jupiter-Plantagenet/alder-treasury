# TR-D-CUSTODY / TR-D-PIN — exact source retained; independent approval NOT passed

## v2 supply-chain correction

- Actual Safe1.4.1 Solidity source remains. The npm `@safe-global/safe-contracts` JS package and its legacy ethers/elliptic graph have been removed from package.json, lockfile and installed build tree. No custom multisig, fake signatures, approved-hash shortcut or custody bypass substitutes for Safe.
- Immutable official upstream commit **bf943f80fec5ac647159d26161446ac5d716a294**, resolved from the official v1.4.1 Git ref response retained at `evidence/safe-v2-tag.json`.
- `vendor/safe-1.4.1/SOURCE.json` records official archive URL/SHA256, original npm SHA512 integrity,45 retained file SHA256 hashes, original LGPL license and source notices. Every official Solidity source was byte-for-byte compared against the installed official npm1.4.1 package before uninstall. Fresh immutable raw Safe.sol fetch again matched **efd3301ed5c6bf522fb3a7a43be4a27341e65dff6d1fee04f8567f304a67e365**.
- Foundry remaps `@safe-global/safe-contracts/` directly to the vendored source. Solidity0.8.24/shanghai/optimizer200 and actual Safe singleton/factory/atomically initialized2-of-3 EOA proxy are exercised. No modules, guard, fallback or app DELEGATECALL generated. Standard Safe proxy delegation is not confused with app operation1.
- Real typed owner signatures come from viem; current browser tests sign within an explicitly labelled isolated EIP1193 fixture adapter. App processes contain no owner keys or signing endpoint. Outer sender is separate from custody quorum.
- `npm ci --ignore-scripts` succeeded and current audit reports0findings. esbuild0.27.2 is deliberately exact-pinned before the affected0.27.3+ advisory range; Safe old JS vulnerabilities are eliminated from the installed dependency graph, not dismissed as unused. Package metadata/locks are in the regenerated inventory. This is not a comprehensive advisory/security clearance.
- LGPL and upstream notices remain in vendor and docs/licenses. OpenZeppelin5.0.2 remains actual source dependency with its notices. Source equality and license preservation are provenance work, not legal approval of every future distribution/linking choice.

## Deployment and review boundary

`evidence/app-deployment-v1-preserved.json` is the unchanged original application deployment whose8547chain was already unavailable before v2. It is not silently overwritten. `evidence/episode-v2-deployment.json` describes actual new deployments only on the isolated18547 test chain; all runtime hashes are checked at signing/observation. Frozen original business obligations are not transferred to a new executor/replay registry.

The new independent decoder/verifier is separately authored software but runs on the same local node, and API resync currently hosts its modules with a separate non-superuser indexer DB pool. This is not separate-process verifier isolation or independent node trust. Implementer tests do not self-approve custody. The deterministic RPC/PG AL-01 and resource-idempotency AL-02 fixes await parent independent rerun.

**Verdict remains NO GO for full release, public chain or real-value use.** Required independent custody/advisory/complete-rights/bytecode review, all32 gate completion, extension/manual wallet acceptance, coherent recovery and release signoff are absent. Historical source/pin/audit findings are preserved under `CUSTODY-v1-preserved.md`, not presented as current installed findings.
