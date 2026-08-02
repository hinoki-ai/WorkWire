#!/usr/bin/env bash
set -euo pipefail

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

install_root="/opt/workwire/recovery-agent"
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

install -d -m 0755 "$install_root/lib/recovery" "$install_root/node_modules"
cp -a -- "$repo_root/lib/." "$install_root/lib/"
cp -a -- "$repo_root/node_modules/ws" "$install_root/node_modules/ws"
install -m 0644 "$repo_root/package.json" "$install_root/package.json"
install -m 0644 "$repo_root/recovery/systemd/workwire-recovery-agent.service" "$unit_path"
cat > "$wrapper_path" <<EOF
#!/bin/sh
exec "$node_binary" "$install_root/lib/recovery/ww-recovery-agent.mjs" "\$@"
EOF
chmod 0755 "$wrapper_path"
install -d -m 0700 /etc/workwire /var/lib/workwire-recovery
python3 - "$controller_url" "$token" <<'PY'
import json, sys
with open('/etc/workwire/recovery-agent.json.tmp', 'w', encoding='utf-8') as handle:
    json.dump({'controllerUrl': sys.argv[1], 'token': sys.argv[2], 'mode': 'installed'}, handle, indent=2)
    handle.write('\n')
PY
chmod 0600 /etc/workwire/recovery-agent.json.tmp
mv -f -- /etc/workwire/recovery-agent.json.tmp /etc/workwire/recovery-agent.json
systemctl daemon-reload
systemctl enable --now workwire-recovery-agent.service
printf 'WorkWire recovery agent installed and connected toward %s.\n' "$controller_url"
