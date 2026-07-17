#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
export WW_HOME_DIR="${WW_HOME_DIR:-$REPO_DIR/.workwire}"
export WW_CONFIG_DIR="${WW_CONFIG_DIR:-$WW_HOME_DIR/config}"
export WW_PORTAL_PATH="${WW_PORTAL_PATH:-$REPO_DIR}"

PACKAGED_RUNTIME="${WW_RUNTIME_EXECUTABLE:-${HOME}/.local/opt/workwire/ww}"
if [[ -x "$PACKAGED_RUNTIME" ]]; then
  exec "$PACKAGED_RUNTIME" "$@"
fi

exec node "$REPO_DIR/ww.mjs" "$@"
