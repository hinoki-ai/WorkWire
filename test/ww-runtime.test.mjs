import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPackagedWwDesktopLaunchSpec,
  resolvePackagedWwRuntimeMode,
} from "../desktop/ww-runtime.mjs";

test("packaged ww desktop launch spec relaunches the self-contained ww executable", () => {
  const spec = buildPackagedWwDesktopLaunchSpec({
    argv: ["--local", "/srv/projects"],
    execPath: "/opt/WorkWire/ww",
    env: {
      DISPLAY: ":1",
    },
    platform: "linux",
  });

  assert.deepEqual(spec, {
    command: "/opt/WorkWire/ww",
    args: ["--local", "/srv/projects"],
    options: {
      env: {
        CHROME_DESKTOP: "workwire.desktop",
        DISPLAY: ":1",
      },
      stdio: "inherit",
    },
  });
});

test("packaged ww runtime routes headless subcommands without opening the desk", () => {
  const mode = resolvePackagedWwRuntimeMode(["serve", "--port", "5120"]);

  assert.equal(mode.kind, "command");
  assert.equal(mode.parsed.command, "serve");
  assert.equal(mode.parsed.flags.port, "5120");
});

test("packaged ww runtime routes pairing profiles without opening the desk", () => {
  const mode = resolvePackagedWwRuntimeMode(["pair", "/media/WORKWIRE/pairing.json"]);

  assert.equal(mode.kind, "command");
  assert.equal(mode.parsed.command, "pair");
  assert.deepEqual(mode.parsed.positionals, ["/media/WORKWIRE/pairing.json"]);
});

test("packaged ww runtime keeps desktop argument normalization", () => {
  const mode = resolvePackagedWwRuntimeMode([
    "--remote",
    "fileserver:5120:/srv/shared",
  ]);

  assert.equal(mode.kind, "desktop");
  assert.deepEqual(mode.argv, [
    "--remote",
    "fileserver:5120:/srv/shared",
    "--peer",
    "fileserver:5120",
    "--remote-path",
    "/srv/shared",
  ]);
});
