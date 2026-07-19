#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$repo_root/scripts/verify-ww-recovery-image.mjs" "$@"
