import test from "node:test";
import assert from "node:assert/strict";
import { extractElectronAppArgv } from "../lib/electron-app-argv.mjs";

test("extractElectronAppArgv drops the dev app path argument", () => {
  assert.deepEqual(
    extractElectronAppArgv([
      "/usr/bin/electron",
      "/tmp/WorkWire/desktop/ww-runtime.cjs",
      "--local",
      "/srv/work",
    ]),
    ["--local", "/srv/work"],
  );
});

test("extractElectronAppArgv keeps packaged flags intact", () => {
  assert.deepEqual(
    extractElectronAppArgv([
      "/opt/WorkWire/ww",
      "--peer",
      "box:4851",
    ]),
    ["--peer", "box:4851"],
  );
});

test("extractElectronAppArgv keeps packaged subcommands intact", () => {
  assert.deepEqual(
    extractElectronAppArgv([
      "/opt/WorkWire/ww",
      "serve",
      "--port",
      "4851",
    ]),
    ["serve", "--port", "4851"],
  );
});
