#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PATH="$SCRIPT_DIR/ww"
ICON_PATH="$SCRIPT_DIR/icon.png"
if [[ -n "${WW_INSTALL_ROOT:-}" ]]; then
  INSTALL_ROOT="${WW_INSTALL_ROOT}"
else
  INSTALL_ROOT="${HOME}/.local/opt/workwire"
fi
INSTALL_PARENT_DIR="$(dirname -- "$INSTALL_ROOT")"
BIN_DIR="${WW_BIN_DIR:-${HOME}/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
DESKTOP_DIR="${WW_DESKTOP_DIR:-${DATA_HOME}/applications}"
DESKTOP_PATH="${DESKTOP_DIR}/workwire.desktop"
WW_RUNTIME_HOME="${WW_HOME_DIR:-${INSTALL_ROOT}/.workwire}"
WW_CONFIG_DIR="${WW_CONFIG_DIR:-${WW_RUNTIME_HOME}/config}"
if [[ -n "${WW_PORTAL_PATH:-}" ]]; then
  PORTAL_PATH="${WW_PORTAL_PATH}"
else
  PORTAL_PATH="${INSTALL_ROOT}/app"
fi
LOG_PATH="${WW_LOG_PATH:-${WW_CONFIG_DIR}/ww.log}"
SYSTEMD_USER_UNIT_PATH="${CONFIG_HOME}/systemd/user/workwire-ww.service"
AUTOSTART_ENTRY_PATH="${CONFIG_HOME}/autostart/workwire-ww-background.desktop"
SUPERVISOR_PATH="${DATA_HOME}/workwire/ww-background-supervisor.sh"
DESKTOP_SHORTCUT_ENABLED="${WW_INSTALL_DESKTOP_SHORTCUT:-0}"

STAGED_INSTALL_ROOT=""
BACKUP_INSTALL_ROOT=""
BACKUP_CONTAINER=""
INSTALL_COMPLETE=0
SWAPPED_INSTALL=0
SERVICE_WAS_ACTIVE=0

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

assert_safe_install_root() {
  if [[ -z "$INSTALL_ROOT" || "$INSTALL_ROOT" != /* ]]; then
    printf 'WW_INSTALL_ROOT must be a non-empty absolute path.\n' >&2
    return 1
  fi

  case "${INSTALL_ROOT%/}" in
    ""|/|"${HOME%/}"|"${HOME%/}/.local"|"${HOME%/}/.local/opt")
      printf 'Refusing unsafe WorkWire install root: %s\n' "$INSTALL_ROOT" >&2
      return 1
      ;;
  esac
}

cleanup() {
  local status=$?

  if [[ "$status" -ne 0 && "$INSTALL_COMPLETE" -ne 1 && "$SWAPPED_INSTALL" -eq 1 ]]; then
    rm -rf -- "$INSTALL_ROOT"
    if [[ -n "$BACKUP_INSTALL_ROOT" && -e "$BACKUP_INSTALL_ROOT" ]]; then
      mv -- "$BACKUP_INSTALL_ROOT" "$INSTALL_ROOT"
      if [[ "$SERVICE_WAS_ACTIVE" -eq 1 ]] && command_exists systemctl; then
        systemctl --user restart workwire-ww.service >/dev/null 2>&1 || true
      fi
    fi
  fi

  if [[ -n "$STAGED_INSTALL_ROOT" ]]; then
    rm -rf -- "$STAGED_INSTALL_ROOT"
  fi

  if [[ -n "$BACKUP_CONTAINER" ]]; then
    rm -rf -- "$BACKUP_CONTAINER"
  fi
}

resolve_desktop_shortcut_dir() {
  if [[ -n "${XDG_DESKTOP_DIR:-}" ]]; then
    printf '%s\n' "${XDG_DESKTOP_DIR/#\~/$HOME}"
    return
  fi

  local user_dirs_path="${CONFIG_HOME}/user-dirs.dirs"
  if [[ -f "$user_dirs_path" ]]; then
    local desktop_dir=""
    desktop_dir="$(sed -n 's/^[[:space:]]*XDG_DESKTOP_DIR[[:space:]]*=[[:space:]]*//p' "$user_dirs_path" | head -n 1 | tr -d '"')"
    desktop_dir="${desktop_dir//\$HOME/$HOME}"
    desktop_dir="${desktop_dir//\$\{HOME\}/$HOME}"
    if [[ -n "$desktop_dir" ]]; then
      printf '%s\n' "$desktop_dir"
      return
    fi
  fi

  printf '%s\n' "${HOME}/Desktop"
}

write_desktop_entry() {
  mkdir -p "$DESKTOP_DIR"
  cat > "$DESKTOP_PATH" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=WorkWire
Comment=Local two-machine file desk for the WorkWire portal.
Exec=${BIN_DIR}/ww %U
TryExec=${BIN_DIR}/ww
Path=${INSTALL_ROOT}
Icon=${INSTALL_ROOT}/icon.png
Terminal=false
StartupNotify=true
Categories=Utility;FileTools;Network;
StartupWMClass=workwire
X-GNOME-WMClass=workwire
EOF

  if [[ "$DESKTOP_SHORTCUT_ENABLED" =~ ^(1|true|yes|on)$ ]]; then
    local shortcut_dir
    shortcut_dir="$(resolve_desktop_shortcut_dir)"
    mkdir -p "$shortcut_dir"
    cp -f -- "$DESKTOP_PATH" "$shortcut_dir/workwire.desktop"
    chmod 755 "$shortcut_dir/workwire.desktop" || true
    printf 'Installed WorkWire desktop shortcut at %s\n' "$shortcut_dir/workwire.desktop"
  fi
}

write_launcher_wrapper() {
  local launcher_path="$1"
  mkdir -p "$(dirname -- "$launcher_path")"
  # Replace any existing launcher (including symlinked launchers) instead of
  # writing through it, so a symlink target is never clobbered.
  rm -f -- "$launcher_path"
  printf '#!/usr/bin/env bash\n\nset -euo pipefail\n\nexport WW_HOME_DIR=%q\nexport WW_CONFIG_DIR=%q\nexport WW_PORTAL_PATH=%q\n\nexec %q "$@"\n' \
    "$WW_RUNTIME_HOME" \
    "$WW_CONFIG_DIR" \
    "$PORTAL_PATH" \
    "${INSTALL_ROOT}/ww" > "$launcher_path"
  chmod 755 "$launcher_path" || return 1
}

write_systemd_user_unit() {
  mkdir -p "$(dirname -- "$SYSTEMD_USER_UNIT_PATH")" || return 1
  cat > "$SYSTEMD_USER_UNIT_PATH" <<EOF || return 1
[Unit]
Description=WorkWire background service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/ww serve
Environment=UV_THREADPOOL_SIZE=32
UMask=0077
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=workwire-ww

[Install]
WantedBy=default.target
EOF
}

install_systemd_user_service() {
  write_systemd_user_unit || return 1
  systemctl --user daemon-reload || return 1
  systemctl --user enable workwire-ww.service || return 1
  if systemctl --user is-active --quiet workwire-ww.service; then
    systemctl --user restart workwire-ww.service || return 1
  else
    systemctl --user start workwire-ww.service || return 1
  fi
  printf 'Installed WW autostart unit at %s\n' "$SYSTEMD_USER_UNIT_PATH"
}

write_fallback_supervisor() {
  mkdir -p "$(dirname -- "$SUPERVISOR_PATH")" "$(dirname -- "$LOG_PATH")" || return 1
  cat > "$SUPERVISOR_PATH" <<EOF || return 1
#!/usr/bin/env bash

set -u

umask 077

WW_BIN_PATH="${BIN_DIR}/ww"
LOG_PATH="${LOG_PATH}"

mkdir -p -- "\$(dirname -- "\$LOG_PATH")"

while true; do
  "\$WW_BIN_PATH" serve >>"\$LOG_PATH" 2>&1
  sleep 2
done
EOF
  chmod 755 "$SUPERVISOR_PATH" || return 1

  mkdir -p "$(dirname -- "$AUTOSTART_ENTRY_PATH")" || return 1
  cat > "$AUTOSTART_ENTRY_PATH" <<EOF || return 1
[Desktop Entry]
Version=1.0
Type=Application
Name=WorkWire Background Service
Comment=Start the persistent WorkWire background service on login.
Exec="${SUPERVISOR_PATH}"
TryExec="${SUPERVISOR_PATH}"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
}

restart_fallback_supervisor() {
  if command_exists pkill; then
    pkill -u "$(id -u)" -f "${BIN_DIR}/ww serve" >/dev/null 2>&1 || true
    pkill -u "$(id -u)" -f "$SUPERVISOR_PATH" >/dev/null 2>&1 || true
  fi

  nohup "$SUPERVISOR_PATH" >/dev/null 2>&1 &
}

install_fallback_autostart() {
  write_fallback_supervisor || return 1
  restart_fallback_supervisor || return 1
  printf 'Installed fallback autostart entry at %s\n' "$AUTOSTART_ENTRY_PATH"
  printf 'Installed fallback supervisor at %s\n' "$SUPERVISOR_PATH"
}

trap cleanup EXIT

assert_safe_install_root

if [[ ! -x "$SOURCE_PATH" ]]; then
  printf 'This installer expects an extracted WorkWire Linux bundle with a self-contained ./ww executable.\n' >&2
  exit 1
fi

if command_exists systemctl && systemctl --user is-active --quiet workwire-ww.service; then
  SERVICE_WAS_ACTIVE=1
fi

mkdir -p "$INSTALL_PARENT_DIR"
STAGED_INSTALL_ROOT="$(mktemp -d "${INSTALL_PARENT_DIR}/.workwire-install.XXXXXX")"
cp -a -- "$SCRIPT_DIR/." "$STAGED_INSTALL_ROOT/"
chmod +x "$STAGED_INSTALL_ROOT/ww" "$STAGED_INSTALL_ROOT/install-ww.sh" || true

if [[ -e "$INSTALL_ROOT" || -L "$INSTALL_ROOT" ]]; then
  BACKUP_CONTAINER="$(mktemp -d "${INSTALL_PARENT_DIR}/.workwire-rollback.XXXXXX")"
  BACKUP_INSTALL_ROOT="${BACKUP_CONTAINER}/previous"
  mv -- "$INSTALL_ROOT" "$BACKUP_INSTALL_ROOT"
fi

SWAPPED_INSTALL=1
mv -- "$STAGED_INSTALL_ROOT" "$INSTALL_ROOT"
STAGED_INSTALL_ROOT=""

mkdir -p "$BIN_DIR" "$PORTAL_PATH" "$WW_RUNTIME_HOME" "$WW_CONFIG_DIR"
chmod 700 "$WW_RUNTIME_HOME" "$WW_CONFIG_DIR"
write_launcher_wrapper "$BIN_DIR/ww"
write_launcher_wrapper "$BIN_DIR/workwire"

if [[ -f "$ICON_PATH" ]]; then
  write_desktop_entry
fi

if command_exists systemctl && systemctl --user --version >/dev/null 2>&1; then
  if install_systemd_user_service; then
    :
  else
    printf 'systemd --user setup failed; falling back to desktop-session autostart.\n' >&2
    install_fallback_autostart
  fi
else
  install_fallback_autostart
fi

printf 'Installed WorkWire to %s\n' "$INSTALL_ROOT"
printf 'Installed launchers at %s/{workwire,ww}\n' "$BIN_DIR"
printf 'Ensured WW portal at %s\n' "$PORTAL_PATH"
if [[ -f "$DESKTOP_PATH" ]]; then
  printf 'Installed WorkWire desktop entry at %s\n' "$DESKTOP_PATH"
fi
printf 'Shared WW log file: %s\n' "$LOG_PATH"
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  printf 'Warning: %s is not currently on PATH in this shell.\n' "$BIN_DIR"
fi

INSTALL_COMPLETE=1
