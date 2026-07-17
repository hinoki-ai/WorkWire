#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${1:-${WW_LAN_BASE_URL:-}}"
TARGET_DIR="${WW_LAN_TARGET_DIR:-${HOME}/.local/src/workwire-bundle}"
ARCH_NAME="${WW_LAN_ARCH:-$(uname -m)}"
case "$ARCH_NAME" in
  x86_64) ARCH_NAME="x64" ;;
  aarch64|arm64) ARCH_NAME="arm64" ;;
esac
ARCHIVE_NAME="${WW_LAN_ARTIFACT_NAME:-ww-linux-${ARCH_NAME}.tar.gz}"
ARCHIVE_URL="${BASE_URL%/}/${ARCHIVE_NAME}"
CHECKSUM_URL="${WW_LAN_CHECKSUM_URL:-${BASE_URL%/}/SHA256SUMS}"
RELEASE_VERSION="${WW_LAN_RELEASE_VERSION:-}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ww-lan-install.XXXXXX")"
ARCHIVE_PATH="$WORK_DIR/${ARCHIVE_NAME}"
CHECKSUM_PATH="$WORK_DIR/SHA256SUMS"
EXTRACT_DIR="$WORK_DIR/extracted"
TARGET_PARENT_DIR="$(dirname -- "$TARGET_DIR")"
STAGED_TARGET_DIR=""
BACKUP_TARGET_DIR=""
TARGET_SWAPPED=0
INSTALL_SUCCEEDED=0

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 && "$INSTALL_SUCCEEDED" -ne 1 && "$TARGET_SWAPPED" -eq 1 ]]; then
    rm -rf -- "$TARGET_DIR"
    if [[ -n "$BACKUP_TARGET_DIR" && -e "$BACKUP_TARGET_DIR" ]]; then
      mv -- "$BACKUP_TARGET_DIR" "$TARGET_DIR"
    fi
  fi
  rm -rf -- "$WORK_DIR"
  if [[ -n "$STAGED_TARGET_DIR" ]]; then
    rm -rf -- "$STAGED_TARGET_DIR"
  fi
  if [[ "$status" -eq 0 && -n "$BACKUP_TARGET_DIR" ]]; then
    rm -rf -- "$BACKUP_TARGET_DIR"
  fi
}

validate_target_dir() {
  if [[ -z "$TARGET_DIR" || "$TARGET_DIR" != /* ]]; then
    printf 'WW_LAN_TARGET_DIR must be a non-empty absolute path.\n' >&2
    return 1
  fi
  case "${TARGET_DIR%/}" in
    ""|/|"${HOME%/}")
      printf 'Refusing unsafe WW_LAN_TARGET_DIR: %s\n' "$TARGET_DIR" >&2
      return 1
      ;;
  esac
}

validate_archive_members() {
  local member
  while IFS= read -r member; do
    case "$member" in
      ww|ww/|ww/*) ;;
      *)
        printf 'WW installer archive contains an unexpected path: %s\n' "$member" >&2
        return 1
        ;;
    esac
    if [[ "/$member/" == *"/../"* || "$member" == /* ]]; then
      printf 'WW installer archive contains an unsafe path: %s\n' "$member" >&2
      return 1
    fi
  done < <(tar -tzf "$ARCHIVE_PATH")
}

download_bundle() {
  if command -v curl >/dev/null 2>&1; then
    curl --retry 2 --connect-timeout 5 -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$ARCHIVE_PATH" "$ARCHIVE_URL"
    return
  fi

  printf 'WW installer needs curl or wget to download %s\n' "$ARCHIVE_URL" >&2
  exit 1
}

download_checksums() {
  if command -v curl >/dev/null 2>&1; then
    curl --retry 2 --connect-timeout 5 -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_PATH"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$CHECKSUM_PATH" "$CHECKSUM_URL"
    return
  fi

  printf 'WW installer needs curl or wget to download %s\n' "$CHECKSUM_URL" >&2
  exit 1
}

compute_sha256() {
  local target_path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target_path" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target_path" | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$target_path" | awk '{print $1}'
    return
  fi

  printf 'WW installer requires sha256sum, shasum, or openssl to verify %s\n' "$target_path" >&2
  exit 1
}

resolve_expected_sha256() {
  if [[ -n "${WW_LAN_ARTIFACT_SHA256:-}" ]]; then
    printf '%s\n' "$WW_LAN_ARTIFACT_SHA256"
    return
  fi

  download_checksums
  awk -v archive_name="$ARCHIVE_NAME" '$2 == archive_name { print $1; exit }' "$CHECKSUM_PATH"
}

trap cleanup EXIT

if [[ -z "$BASE_URL" ]]; then
  printf 'Provide the WorkWire LAN installer URL as the first argument or WW_LAN_BASE_URL.\n' >&2
  exit 1
fi
validate_target_dir

mkdir -p "$TARGET_PARENT_DIR"
command -v tar >/dev/null 2>&1 || {
  printf 'WW installer requires tar.\n' >&2
  exit 1
}

if [[ -n "$RELEASE_VERSION" ]]; then
  printf 'Installing WW %s\n' "$RELEASE_VERSION"
fi
printf 'Downloading %s\n' "$ARCHIVE_URL"
download_bundle

EXPECTED_SHA256="$(resolve_expected_sha256)"
if [[ -z "$EXPECTED_SHA256" ]]; then
  printf 'WW installer could not resolve a checksum for %s from %s\n' "$ARCHIVE_NAME" "$CHECKSUM_URL" >&2
  exit 1
fi

ACTUAL_SHA256="$(compute_sha256 "$ARCHIVE_PATH")"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  printf 'WW installer checksum mismatch for %s\nExpected: %s\nActual:   %s\n' "$ARCHIVE_NAME" "$EXPECTED_SHA256" "$ACTUAL_SHA256" >&2
  exit 1
fi

rm -rf -- "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
validate_archive_members
tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
if find "$EXTRACT_DIR/ww" -type l -print -quit | grep -q .; then
  printf 'WW installer archive must not contain symbolic links.\n' >&2
  exit 1
fi
if [[ ! -x "$EXTRACT_DIR/ww/install-ww.sh" ]]; then
  printf 'WW installer archive did not contain ww/install-ww.sh\n' >&2
  exit 1
fi

STAGED_TARGET_DIR="$(mktemp -d "${TARGET_PARENT_DIR}/.workwire-bundle.XXXXXX")"
mv -- "$EXTRACT_DIR/ww" "$STAGED_TARGET_DIR/payload"
if [[ -e "$TARGET_DIR" || -L "$TARGET_DIR" ]]; then
  BACKUP_TARGET_DIR="$STAGED_TARGET_DIR/previous"
  mv -- "$TARGET_DIR" "$BACKUP_TARGET_DIR"
fi
TARGET_SWAPPED=1
mv -- "$STAGED_TARGET_DIR/payload" "$TARGET_DIR"

chmod +x "$TARGET_DIR/install-ww.sh"
"$TARGET_DIR/install-ww.sh"
INSTALL_SUCCEEDED=1
