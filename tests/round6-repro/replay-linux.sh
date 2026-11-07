#!/usr/bin/env bash
# Container entry alias retained beside the original TR-T-REPRO command family.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
exec bash tests/round6-repro/run-internal-linux.sh "$@"
