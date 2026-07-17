import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLinuxWwDesktopEntry,
  configureWwElectronAppIdentity,
  LINUX_WW_DESKTOP_ENTRY_NAME,
  WORKWIRE_WINDOW_CLASS,
} from "../desktop/linux-integration.mjs";

test("WorkWire uses one Linux desktop ID for Electron and the pinned launcher", () => {
  const calls = [];
  const env = {};
  const electronApp = {
    commandLine: {
      appendSwitch(name, value) {
        calls.push(["appendSwitch", name, value]);
      },
    },
    getPath(name) {
      calls.push(["getPath", name]);
      return "/home/test/.config";
    },
    setDesktopName(value) {
      calls.push(["setDesktopName", value]);
    },
    setName(value) {
      calls.push(["setName", value]);
    },
    setPath(name, value) {
      calls.push(["setPath", name, value]);
    },
  };

  const identity = configureWwElectronAppIdentity(electronApp, {
    platform: "linux",
    env,
  });

  assert.equal(LINUX_WW_DESKTOP_ENTRY_NAME, "workwire.desktop");
  assert.equal(WORKWIRE_WINDOW_CLASS, "workwire");
  assert.equal(env.CHROME_DESKTOP, "workwire.desktop");
  assert.deepEqual(identity, {
    appName: "WorkWire",
    desktopEntryName: "workwire.desktop",
    windowClass: "workwire",
    userDataPath: "/home/test/.config/WorkWire",
  });
  assert.deepEqual(calls, [
    ["setName", "WorkWire"],
    ["getPath", "appData"],
    ["setDesktopName", "workwire.desktop"],
    ["setPath", "userData", "/home/test/.config/WorkWire"],
    ["appendSwitch", "class", "workwire"],
  ]);

  const desktopEntry = buildLinuxWwDesktopEntry({
    baseDir: "/home/test/WorkWire",
    launchScriptPath: "/home/test/WorkWire/scripts/launch-workwire.sh",
    iconPath: "/home/test/WorkWire/desktop/assets/workwire/icon.png",
  });
  assert.match(desktopEntry, /\nStartupWMClass=workwire\n/);
  assert.match(desktopEntry, /\nX-GNOME-WMClass=workwire\n/);
});
