import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("ww installer creates WorkWire and a visible launcher for a fresh Linux home", async (context) => {
  if (process.platform !== "linux") {
    context.skip("linux-only launcher contract");
    return;
  }

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-install-home-"));
  const xdgDataHome = path.join(homeDir, ".local", "share");

  await execFileAsync("bash", ["./scripts/install-ww.sh"], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_DATA_HOME: xdgDataHome,
    },
  });

  const portalStat = await fs.stat(repoDir);
  assert.equal(portalStat.isDirectory(), true);

  const canonicalLauncherPath = path.join(repoDir, "scripts", "launch-workwire.sh");
  assert.equal(
    await fs.readlink(path.join(homeDir, ".local", "bin", "workwire")),
    canonicalLauncherPath,
  );
  assert.equal(
    await fs.readlink(path.join(homeDir, ".local", "bin", "ww")),
    canonicalLauncherPath,
  );
  const launchedHelp = await execFileAsync(path.join(homeDir, ".local", "bin", "ww"), ["--help"], {
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_DATA_HOME: xdgDataHome,
    },
  });
  assert.match(launchedHelp.stdout, /Usage:\n  ww\n/);

  const desktopEntryPath = path.join(xdgDataHome, "applications", "workwire.desktop");
  const desktopEntry = await fs.readFile(desktopEntryPath, "utf8");
  assert.match(desktopEntry, /\nName=WorkWire\n/);
  assert.match(
    desktopEntry,
    new RegExp(`\\nExec="${escapeRegExp(canonicalLauncherPath)}" %U\\n`),
  );
  assert.match(desktopEntry, /\nStartupWMClass=WorkWire\n/);
});

test("ww installer adds a desktop shortcut only when requested", async (context) => {
  if (process.platform !== "linux") {
    context.skip("linux-only launcher contract");
    return;
  }

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-install-shortcut-home-"));
  const xdgDataHome = path.join(homeDir, ".local", "share");
  const desktopDir = path.join(homeDir, "Desktop");

  await execFileAsync("bash", ["./scripts/install-ww.sh", "--desktop-shortcut"], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_DATA_HOME: xdgDataHome,
      XDG_DESKTOP_DIR: desktopDir,
    },
  });

  const shortcutPath = path.join(desktopDir, "workwire.desktop");
  const shortcutEntry = await fs.readFile(shortcutPath, "utf8");
  assert.match(shortcutEntry, /\nName=WorkWire\n/);
});
