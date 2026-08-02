import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Windows source convergence encodes fleet, clock, task, and exact-source invariants", async () => {
  const source = await fs.readFile(new URL("../scripts/converge-ww-windows.ps1", import.meta.url), "utf8");
  assert.match(source, /workwire-source-deployment\/v1/);
  assert.match(source, /Reconcile-ReleaseExtras/);
  assert.match(source, /WW_RECOVERY_CONTROLLER_URL/);
  assert.match(source, /extensions = \$extensions/);
  assert.match(source, /RealTimeIsUniversal/);
  assert.match(source, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(source, /Wait-ForFileService/);
  assert.match(source, /WorkWire LAN Beacon/);
  assert.match(source, /-Protocol UDP -LocalPort 9001-9002 -Profile Any/);
  assert.match(source, /-Protocol TCP -LocalPort 4851 -Profile Any/);
  assert.match(source, /Set-NetFirewallRule -Enabled True -Action Allow -Profile Any/);
  assert.match(source, /file-service-maintenance\.lock/);
  assert.match(source, /Remove-Item -LiteralPath \$maintenanceMarker/);
  assert.match(source, /backupRoot/);
  assert.doesNotMatch(source, /Hn6LCSaWC1bA3uxAU8Tus/u);
});

test("Windows cmd.exe service launch preserves the shared terminal grammar", async () => {
  const [windowsSource, launcherSource, serviceSource] = await Promise.all([
    fs.readFile(new URL("../scripts/converge-ww-windows.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../ww.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../lib/ww-service.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(windowsSource, /-Execute \$env:ComSpec/);
  assert.match(windowsSource, /\/d \/s \/c/);
  assert.match(windowsSource, /chcp 65001>nul/);
  assert.match(windowsSource, /WorkWire - \{0\} Service/);
  assert.match(windowsSource, /\$consoleTitle/);
  assert.match(windowsSource, /"\{2\}" serve/);
  for (const line of [
    "WW service ready for",
    "Config:",
    "Portal:",
  ]) {
    assert.match(launcherSource, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(serviceSource, /WW service listening on/);
});

test("Windows recovery-agent installer delegates its staged swap to an independent SYSTEM task", async () => {
  const source = await fs.readFile(new URL("../scripts/install-ww-recovery-agent-windows.ps1", import.meta.url), "utf8");
  const completer = await fs.readFile(new URL("../scripts/complete-ww-recovery-agent-update-windows.ps1", import.meta.url), "utf8");
  const stageAt = source.indexOf("Copy-Item -Recurse -Force (Join-Path $scriptRoot \"lib\")");
  const updaterAt = source.indexOf("Register-ScheduledTask -TaskName $updateTaskName");
  assert.ok(stageAt > 0 && updaterAt > stageAt);
  assert.doesNotMatch(source, /Stop-ScheduledTask -TaskName \$taskName/);
  assert.match(source, /separate SYSTEM/i);
  assert.match(source, /UserId "SYSTEM"/);
  assert.match(completer, /Stop-ScheduledTask -TaskName \$TaskName/);
  assert.match(completer, /Move-Item -LiteralPath \$NextRoot -Destination \$InstallRoot/);
  assert.match(completer, /rolledBack/);
  assert.match(completer, /RestartCount 999/);
  assert.match(completer, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
});

test("Linux recovery-agent installer stages, atomically activates, restarts, and rolls back", async () => {
  const source = await fs.readFile(new URL("../scripts/install-ww-recovery-agent.sh", import.meta.url), "utf8");
  const stageAt = source.indexOf("staging_root=\"$(mktemp -d");
  const stopAt = source.indexOf("systemctl stop workwire-recovery-agent.service");
  const activateAt = source.indexOf('mv -- "$staging_root" "$install_root"');
  const restartAt = source.indexOf("systemctl restart workwire-recovery-agent.service");
  assert.ok(stageAt > 0 && stopAt > stageAt && activateAt > stopAt && restartAt > activateAt);
  assert.match(source, /previous runtime was restored/i);
  assert.match(source, /rollback attempted/i);
  assert.match(source, /systemctl is-active --quiet/);
});

test("recovery deployment and image surfaces reject preserved WW conflict artifacts", async () => {
  const sources = await Promise.all([
    fs.readFile(new URL("../scripts/build-ww-recovery-image.sh", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/install-ww-recovery-agent.sh", import.meta.url), "utf8"),
    fs.readFile(new URL("../scripts/install-ww-recovery-host.sh", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    assert.match(source, /--exclude='\* \(WW conflict \*\)\*'/u);
    assert.match(source, /--exclude='WW conflict \*'/u);
    assert.match(source, /find "\$target_tree"[\s\S]*-name '\* \(WW conflict \*\)\*'/u);
  }

  const verifier = await fs.readFile(new URL("../scripts/verify-ww-recovery-image.mjs", import.meta.url), "utf8");
  assert.match(verifier, /isWwMirrorConflictBasename/u);
  assert.match(verifier, /Recovery SquashFS contains WW conflict artifact/u);
  assert.match(verifier, /ww-recovery-atomic\.mjs/u);
});

test("recovery atomic durability uses Windows-compatible writable fsync handles", async () => {
  const [configSource, storeSource] = await Promise.all([
    fs.readFile(new URL("../lib/recovery/ww-recovery-config.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../lib/recovery/ww-recovery-store.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [configSource, storeSource]) {
    assert.match(source, /open\(temporaryPath, "r\+"\)/);
    assert.doesNotMatch(source, /open\(temporaryPath, "r"\)/);
    assert.match(source, /finally\s*\{\s*await handle\.close\(\)/u);
  }
});
