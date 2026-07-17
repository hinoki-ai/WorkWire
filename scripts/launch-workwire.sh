#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
export WW_HOME_DIR="${WW_HOME_DIR:-$REPO_DIR/.workwire}"
export WW_CONFIG_DIR="${WW_CONFIG_DIR:-$WW_HOME_DIR/config}"
export WW_PORTAL_PATH="${WW_PORTAL_PATH:-$REPO_DIR}"

# This launcher is also installed as the repo/development launcher.  Always
# prefer the checkout so launching WorkWire after a source change cannot
# silently fall back to an older installed bundle.  Packaged launchers invoke
# their self-contained binary directly; an explicit override remains useful
# for integration tests and deliberate runtime selection.
if [[ -n "${WW_RUNTIME_EXECUTABLE:-}" ]]; then
  if [[ ! -x "$WW_RUNTIME_EXECUTABLE" ]]; then
    printf 'WW_RUNTIME_EXECUTABLE is not executable: %s\n' "$WW_RUNTIME_EXECUTABLE" >&2
    exit 1
  fi
  exec "$WW_RUNTIME_EXECUTABLE" "$@"
fi

exec node "$REPO_DIR/ww.mjs" "$@"
