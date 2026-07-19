import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  WW_APP_VERSION,
  WW_ARTIFACT_VERSION,
  WW_BUILD_HASH,
  WW_PACKAGE_VERSION,
  WW_RELEASE_INFO,
  collectWwReleaseSourceFiles,
  sanitizeWwArtifactVersion,
} from "../lib/ww-release.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_BASE_DIR = path.resolve(__dirname, "..");

test("ww release info fingerprints the WW runtime and keeps file-safe artifact names", () => {
  assert.match(WW_BUILD_HASH, /^[0-9a-f]{64}$/);
  assert.equal(WW_APP_VERSION.startsWith(`${WW_PACKAGE_VERSION}+ww1.`), true);
  assert.equal(WW_ARTIFACT_VERSION.startsWith(`${WW_PACKAGE_VERSION}-ww1.`), true);
  assert.equal(WW_ARTIFACT_VERSION.includes("+"), false);
  assert.equal(Array.isArray(WW_RELEASE_INFO.files), true);
  assert.equal(WW_RELEASE_INFO.files.includes("ww.mjs"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("desktop/app-protocol.mjs"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("desktop/assets/workwire/icon.png"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("lib/ww-release.mjs"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("lib/ww-mirror.mjs"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("lib/recovery/ww-recovery-controller.mjs"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("package.json"), true);
  assert.equal(WW_RELEASE_INFO.files.includes("scripts/install-ww-bundle.sh"), true);
  assert.equal(WW_RELEASE_INFO.files.some((file) => file.includes("/ops/")), false);
  assert.equal(WW_RELEASE_INFO.files.some((file) => file.includes("(WW conflict ")), false);
});

test("ww release collection excludes preserved mirror conflicts", async (context) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-release-conflicts-"));
  context.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "scripts", "tool.mjs"), "export const live = true;\n");
  await fs.writeFile(
    path.join(fixtureRoot, "scripts", "tool (WW conflict deadbeef-1234).mjs"),
    "export const stale = true;\n",
  );

  assert.deepEqual(await collectWwReleaseSourceFiles(fixtureRoot), ["scripts/tool.mjs"]);
});

test("ww release identity survives Electron's packaged metadata rewrite", async (context) => {
  const packagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-release-packaged-"));
  context.after(() => fs.rm(packagedRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(packagedRoot, "lib"));
  await fs.copyFile(
    path.join(APP_BASE_DIR, "lib", "ww-release.mjs"),
    path.join(packagedRoot, "lib", "ww-release.mjs"),
  );
  await fs.writeFile(path.join(packagedRoot, "package.json"), JSON.stringify({
    version: WW_PACKAGE_VERSION,
    main: "desktop/ww-runtime.cjs",
    productName: "WorkWire",
    workwireBuildHash: WW_BUILD_HASH,
    workwireReleaseHashVersion: WW_RELEASE_INFO.hashVersion,
  }));

  const packagedModule = await import(
    `${pathToFileURL(path.join(packagedRoot, "lib", "ww-release.mjs")).href}?fixture=1`
  );
  assert.equal(packagedModule.WW_BUILD_HASH, WW_BUILD_HASH);
  assert.equal(packagedModule.WW_APP_VERSION, WW_APP_VERSION);
  assert.deepEqual(packagedModule.WW_RELEASE_INFO.files, []);
});

test("ww artifact-version sanitization normalizes build metadata for filenames", () => {
  assert.equal(
    sanitizeWwArtifactVersion("1.2.3+ww1.abcdef012345"),
    "1.2.3-ww1.abcdef012345",
  );
  assert.equal(
    sanitizeWwArtifactVersion("1.2.3 release candidate"),
    "1.2.3-release-candidate",
  );
});
