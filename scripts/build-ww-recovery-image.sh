#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="${WW_RECOVERY_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/workwire/recovery}"
active_dir="$state_dir/boot/live"
cache_dir="$state_dir/image-cache"
node_version="22.22.0"
builder_tag="localhost/workwire-recovery-builder:bookworm-v1"
reuse_rootfs=0
if [[ "${1:-}" == "--reuse-rootfs" ]]; then reuse_rootfs=1; fi

command -v podman >/dev/null 2>&1 || { printf 'Podman is required.\n' >&2; exit 6; }
staging="$(mktemp -d "${TMPDIR:-/tmp}/ww-recovery-image.XXXXXX")"
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
mkdir -p -- "$cache_dir" "$staging/output"
work_dir="$staging/work"
if [[ "$reuse_rootfs" -eq 1 ]]; then work_dir="$cache_dir/live-build-work"; fi
mkdir -p -- "$work_dir/config/includes.chroot/opt/workwire/agent"
cp -a -- "$repo_root/recovery/image/." "$work_dir/"
rm -rf -- "$work_dir/config/includes.chroot/opt/workwire/agent/lib" "$work_dir/config/includes.chroot/opt/workwire/agent/node_modules/ws"
cp -a -- "$repo_root/lib" "$work_dir/config/includes.chroot/opt/workwire/agent/lib"
cp -a -- "$repo_root/package.json" "$work_dir/config/includes.chroot/opt/workwire/agent/package.json"
mkdir -p -- "$work_dir/config/includes.chroot/opt/workwire/agent/node_modules"
cp -a -- "$repo_root/node_modules/ws" "$work_dir/config/includes.chroot/opt/workwire/agent/node_modules/ws"

node_archive="node-v${node_version}-linux-x64.tar.xz"
if [[ ! -f "$cache_dir/$node_archive" ]]; then
  curl -fL --retry 3 -o "$cache_dir/$node_archive.partial" "https://nodejs.org/dist/v${node_version}/$node_archive"
  curl -fL --retry 3 -o "$cache_dir/SHASUMS256.txt" "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
  (cd "$cache_dir" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
  mv -f -- "$cache_dir/$node_archive.partial" "$cache_dir/$node_archive"
else
  (cd "$cache_dir" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
fi
rm -rf -- "$work_dir/config/includes.chroot/opt/workwire/node"
mkdir -p -- "$work_dir/config/includes.chroot/opt/workwire/node"
tar -xJf "$cache_dir/$node_archive" --strip-components=1 -C "$work_dir/config/includes.chroot/opt/workwire/node"

git_revision="$(git -C "$repo_root" rev-parse --short=12 HEAD 2>/dev/null || true)"
node "$repo_root/scripts/write-ww-recovery-build-seed.mjs" \
  --output "$work_dir/config/includes.chroot/etc/workwire-recovery-build-seed.json" \
  --git-revision "$git_revision"

chmod 0755 \
  "$work_dir/auto/config" \
  "$work_dir/config/hooks/live/005-workwire-optional-packages.hook.chroot" \
  "$work_dir/config/hooks/live/010-workwire-agent.hook.chroot" \
  "$work_dir/config/hooks/live/020-workwire-build-info.hook.chroot" \
  "$work_dir/config/includes.chroot/usr/local/bin/ww-recovery-agent" \
  "$work_dir/config/includes.chroot/usr/local/bin/ww-recovery-status"

podman build -t "$builder_tag" -f "$repo_root/recovery/image/Containerfile" "$repo_root/recovery/image"
builder_digest="$(podman image inspect "$builder_tag" --format '{{.Digest}}' 2>/dev/null || true)"
live_build_command='cd /work && lb clean --purge && lb config && lb build'
if [[ "$reuse_rootfs" -eq 1 ]]; then live_build_command='cd /work && lb clean && lb config && lb build'; fi
podman run --rm --privileged \
  -e "WW_RECOVERY_ROOT_PASSWORD=${WW_RECOVERY_ROOT_PASSWORD:-workwire}" \
  -v "$work_dir:/work:Z" \
  "$builder_tag" -lc "$live_build_command"

kernel_path="$(find "$work_dir/binary/live" -maxdepth 1 -type f -name 'vmlinuz*' | sort | head -1)"
initrd_path="$(find "$work_dir/binary/live" -maxdepth 1 -type f -name 'initrd*' | sort | head -1)"
squashfs_path="$(find "$work_dir/binary/live" -maxdepth 1 -type f -name 'filesystem.squashfs' | head -1)"
[[ -f "$kernel_path" && -f "$initrd_path" && -f "$squashfs_path" ]] || { printf 'live-build did not produce required boot files.\n' >&2; exit 6; }
cp -- "$kernel_path" "$staging/output/vmlinuz"
cp -- "$initrd_path" "$staging/output/initrd.img"
cp -- "$squashfs_path" "$staging/output/filesystem.squashfs"
iso_path="$(find "$work_dir" -maxdepth 1 -type f \( -name '*.hybrid.iso' -o -name '*.iso' \) | head -1)"
if [[ -n "$iso_path" && -f "$iso_path" ]]; then cp -- "$iso_path" "$staging/output/workwire-recovery.iso"; fi
(cd "$staging/output" && if [[ -n "$iso_path" ]]; then sha256sum vmlinuz initrd.img filesystem.squashfs workwire-recovery.iso > SHA256SUMS; else sha256sum vmlinuz initrd.img filesystem.squashfs > SHA256SUMS; fi)

node "$repo_root/scripts/write-ww-recovery-manifest.mjs" \
  --output "$staging/output/manifest.json" \
  --directory "$staging/output" \
  --node-version "$node_version" \
  --builder-image "debian:bookworm-slim" \
  --builder-digest "$builder_digest" \
  --git-revision "$git_revision"

node "$repo_root/scripts/verify-ww-recovery-image.mjs" --directory "$staging/output"
next_dir="$state_dir/boot/live.next.$$"
previous_dir="$state_dir/boot/live.previous"
rm -rf -- "$next_dir"
mkdir -p -- "$(dirname -- "$active_dir")"
mv -- "$staging/output" "$next_dir"
if [[ -d "$active_dir" ]]; then
  rm -rf -- "$previous_dir"
  mv -- "$active_dir" "$previous_dir"
fi
mv -- "$next_dir" "$active_dir"
printf 'WorkWire recovery image active at %s\n' "$active_dir"
find "$active_dir" -maxdepth 1 -type f -printf '%f %s bytes\n' | sort
