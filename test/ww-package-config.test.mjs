import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "electron-builder.linux.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

test("ww linux build config packages a dedicated runtime", () => {
  assert.equal(config.appId, "com.hinoki.workwire");
  assert.equal(config.productName, "WorkWire");
  assert.equal(config.executableName, "ww");
  assert.deepEqual(config.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  });
  assert.equal(config.directories.output, "dist/ww");
  assert.equal(config.extraMetadata.main, "desktop/ww-runtime.cjs");
  assert.equal(config.extraMetadata.desktopName, "workwire.desktop");
  assert.equal(config.linux.icon, "desktop/assets/workwire/icon.png");
  assert.equal(config.linux.syncDesktopName, true);
  assert.deepEqual(config.linux.target, ["AppImage"]);
});

test("ww npm commands use the standalone launcher layout", () => {
  assert.equal(packageJson.scripts.start, "bash ./scripts/ww");
  assert.equal(packageJson.scripts.ww, "bash ./scripts/ww");
  assert.equal(packageJson.scripts.serve, "bash ./scripts/ww serve");
  assert.equal(packageJson.scripts.test, "node --test test/*.test.mjs");
  assert.equal(packageJson.scripts["dist:linux"], "node ./scripts/package-ww-linux.mjs");
  assert.match(packageJson.devDependencies.electron, /^\^43\./);
  assert.equal(typeof packageJson.devDependencies["electron-builder"], "string");
  assert.equal(typeof packageJson.devDependencies.jsdom, "string");
});

test("ww linux build config only includes WW runtime surfaces", () => {
  assert.ok(config.files.includes("ww.mjs"));
  assert.ok(config.files.includes("desktop/ww-main.mjs"));
  assert.ok(config.files.includes("desktop/ww-runtime.mjs"));
  assert.ok(config.files.includes("desktop/ww/**/*"));
  assert.ok(config.files.includes("lib/ww*.mjs"));
  assert.ok(config.files.includes("lib/electron-app-argv.mjs"));
  assert.ok(config.files.includes("lib/recovery/**/*.mjs"));
  assert.ok(config.files.includes("recovery/**/*"));
  // The recovery runtime ships as a single staged tree so electron-builder does
  // not exclude lib/package.json from the asar (extraResources `from` paths are
  // dropped from the asar to avoid duplication). The packaging script stages
  // dist/recovery-runtime before the build.
  assert.deepEqual(config.extraResources, [
    { from: "dist/recovery-runtime", to: "recovery-runtime" },
    { from: "node_modules/ws", to: "recovery-runtime/node_modules/ws" },
  ]);
});

test("ww linux packager stages the recovery runtime it ships as resources", () => {
  const packagerSource = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "package-ww-linux.mjs"),
    "utf8",
  );
  assert.match(packagerSource, /RECOVERY_STAGING_DIR\s*=\s*path\.join\([^)]*"dist",\s*"recovery-runtime"\)/);
  assert.match(packagerSource, /stageRecoveryRuntime\(\)/);
  // The staged tree must carry the source the spawned recovery subprocesses run
  // (ws ships via a dedicated extraResources entry, asserted on the config above).
  assert.match(packagerSource, /"lib"[\s\S]*RECOVERY_STAGING_DIR, "lib"/);
  assert.match(packagerSource, /"recovery"[\s\S]*RECOVERY_STAGING_DIR, "recovery"/);
  assert.match(packagerSource, /package\.json[\s\S]*RECOVERY_STAGING_DIR,\s*\n?\s*"package\.json"/);
});
