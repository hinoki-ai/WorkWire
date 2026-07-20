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

copy_tree_without_ww_conflicts() {
  local source_tree="$1"
  local target_tree="$2"
  local conflict_path=""
  mkdir -p -- "$target_tree"
  tar \
    --exclude='* (WW conflict *)*' \
    --exclude='WW conflict *' \
    --exclude='*/WW conflict *' \
    -C "$source_tree" -cf - . | tar -C "$target_tree" -xf -
  conflict_path="$(find "$target_tree" \( -name '* (WW conflict *)*' -o -name 'WW conflict *' \) -print -quit)"
  if [[ -n "$conflict_path" ]]; then
    printf 'Refusing recovery image input containing WW conflict artifact: %s\n' "$conflict_path" >&2
    exit 6
  fi
}

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
copy_tree_without_ww_conflicts "$repo_root/lib" "$work_dir/config/includes.chroot/opt/workwire/agent/lib"
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
podman_mounts=(-v "$work_dir:/work:Z")
# A rootless container cannot recreate cached character devices on a bind mount,
# even with --privileged. live-build mounts the container's real /dev before it
# enters the chroot, so hide only the cached /dev entries while restoring the
# reusable bootstrap tree. The cache itself remains untouched.
if [[ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)" == "true" ]]; then
  if [[ "$reuse_rootfs" -eq 1 && -d "$work_dir/cache/bootstrap/dev" ]]; then
    rootless_empty_dev="$staging/rootless-empty-dev"
    rootless_empty_journal="$staging/rootless-empty-journal"
    mkdir -p -- "$rootless_empty_dev"
    mkdir -p -- "$rootless_empty_journal"
    podman_mounts+=(-v "$rootless_empty_dev:/work/cache/bootstrap/dev:ro,Z")
    # The cached journald directory carries a named `adm` ACL that rootless cp
    # cannot reproduce across the user namespace. It contains no build input.
    podman_mounts+=(-v "$rootless_empty_journal:/work/cache/bootstrap/var/log/journal:ro,Z")
  fi
  # Rootless builds run the live-build stages explicitly. A fresh debootstrap
  # sees the container's /dev, then a device-free bootstrap cache is saved for
  # installer assembly. The chroot stage gets /dev again and releases it before
  # live-build copies the filesystem into its binary layout.
  live_build_command='cd /work && lb clean && lb config && cache_present=0 && if [ -d cache/bootstrap ]; then cache_present=1; fi && mkdir -p chroot/dev && lb bootstrap && if mountpoint -q chroot/dev; then umount -R chroot/dev; fi && if [ "$cache_present" -eq 0 ]; then cp -a chroot cache/bootstrap; fi && mount --rbind /dev chroot/dev && lb chroot && if mountpoint -q chroot/dev; then umount -R chroot/dev; fi && lb binary && lb source'
  # Cached device/ACL overlays are intentionally read-only. Skip live-build's
  # redundant bootstrap save pass so it never tries to remove nested mounts.
  # binary_rootfs temporarily swaps its outer bootstrap and full live chroots;
  # release /dev before that swap, restore it for bootloader tooling, and then
  # release it again at the binary stage's final cleanup boundary.
  rootless_cache_setup='sed -i '\''/^shift$/a if [ "${_ACTION}" = "save" ]; then exit 0; fi'\'' /usr/lib/live/build/bootstrap_cache; sed -i '\''/^lb bootstrap_cache restore/a if ! mountpoint -q chroot/dev; then mount --rbind /dev chroot/dev; fi'\'' /usr/lib/live/build/bootstrap; sed -i '\''/^lb binary_chroot/a mount --rbind /dev chroot/dev'\'' /usr/lib/live/build/binary; sed -i '\''/^[[:space:]]*lb chroot_prep remove all mode-archives-binary/a if mountpoint -q chroot/dev; then umount -R chroot/dev; fi'\'' /usr/lib/live/build/binary_rootfs; sed -i '\''/^[[:space:]]*lb chroot_prep install all mode-archives-binary/i mount --rbind /dev chroot/dev'\'' /usr/lib/live/build/binary_rootfs; sed -i '\''/^lb chroot_prep remove "${CHROOT_PREP_MOUNTS}"/i if mountpoint -q chroot/dev; then umount -R chroot/dev; fi'\'' /usr/lib/live/build/binary'
  # debootstrap's LXC path verifies executability without demanding host-level
  # device-node creation, then binds the already populated container /dev.
  live_build_command="$rootless_cache_setup; export container=lxc; $live_build_command"
fi
podman run --rm --privileged \
  -e "WW_RECOVERY_ROOT_PASSWORD=${WW_RECOVERY_ROOT_PASSWORD:-workwire}" \
  "${podman_mounts[@]}" \
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
