#!/usr/bin/env bash
set -euo pipefail

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
    printf 'Refusing recovery-agent runtime containing WW conflict artifact: %s\n' "$conflict_path" >&2
    exit 6
  fi
}

command_name="${1:-status}"
shift || true
controller_url=""
token=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --controller) controller_url="${2:-}"; shift 2 ;;
    --token) token="${2:-}"; shift 2 ;;
    *) printf 'Unknown recovery agent installer option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ "$command_name" == "status" ]]; then
  systemctl status --no-pager workwire-recovery-agent.service
  exit $?
fi

if [[ "$(id -u)" -ne 0 ]]; then
  sudo_args=("$0" "$command_name")
  if [[ -n "$controller_url" ]]; then sudo_args+=(--controller "$controller_url"); fi
  if [[ -n "$token" ]]; then sudo_args+=(--token "$token"); fi
  exec sudo -- "${sudo_args[@]}"
fi

install_parent="/opt/workwire"
install_root="$install_parent/recovery-agent"
unit_path="/etc/systemd/system/workwire-recovery-agent.service"
wrapper_path="/usr/local/bin/ww-recovery-agent"

if [[ "$command_name" == "uninstall" ]]; then
  systemctl disable --now workwire-recovery-agent.service 2>/dev/null || true
  rm -f -- "$unit_path" "$wrapper_path"
  rm -rf -- "$install_root"
  systemctl daemon-reload
  printf 'WorkWire recovery agent removed. Case data and /var/lib/workwire-recovery were preserved.\n'
  printf 'To purge target state explicitly: sudo rm -rf -- /var/lib/workwire-recovery\n'
  exit 0
fi

if [[ "$command_name" != "install" ]]; then
  printf 'Usage: install-ww-recovery-agent.sh install --controller URL [--token TOKEN] | status | uninstall\n' >&2
  exit 2
fi
if [[ -z "$controller_url" ]]; then
  printf '%s\n' '--controller URL is required.' >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
node_binary="$(command -v node || true)"
if [[ -z "$node_binary" ]]; then
  printf 'Node.js 22 is required on the recovery target.\n' >&2
  exit 6
fi
node_major="$($node_binary -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 22 ]]; then
  printf 'Node.js 22 or newer is required; found %s.\n' "$($node_binary --version)" >&2
  exit 6
fi

install -d -m 0755 "$install_parent"
staging_root="$(mktemp -d "$install_parent/recovery-agent.next.XXXXXXXX")"
backup_root="$install_parent/recovery-agent.previous.$(date -u +%Y%m%dT%H%M%SZ).$$"
failed_root="$install_parent/recovery-agent.failed.$(date -u +%Y%m%dT%H%M%SZ).$$"
config_temporary="/etc/workwire/recovery-agent.json.$$.next"
cleanup_install_stage() {
  if [[ -n "${staging_root:-}" && -d "$staging_root" ]]; then rm -rf -- "$staging_root"; fi
  rm -f -- "$config_temporary"
}
trap cleanup_install_stage EXIT

# Fully stage the runtime before stopping the live agent. A same-filesystem
# rename makes activation atomic and the prior runtime remains rollback-ready.
install -d -m 0755 "$staging_root/lib/recovery" "$staging_root/node_modules"
copy_tree_without_ww_conflicts "$repo_root/lib" "$staging_root/lib"
cp -a -- "$repo_root/node_modules/ws" "$staging_root/node_modules/ws"
install -m 0644 "$repo_root/package.json" "$staging_root/package.json"
install -d -m 0700 /etc/workwire /var/lib/workwire-recovery
python3 - "$controller_url" "$token" "$config_temporary" <<'PY'
import json, sys
with open(sys.argv[3], 'w', encoding='utf-8') as handle:
    json.dump({'controllerUrl': sys.argv[1], 'token': sys.argv[2], 'mode': 'installed'}, handle, indent=2)
    handle.write('\n')
PY
chmod 0600 "$config_temporary"

systemctl stop workwire-recovery-agent.service 2>/dev/null || true
previous_moved=0
if [[ -e "$install_root" ]]; then
  mv -- "$install_root" "$backup_root"
  previous_moved=1
fi
if ! mv -- "$staging_root" "$install_root"; then
  if [[ "$previous_moved" -eq 1 && ! -e "$install_root" ]]; then mv -- "$backup_root" "$install_root"; fi
  printf 'Unable to activate the staged recovery runtime; the previous runtime was restored.\n' >&2
  exit 7
fi
staging_root=""

install -m 0644 "$repo_root/recovery/systemd/workwire-recovery-agent.service" "$unit_path"
cat > "$wrapper_path" <<EOF
#!/bin/sh
exec "$node_binary" "$install_root/lib/recovery/ww-recovery-agent.mjs" "\$@"
EOF
chmod 0755 "$wrapper_path"
mv -f -- "$config_temporary" /etc/workwire/recovery-agent.json
systemctl daemon-reload
if ! systemctl enable workwire-recovery-agent.service \
  || ! systemctl restart workwire-recovery-agent.service \
  || ! systemctl is-active --quiet workwire-recovery-agent.service; then
  systemctl stop workwire-recovery-agent.service 2>/dev/null || true
  if [[ -e "$install_root" ]]; then mv -- "$install_root" "$failed_root"; fi
  if [[ "$previous_moved" -eq 1 && -e "$backup_root" ]]; then
    mv -- "$backup_root" "$install_root"
    systemctl daemon-reload
    systemctl enable --now workwire-recovery-agent.service 2>/dev/null || true
  fi
  printf 'The new recovery runtime failed its service postcondition; rollback attempted. Failed runtime: %s\n' "$failed_root" >&2
  exit 8
fi
printf 'WorkWire recovery agent installed and connected toward %s.\n' "$controller_url"
if [[ "$previous_moved" -eq 1 ]]; then printf 'Previous runtime preserved at %s.\n' "$backup_root"; fi
