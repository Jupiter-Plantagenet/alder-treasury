#!/usr/bin/env bash
# Retired O5 harness. It used a fixed host path and unconditionally removed the fixed container
# name `alder-o5-repro`; it is intentionally unable to affect the workstation or an old episode.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
echo 'O5_REPRO_ENTRY_RETIRED: use tests/round6-repro/repro-linux.sh for the isolated per-run namespace.' >&2
echo "Alder source root: $ROOT" >&2
exit 2
