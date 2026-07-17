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
const bundleInstallerSourcePath = path.join(repoDir, "scripts", "install-ww-bundle.sh");

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function createBundleFixture(tempRoot) {
  const bundleDir = path.join(tempRoot, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.copyFile(bundleInstallerSourcePath, path.join(bundleDir, "install-ww.sh"));
  await writeExecutable(
    path.join(bundleDir, "ww"),
    "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
  );
  await fs.writeFile(path.join(bundleDir, "icon.png"), "fixture", "utf8");
  return bundleDir;
}

test("packaged WW bundle installer provisions launcher, portal, and systemd user service", async (context) => {
  if (process.platform !== "linux") {
    context.skip("linux-only bundle installer");
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-bundle-install-"));
  try {
    const homeDir = path.join(tempRoot, "home");
    const xdgDataHome = path.join(homeDir, ".local", "share");
    const xdgConfigHome = path.join(homeDir, ".config");
    const fakeBinDir = path.join(tempRoot, "fake-bin");
    const systemctlLogPath = path.join(tempRoot, "systemctl.log");
    const bundleDir = await createBundleFixture(tempRoot);

    await fs.mkdir(fakeBinDir, { recursive: true });
    await writeExecutable(
      path.join(fakeBinDir, "systemctl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${systemctlLogPath}"
if [[ "\${1:-}" == "--user" && "\${2:-}" == "--version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "--user" && "\${2:-}" == "is-active" ]]; then
  exit 1
fi
exit 0
`,
    );

    await execFileAsync("bash", ["./install-ww.sh"], {
      cwd: bundleDir,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_DATA_HOME: xdgDataHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
      },
      maxBuffer: 4_000_000,
    });

    const installRoot = path.join(homeDir, ".local", "opt", "workwire");
    const portalPath = path.join(installRoot, "app");
    const desktopEntryPath = path.join(xdgDataHome, "applications", "workwire.desktop");
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "workwire-ww.service");

    assert.equal((await fs.stat(portalPath)).isDirectory(), true);
    assert.match(await fs.readFile(path.join(homeDir, ".local", "bin", "ww"), "utf8"), /export WW_PORTAL_PATH=.*\/\.local\/opt\/workwire\/app/);
    assert.match(await fs.readFile(path.join(homeDir, ".local", "bin", "ww"), "utf8"), /exec .*\/\.local\/opt\/workwire\/ww "\$@"/);
    assert.match(await fs.readFile(path.join(homeDir, ".local", "bin", "workwire"), "utf8"), /export WW_CONFIG_DIR=/);
    assert.match(await fs.readFile(desktopEntryPath, "utf8"), /\nName=WorkWire\n/);
    assert.match(await fs.readFile(desktopEntryPath, "utf8"), /\nExec=.*\/\.local\/bin\/ww %U\n/);
    assert.match(await fs.readFile(unitPath, "utf8"), /\nExecStart=.*\/\.local\/bin\/ww serve\n/);
    assert.match(await fs.readFile(unitPath, "utf8"), /\nUMask=0077\n/);

    const systemctlLog = await fs.readFile(systemctlLogPath, "utf8");
    assert.match(systemctlLog, /--user daemon-reload/);
    assert.match(systemctlLog, /--user enable workwire-ww\.service/);
    assert.match(systemctlLog, /--user start workwire-ww\.service/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("packaged WW bundle installer restores the previous install on post-swap failure", async (context) => {
  if (process.platform !== "linux") {
    context.skip("linux-only bundle installer");
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-bundle-install-rollback-"));
  try {
    const homeDir = path.join(tempRoot, "home");
    const xdgConfigHome = path.join(homeDir, ".config");
    const xdgDataHome = path.join(homeDir, ".local", "share");
    const installRoot = path.join(homeDir, ".local", "opt", "workwire");
    const bundleDir = await createBundleFixture(tempRoot);
    const fakeBinDir = path.join(tempRoot, "fake-bin");

    await fs.mkdir(installRoot, { recursive: true });
    await fs.mkdir(fakeBinDir, { recursive: true });
    await writeExecutable(path.join(fakeBinDir, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
    await fs.writeFile(path.join(installRoot, "marker.txt"), "old install\n", "utf8");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(xdgConfigHome, "blocked\n", "utf8");

    await assert.rejects(
      execFileAsync("bash", ["./install-ww.sh"], {
        cwd: bundleDir,
        env: {
          ...process.env,
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
          XDG_DATA_HOME: xdgDataHome,
          PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
        },
        maxBuffer: 4_000_000,
      }),
    );

    assert.equal(await fs.readFile(path.join(installRoot, "marker.txt"), "utf8"), "old install\n");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("packaged WW bundle installer refuses destructive install roots", async (context) => {
  if (process.platform !== "linux") {
    context.skip("linux-only bundle installer");
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-bundle-install-safety-"));
  try {
    const homeDir = path.join(tempRoot, "home");
    const bundleDir = await createBundleFixture(tempRoot);
    await fs.mkdir(homeDir, { recursive: true });
    await assert.rejects(
      execFileAsync("bash", ["./install-ww.sh"], {
        cwd: bundleDir,
        env: {
          ...process.env,
          HOME: homeDir,
          WW_INSTALL_ROOT: "/",
        },
      }),
      /Refusing unsafe WorkWire install root/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
