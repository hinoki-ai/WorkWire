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
});
