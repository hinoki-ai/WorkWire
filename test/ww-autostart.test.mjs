import test from "node:test";
import assert from "node:assert/strict";
import {
  WW_SYSTEMD_USER_UNIT_NAME,
  buildWwFallbackAutostartEntry,
  buildWwFallbackSupervisorScript,
  buildWwSystemdUserUnit,
  resolveWwFallbackAutostartEntryPath,
  resolveWwFallbackSupervisorPath,
  resolveWwLogPath,
  resolveWwSystemdUserUnitPath,
} from "../lib/ww-autostart.mjs";

test("ww systemd user unit keeps the background service running on login failures and writes to the journal", () => {
  const unit = buildWwSystemdUserUnit();

  assert.match(unit, /\nDescription=WorkWire background service\n/);
  assert.match(unit, /\nExecStart=%h\/\.local\/bin\/ww serve\n/);
  assert.match(unit, /\nUMask=0077\n/);
  assert.match(unit, /\nRestart=on-failure\n/);
  assert.match(unit, /\nRestartSec=2\n/);
  assert.match(unit, /\nStandardOutput=journal\n/);
  assert.match(unit, /\nStandardError=journal\n/);
  assert.match(unit, /\nSyslogIdentifier=workwire-ww\n/);
  assert.match(unit, /\nWantedBy=default\.target\n/);
});

test("ww fallback supervisor restarts ww serve and appends to the shared WW log", () => {
  const script = buildWwFallbackSupervisorScript({
    wwBinPath: "/home/test/.local/bin/ww",
    logPath: "/home/test/.config/workwire/ww.log",
  });

  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /\numask 077\n/);
  assert.match(script, /"\$WW_BIN_PATH" serve >>"\$LOG_PATH" 2>&1/);
  assert.match(script, /while true; do/);
  assert.match(script, /sleep 2/);
});

test("ww fallback desktop entry starts the supervisor on login without showing a launcher", () => {
  const desktopEntry = buildWwFallbackAutostartEntry({
    launcherPath: "/home/test/.local/share/workwire/ww-background-supervisor.sh",
  });

  assert.match(desktopEntry, /\nType=Application\n/);
  assert.match(desktopEntry, /\nName=WorkWire Background Service\n/);
  assert.match(desktopEntry, /\nExec="\/home\/test\/\.local\/share\/workwire\/ww-background-supervisor\.sh"\n/);
  assert.match(desktopEntry, /\nNoDisplay=true\n/);
  assert.match(desktopEntry, /\nX-GNOME-Autostart-enabled=true\n/);
});

test("ww autostart paths respect the XDG base directories", () => {
  const env = {
    XDG_CONFIG_HOME: "/data/config",
    XDG_DATA_HOME: "/data/share",
  };

  assert.equal(resolveWwSystemdUserUnitPath({ env, homeDir: "/home/test" }), `/data/config/systemd/user/${WW_SYSTEMD_USER_UNIT_NAME}`);
  assert.equal(resolveWwFallbackAutostartEntryPath({ env, homeDir: "/home/test" }), "/data/config/autostart/workwire-ww-background.desktop");
  assert.equal(resolveWwFallbackSupervisorPath({ env, homeDir: "/home/test" }), "/data/share/workwire/ww-background-supervisor.sh");
  assert.equal(resolveWwLogPath({ env, homeDir: "/home/test" }), "/data/config/workwire/ww.log");
});
