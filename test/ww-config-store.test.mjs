import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDefaultWwConfig,
  buildPersistedWwConfig,
  deriveWwTrustId,
  loadWwConfig,
  normalizePort,
  normalizeWwConfig,
  parsePeerSpec,
  rememberPeer,
  ensureWwPortalRoot,
  resolveWwConfigPath,
  resolveWwHomeDir,
  resolveWwPortalEnvironmentRoot,
  resolveWwPortalRoot,
  saveWwConfig,
  updateWwConfig,
  WW_CONFIG_VERSION,
  WW_PORTAL_DIRNAME,
  WW_PORTAL_ENVIRONMENT_DIRNAME,
} from "../lib/ww-config-store.mjs";

test("ww config defaults are local-first and tokenized", () => {
  const config = buildDefaultWwConfig({
    homeDir: "/home/tester",
    hostName: "alpha-box",
  });

  assert.equal(config.ui.localPath, path.join("/home/tester", WW_PORTAL_DIRNAME));
  assert.equal(config.service.name, "alpha-box");
  assert.equal(config.service.rootPath, path.join("/home/tester", WW_PORTAL_DIRNAME));
  assert.match(config.service.machineId, /^[A-Za-z0-9_-]{12,}$/);
  assert.match(config.service.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(config.peer.machineId, "");
});

test("ww config paths respect explicit standalone env overrides", () => {
  const env = {
    WW_HOME_DIR: "/srv/workwire/.workwire",
    WW_CONFIG_DIR: "/srv/workwire/.workwire/config",
    WW_PORTAL_PATH: "/srv/workwire/app",
  };

  assert.equal(resolveWwHomeDir({ env, homeDir: "/home/tester" }), path.resolve(env.WW_HOME_DIR));
  assert.equal(resolveWwConfigPath({ env, homeDir: "/home/tester" }), path.resolve(env.WW_CONFIG_DIR, "ww-config.json"));
  assert.equal(resolveWwPortalRoot("/home/tester", { env }), path.resolve(env.WW_PORTAL_PATH));
});

test("ww portal environment lives inside the portal root", () => {
  assert.equal(
    resolveWwPortalEnvironmentRoot("/home/tester/WorkWire"),
    path.join("/home/tester/WorkWire", WW_PORTAL_ENVIRONMENT_DIRNAME),
  );
  assert.equal(resolveWwPortalEnvironmentRoot(""), "");
  assert.equal(
    resolveWwPortalEnvironmentRoot(resolveWwPortalRoot("/home/tester")),
    path.join("/home/tester", WW_PORTAL_DIRNAME, WW_PORTAL_ENVIRONMENT_DIRNAME),
  );
});

test("ww ensureWwPortalRoot creates the portal environment directory", async () => {
  const rootPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ww-portal-")), "WorkWire");
  try {
    await ensureWwPortalRoot(rootPath);
    const stats = await fs.stat(path.join(rootPath, WW_PORTAL_ENVIRONMENT_DIRNAME));
    assert.ok(stats.isDirectory());
  } finally {
    await fs.rm(path.dirname(rootPath), { recursive: true, force: true });
  }
});

test("ww trust ids are stable and non-empty for non-empty tokens", () => {
  assert.equal(deriveWwTrustId("alpha-token"), deriveWwTrustId("alpha-token"));
  assert.notEqual(deriveWwTrustId("alpha-token"), deriveWwTrustId("beta-token"));
  assert.equal(deriveWwTrustId(""), "");
});

test("ww config normalization repairs invalid values", () => {
  const defaults = buildDefaultWwConfig({
    homeDir: "/home/tester",
    hostName: "alpha-box",
  });
  const normalized = normalizeWwConfig({
    ui: {
      localPath: "",
      conflictPolicy: "destroy",
    },
    service: {
      host: " ",
      port: "99999",
      machineId: "",
      token: "",
      name: "",
    },
    peer: {
      host: "peer-box",
      port: "abc",
      machineId: "",
    },
  }, defaults);

  assert.equal(normalized.ui.localPath, resolveWwPortalRoot("/home/tester"));
  assert.equal(normalized.ui.conflictPolicy, "rename");
  assert.equal(normalized.service.host, defaults.service.host);
  assert.equal(normalized.service.port, defaults.service.port);
  assert.equal(normalized.service.machineId, defaults.service.machineId);
  assert.equal(normalized.service.rootPath, resolveWwPortalRoot("/home/tester"));
  assert.notEqual(normalized.service.token, "");
  assert.equal(normalized.peer.host, "peer-box");
  assert.equal(normalized.peer.port, defaults.peer.port);
  assert.equal(normalized.peer.machineId, "");
});

test("ww peer parser accepts host and host:port", () => {
  assert.equal(normalizePort("4851oops", 9000), 9000);
  assert.deepEqual(parsePeerSpec("fileserver"), {
    host: "fileserver",
    port: 4851,
  });
  assert.deepEqual(parsePeerSpec("fileserver:9000"), {
    host: "fileserver",
    port: 9000,
  });
  assert.deepEqual(parsePeerSpec("[fe80::1]:6000"), {
    host: "fe80::1",
    port: 6000,
  });
});

test("ww rememberPeer stores the active peer at the front of recents", () => {
  const config = buildDefaultWwConfig({
    homeDir: os.homedir(),
    hostName: os.hostname(),
  });
  const next = rememberPeer(config, {
    label: "Remote Dev",
    host: "10.0.0.40",
    port: 4851,
    machineId: "peer-machine-id",
    token: "secret",
    remotePath: `${os.homedir()}/shared`,
  });

  assert.equal(next.peer.host, "10.0.0.40");
  assert.equal(next.peer.label, "Remote Dev");
  assert.equal(next.peer.machineId, "peer-machine-id");
  assert.equal(next.recentPeers.length, 1);
  assert.equal(next.recentPeers[0].host, "10.0.0.40");
  assert.equal(next.ui.remotePath, "");
});

test("ww rememberPeer can pin a machine identity before a host is known", () => {
  const config = buildDefaultWwConfig({
    homeDir: os.homedir(),
    hostName: os.hostname(),
  });

  const next = rememberPeer(config, {
    machineId: "peer-machine-id",
  });

  assert.equal(next.peer.machineId, "peer-machine-id");
  assert.equal(next.peer.host, "");
  assert.equal(next.recentPeers.length, 0);
});

test("ww rememberPeer replaces stale DHCP host entries for the same pinned machine", () => {
  const config = buildDefaultWwConfig({
    homeDir: os.homedir(),
    hostName: os.hostname(),
  });
  const initial = rememberPeer(config, {
    label: "Remote Dev",
    host: "10.0.0.40",
    port: 4851,
    machineId: "peer-machine-id",
    token: "secret",
  });

  const next = rememberPeer(initial, {
    label: "Remote Dev",
    host: "10.0.0.88",
    port: 4851,
    machineId: "peer-machine-id",
    token: "secret",
  });

  assert.equal(next.peer.host, "10.0.0.88");
  assert.equal(next.peer.machineId, "peer-machine-id");
  assert.equal(next.recentPeers.length, 1);
  assert.equal(next.recentPeers[0].host, "10.0.0.88");
});

test("ww loadWwConfig normalizes the canonical persisted state", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ww-config-load-"));
  const defaults = buildDefaultWwConfig({
    homeDir: tempHome,
    hostName: "alpha-box",
  });
  const configPath = path.join(tempHome, ".config", "workwire", "ww-config.json");
  const storedConfig = {
    version: WW_CONFIG_VERSION,
    ui: {
      localPath: "/srv/ignored-root",
      remotePath: "/home/peer/WorkWire/archive",
      showHidden: true,
      conflictPolicy: "overwrite",
    },
    service: {
      host: "127.0.0.1",
      port: 5120,
      machineId: "desk-machine",
      token: "desk-token",
      name: "Desk Tower",
      rootPath: "/srv/ignored-root",
    },
    peer: {
      label: "Office PC",
      host: "10.0.0.40",
      port: 7000,
      machineId: "peer-machine",
      token: "peer-token",
      remotePath: "/home/peer/WorkWire",
    },
    recentPeers: [
      {
        label: "Office PC",
        host: "10.0.0.40",
        port: 7000,
        machineId: "peer-machine",
        token: "stale-token",
        remotePath: "/srv/stale",
      },
      {
        label: "Laptop",
        host: "10.0.0.41",
        port: 4851,
        machineId: "laptop-machine",
        token: "laptop-token",
        remotePath: "/home/laptop/WorkWire",
      },
    ],
  };

  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(storedConfig, null, 2)}\n`, "utf8");

    const loaded = await loadWwConfig({
      configPath,
      defaults,
    });

    assert.equal(loaded.version, WW_CONFIG_VERSION);
    assert.equal(loaded.ui.localPath, path.join(tempHome, WW_PORTAL_DIRNAME));
    assert.equal(loaded.ui.remotePath, "/home/peer/WorkWire/archive");
    assert.equal(loaded.ui.showHidden, true);
    assert.equal(loaded.ui.conflictPolicy, "overwrite");
    assert.equal(loaded.service.host, "127.0.0.1");
    assert.equal(loaded.service.port, 5120);
    assert.equal(loaded.service.machineId, "desk-machine");
    assert.equal(loaded.service.token, "desk-token");
    assert.equal(loaded.service.name, "Desk Tower");
    assert.equal(loaded.service.rootPath, path.join(tempHome, WW_PORTAL_DIRNAME));
    assert.equal(loaded.peer.machineId, "peer-machine");
    assert.equal(loaded.peer.host, "10.0.0.40");
    assert.equal(loaded.recentPeers.length, 2);
    assert.equal(loaded.recentPeers[0].machineId, "peer-machine");
    assert.equal(loaded.recentPeers[1].machineId, "laptop-machine");

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));

    assert.deepEqual(persisted, {
      version: WW_CONFIG_VERSION,
      ui: {
        remotePath: "/home/peer/WorkWire/archive",
        showHidden: true,
        conflictPolicy: "overwrite",
      },
      service: {
        host: "127.0.0.1",
        port: 5120,
        machineId: "desk-machine",
        token: "desk-token",
        name: "Desk Tower",
      },
      peer: {
        label: "Office PC",
        host: "10.0.0.40",
        port: 7000,
        machineId: "peer-machine",
        token: "peer-token",
        remotePath: "/home/peer/WorkWire",
      },
      recentPeers: [
        {
          label: "Office PC",
          host: "10.0.0.40",
          port: 7000,
          machineId: "peer-machine",
          token: "stale-token",
          remotePath: "/srv/stale",
        },
        {
          label: "Laptop",
          host: "10.0.0.41",
          port: 4851,
          machineId: "laptop-machine",
          token: "laptop-token",
          remotePath: "/home/laptop/WorkWire",
        },
      ],
    });
    assert.equal(Object.hasOwn(persisted.ui, "localPath"), false);
    assert.equal(Object.hasOwn(persisted.service, "rootPath"), false);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("ww saveWwConfig writes only the zero-config state model", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ww-config-save-"));
  const defaults = buildDefaultWwConfig({
    homeDir: tempHome,
    hostName: "alpha-box",
  });
  const configPath = path.join(tempHome, ".config", "workwire", "ww-config.json");

  try {
    const saved = await saveWwConfig({
      ...defaults,
      ui: {
        ...defaults.ui,
        remotePath: "/home/peer/WorkWire/photos",
        showHidden: true,
      },
      peer: {
        label: "Remote Dev",
        host: "10.0.0.40",
        port: 4851,
        machineId: "peer-machine",
        token: "peer-token",
        remotePath: "/home/peer/WorkWire",
      },
    }, {
      configPath,
      defaults,
    });

    assert.equal(saved.ui.localPath, path.join(tempHome, WW_PORTAL_DIRNAME));
    assert.equal(saved.service.rootPath, path.join(tempHome, WW_PORTAL_DIRNAME));

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(persisted, buildPersistedWwConfig(saved, defaults));
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
    }
    assert.equal(Object.hasOwn(persisted.ui, "localPath"), false);
    assert.equal(Object.hasOwn(persisted.service, "rootPath"), false);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("ww config transactions serialize concurrent writers without losing changes", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ww-config-lock-"));
  const defaults = buildDefaultWwConfig({ homeDir: tempHome, hostName: "lock-box" });
  const configPath = path.join(tempHome, ".config", "workwire", "ww-config.json");
  try {
    await saveWwConfig(defaults, { configPath, defaults });
    await Promise.all([
      updateWwConfig(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        current.ui.showHidden = true;
        return current;
      }, { configPath, defaults }),
      updateWwConfig((current) => {
        current.peer.host = "10.0.0.25";
        current.peer.machineId = "peer-machine";
        return current;
      }, { configPath, defaults }),
    ]);

    const loaded = await loadWwConfig({ configPath, defaults });
    assert.equal(loaded.ui.showHidden, true);
    assert.equal(loaded.peer.host, "10.0.0.25");
    assert.equal(loaded.peer.machineId, "peer-machine");
    await assert.rejects(fs.access(`${configPath}.lock`));
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
