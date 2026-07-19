#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-install}"
shift || true
interface_name=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --interface) interface_name="${2:-}"; shift 2 ;;
    *) printf 'Unknown recovery host option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$command_name" in
  status)
    if [[ -x /usr/local/sbin/workwire-recovery-pxe ]]; then
      if [[ "$(id -u)" -eq 0 ]]; then exec /usr/local/sbin/workwire-recovery-pxe status; fi
      exec sudo -- /usr/local/sbin/workwire-recovery-pxe status
    fi
    exec systemctl status --no-pager workwire-recovery-pxe.service
    ;;
  install|uninstall) ;;
  *)
    printf 'Usage: install-ww-recovery-host.sh install [--interface IFACE] | status | uninstall\n' >&2
    exit 2
    ;;
esac

if [[ "$(id -u)" -ne 0 ]]; then
  sudo_args=("$0" "$command_name")
  if [[ -n "$interface_name" ]]; then sudo_args+=(--interface "$interface_name"); fi
  exec sudo -- "${sudo_args[@]}"
fi

install_root="/usr/local/lib/workwire"
unit_path="/etc/systemd/system/workwire-recovery-pxe.service"
unit_dropin_dir="/etc/systemd/system/workwire-recovery-pxe.service.d"
helper_path="/usr/local/sbin/workwire-recovery-pxe"
operator_user="${WW_RECOVERY_OPERATOR:-${SUDO_USER:-}}"

if [[ "$command_name" == "uninstall" ]]; then
  systemctl disable --now workwire-recovery-pxe.service 2>/dev/null || true
  rm -f -- "$unit_path" "$helper_path"
  rm -rf -- "$unit_dropin_dir" "$install_root"
  if [[ -n "$operator_user" && "$operator_user" != "root" ]]; then
    rm -f -- "/etc/sudoers.d/workwire-recovery-pxe-$operator_user"
  fi
  systemctl daemon-reload
  printf 'WorkWire PXE host helper removed. Recovery cases, images, and artifacts were preserved.\n'
  printf 'To purge state explicitly, remove the recovery state directory printed during installation.\n'
  exit 0
fi

if [[ ! -r /etc/os-release ]]; then
  printf 'Unable to identify the host operating system.\n' >&2
  exit 6
fi

. /etc/os-release
if [[ "${ID:-}" != "fedora" ]]; then
  printf 'WorkWire PXE host installation currently targets Fedora; found %s.\n' "${ID:-unknown}" >&2
  exit 6
fi

node_binary="$(command -v node || true)"
if [[ -z "$node_binary" ]]; then
  printf 'Node.js 22 or newer is required on the PXE host.\n' >&2
  exit 6
fi
node_major="$($node_binary -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 22 ]]; then
  printf 'Node.js 22 or newer is required; found %s.\n' "$($node_binary --version)" >&2
  exit 6
fi

required_packages=(dnsmasq ipxe-bootimgs smartmontools ddrescue gdisk testdisk qemu-kvm edk2-ovmf xorriso nfs-utils cifs-utils podman squashfs-tools)
missing_packages=()
for package_name in "${required_packages[@]}"; do
  if ! rpm -q "$package_name" >/dev/null 2>&1; then missing_packages+=("$package_name"); fi
done

if [[ "${#missing_packages[@]}" -gt 0 ]]; then
  if ! dnf install -y "${missing_packages[@]}"; then
    printf 'One or more Fedora package names differed; resolving providers for missing core tools.\n' >&2
    for tool_name in dnsmasq smartctl ddrescue qemu-system-x86_64 xorriso podman unsquashfs; do
      command -v "$tool_name" >/dev/null 2>&1 && continue
      provider="$(dnf repoquery --whatprovides "*/$tool_name" --qf '%{name}' 2>/dev/null | head -1 || true)"
      if [[ -n "$provider" ]]; then dnf install -y "$provider" || true; fi
    done
  fi
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
install -d -m 0755 "$install_root/lib" "$install_root/scripts" "$unit_dropin_dir"
rm -rf -- "$install_root/lib/recovery"
cp -a -- "$repo_root/lib/recovery" "$install_root/lib/recovery"
for module in ww-network.mjs ww-config-store.mjs ww-fs.mjs; do
  install -m 0644 "$repo_root/lib/$module" "$install_root/lib/$module"
done
install -m 0755 "$repo_root/scripts/run-ww-pxe.mjs" "$install_root/scripts/run-ww-pxe.mjs"
install -m 0644 "$repo_root/recovery/systemd/workwire-recovery-pxe.service" "$unit_path"

state_dir="/var/lib/workwire/recovery"
if [[ -n "$operator_user" && "$operator_user" != "root" ]]; then
  operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
  if [[ -n "$operator_home" && "$operator_home" == /* ]]; then
    state_dir="$operator_home/.config/workwire/recovery"
  fi
fi
install -d -m 0700 "$state_dir"
if [[ -n "$operator_user" && "$operator_user" != "root" ]]; then
  chown -R -- "$operator_user:$operator_user" "$state_dir"
fi

cat > "$unit_dropin_dir/state.conf" <<EOF
[Service]
Environment=WW_RECOVERY_STATE_DIR=$state_dir
EOF

cat > "$helper_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-status}" in
  start) exec systemctl start workwire-recovery-pxe.service ;;
  stop) exec systemctl stop workwire-recovery-pxe.service ;;
  status) exec systemctl status --no-pager workwire-recovery-pxe.service ;;
  reload|restart) exec systemctl restart workwire-recovery-pxe.service ;;
  prepare) exec /usr/bin/env node /usr/local/lib/workwire/scripts/run-ww-pxe.mjs prepare ;;
  *) printf 'Usage: workwire-recovery-pxe start|stop|status|reload|prepare\n' >&2; exit 2 ;;
esac
EOF
chmod 0755 "$helper_path"

if [[ -n "$operator_user" && "$operator_user" != "root" ]]; then
  sudoers_path="/etc/sudoers.d/workwire-recovery-pxe-$operator_user"
  cat > "$sudoers_path" <<EOF
$operator_user ALL=(root) NOPASSWD: $helper_path start, $helper_path stop, $helper_path status, $helper_path reload, $helper_path restart, $helper_path prepare
EOF
  chmod 0440 "$sudoers_path"
  visudo -cf "$sudoers_path" >/dev/null
fi

if [[ -n "$interface_name" ]]; then
  if [[ ! "$interface_name" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
    printf 'Invalid PXE interface %s.\n' "$interface_name" >&2
    exit 2
  fi
  WW_RECOVERY_STATE_DIR="$state_dir" "$node_binary" "$install_root/scripts/run-ww-pxe.mjs" prepare --interface "$interface_name"
fi

missing_tools=()
for tool_name in dnsmasq smartctl ddrescue qemu-system-x86_64 xorriso podman unsquashfs; do
  command -v "$tool_name" >/dev/null 2>&1 || missing_tools+=("$tool_name")
done
if [[ "${#missing_tools[@]}" -gt 0 ]]; then
  printf 'Host installation completed with unavailable core tools: %s\n' "${missing_tools[*]}" >&2
  exit 6
fi

systemctl daemon-reload
systemctl enable workwire-recovery-pxe.service
printf 'WorkWire recovery host installed. State: %s\n' "$state_dir"
printf 'Start PXE with: sudo %s start\n' "$helper_path"
