import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDefaultRecoveryConfig,
  loadRecoveryConfig,
  normalizeRecoveryConfig,
  resolveRecoveryConfigPath,
  resolveRecoveryStateDir,
  saveRecoveryConfig,
  WW_RECOVERY_DEFAULT_BOOT_PORT,
  WW_RECOVERY_DEFAULT_PORT,
} from "../lib/recovery/ww-recovery-config.mjs";

test("recovery config has isolated defaults and preserves an empty token", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-config-"));
  const env = { XDG_CONFIG_HOME: path.join(homeDir, "configuration") };
  try {
    const defaults = buildDefaultRecoveryConfig({ env, homeDir });
    assert.equal(defaults.port, WW_RECOVERY_DEFAULT_PORT);
    assert.equal(defaults.bootPort, WW_RECOVERY_DEFAULT_BOOT_PORT);
    assert.equal(defaults.token, "");
    assert.equal(defaults.maxArtifactBytes, 0);
    assert.equal(defaults.stateDir, path.join(env.XDG_CONFIG_HOME, "workwire", "recovery"));

    const configPath = resolveRecoveryConfigPath({ env, homeDir });
    await saveRecoveryConfig({ ...defaults, token: "" }, { configPath, env, homeDir, defaults });
    const loaded = await loadRecoveryConfig({ configPath, env, homeDir, defaults });
    assert.equal(loaded.token, "");
    assert.equal(resolveRecoveryStateDir({ env, homeDir }), defaults.stateDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("recovery config applies every environment override and normalizes invalid values", () => {
  const env = {
    WW_RECOVERY_ENABLED: "false",
    WW_RECOVERY_HOST: "127.0.0.1",
    WW_RECOVERY_PORT: "6001",
    WW_RECOVERY_BOOT_HOST: "127.0.0.2",
    WW_RECOVERY_BOOT_PORT: "6002",
    WW_RECOVERY_ADVERTISED_HOST: "10.1.2.3",
    WW_RECOVERY_TOKEN: "",
    WW_RECOVERY_STATE_DIR: "/tmp/ww-recovery-custom",
    WW_RECOVERY_PLANNER_COMMAND: '["planner","--jsonl"]',
  };
  const defaults = buildDefaultRecoveryConfig({ env: {}, homeDir: "/home/test" });
  const normalized = normalizeRecoveryConfig({
    port: 99_999,
    heartbeatMs: -1,
    maxArtifactBytes: -2,
    extensions: { example: true },
    ignoredUnknown: true,
  }, defaults, { env });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.host, "127.0.0.1");
  assert.equal(normalized.port, 6001);
  assert.equal(normalized.bootHost, "127.0.0.2");
  assert.equal(normalized.bootPort, 6002);
  assert.equal(normalized.advertisedHost, "10.1.2.3");
  assert.equal(normalized.token, "");
  assert.equal(normalized.stateDir, path.resolve(env.WW_RECOVERY_STATE_DIR));
  assert.deepEqual(normalized.planner.command, ["planner", "--jsonl"]);
  assert.equal(normalized.planner.enabled, true);
  assert.deepEqual(normalized.extensions, { example: true });
  assert.equal(Object.hasOwn(normalized, "ignoredUnknown"), false);
});

test("recovery config serializes concurrent saves atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-config-concurrent-"));
  const env = { WW_RECOVERY_STATE_DIR: root };
  const configPath = path.join(root, "controller.json");
  const defaults = buildDefaultRecoveryConfig({ env, homeDir: root });
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => saveRecoveryConfig({
      ...defaults,
      advertisedHost: `10.0.0.${index + 1}`,
    }, { configPath, env, homeDir: root, defaults })));
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.match(raw.advertisedHost, /^10\.0\.0\.\d+$/);
    assert.equal(raw.token, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
