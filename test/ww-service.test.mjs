import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  WW_APP_VERSION,
  WW_LAN_INSTALLER_URL,
  WW_PROTOCOL_VERSION,
} from "../lib/ww-compat.mjs";
import { deriveWwTrustId } from "../lib/ww-config-store.mjs";
import { createWwService } from "../lib/ww-service.mjs";
import { WW_UPDATE_PROTOCOL_VERSION } from "../lib/ww-update.mjs";
import { createRemoteWwClient } from "../lib/ww-client.mjs";
import {
  WW_MACHINE_ROOT_PATH,
  createLocalEndpoint,
  createRemoteEndpoint,
} from "../lib/ww-endpoint.mjs";
import { transferSelections } from "../lib/ww-transfer.mjs";

async function withTempDir(run) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-test-"));
  try {
    return await run(baseDir);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    async json() {
      return payload;
    },
  };
}

test("ww service stop drains active peer connections", async () => {
  await withTempDir(async (baseDir) => {
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      token: "shutdown-token",
      name: "Shutdown Box",
      rootPath: baseDir,
    });
    const info = await service.start();
    const socket = net.createConnection({ host: "127.0.0.1", port: info.port });
    await once(socket, "connect");
    socket.write("GET /v1/ping HTTP/1.1\r\nHost: 127.0.0.1\r\n");

    const stopPromise = service.stop();
    let timeout;
    try {
      await Promise.race([
        stopPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("WW service stop timed out.")), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      socket.destroy();
      await stopPromise;
    }

    assert.equal(socket.destroyed, true);
  });
});

test("ww service supports remote CRUD over loopback", async () => {
  await withTempDir(async (baseDir) => {
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "loopback-machine",
      token: "loopback-token",
      name: "Loopback",
      rootPath: baseDir,
    });
    const info = await service.start();
    assert.deepEqual(service.getActivityStatus(), {
      activeRequests: 0,
      lastMutationAt: 0,
      lastRequestCompletedAt: 0,
    });
    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "loopback-token",
    });
    const remoteInfo = await client.connect();
    assert.equal(remoteInfo.machineId, "loopback-machine");
    assert.equal(remoteInfo.versions.protocol, WW_PROTOCOL_VERSION);
    assert.equal(remoteInfo.versions.app, WW_APP_VERSION);
    assert.equal(remoteInfo.installerUrl, WW_LAN_INSTALLER_URL);

    const remoteRoot = path.join(baseDir, "remote");
    await client.createDirectory({ path: remoteRoot });
    assert.equal(service.getActivityStatus().activeRequests, 0);
    assert.equal(service.getActivityStatus().lastMutationAt > 0, true);
    await client.createFile({
      path: path.join(remoteRoot, "hello.txt"),
      contents: "hello world",
    });

    const listing = await client.listDirectory({
      path: remoteRoot,
      includeHidden: true,
    });
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0].name, "hello.txt");

    const renamed = await client.rename({
      path: path.join(remoteRoot, "hello.txt"),
      nextName: "greetings.txt",
    });
    assert.equal(renamed.name, "greetings.txt");

    const copied = await client.copyPath({
      sourcePath: path.join(remoteRoot, "greetings.txt"),
      destinationPath: path.join(remoteRoot, "greetings-copy.txt"),
      overwrite: false,
    });
    assert.equal(copied.name, "greetings-copy.txt");

    const download = await client.createDownloadStream(path.join(remoteRoot, "greetings.txt"));
    assert.equal(await readStream(download.stream), "hello world");

    const trashResults = await client.trashPaths({
      paths: [path.join(remoteRoot, "greetings-copy.txt")],
    });
    assert.equal(trashResults[0].ok, true);
    const deletedItems = await client.listTrash();
    assert.equal(deletedItems[0].name, "greetings-copy.txt");
    await client.restoreTrashItem({ id: deletedItems[0].id });
    assert.equal(
      await fs.readFile(path.join(remoteRoot, "greetings-copy.txt"), "utf8"),
      "hello world",
    );

    const deleteResults = await client.deletePaths({
      paths: [path.join(remoteRoot, "greetings.txt")],
    });
    assert.equal(deleteResults[0].ok, true);
    await assert.rejects(
      client.listDirectory({ path: os.homedir() }),
      /locked to/,
    );
    await service.stop();
  });
});

test("ww service accepts peer desktop launch requests", async () => {
  await withTempDir(async (baseDir) => {
    let launchRequest = null;
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "launch-machine",
      token: "launch-token",
      name: "Launch Box",
      rootPath: baseDir,
      onLaunchDesktop: async (request) => {
        launchRequest = request;
        return {
          action: "focused",
        };
      },
    });

    const info = await service.start();
    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "launch-token",
    });

    const launchResult = await client.launchDesktop({
      requester: {
        machineId: "peer-machine-id",
        port: 5123,
        token: "peer-token",
        name: "Peer Box",
        rootPath: "/srv/requester",
      },
      localPath: path.join(baseDir, "linked-local"),
      remotePath: "/srv/requester/projects",
    });

    assert.deepEqual(launchResult, {
      action: "focused",
    });
    assert.equal(launchRequest.requester.machineId, "peer-machine-id");
    assert.equal(launchRequest.requester.port, 5123);
    assert.equal(launchRequest.requester.token, "peer-token");
    assert.equal(launchRequest.requester.name, "Peer Box");
    assert.equal(launchRequest.localPath, path.join(baseDir, "linked-local"));
    assert.equal(launchRequest.remotePath, "/srv/requester/projects");
    assert.equal(launchRequest.requesterHostHint, "127.0.0.1");
    assert.equal(launchRequest.service.capabilities.launchDesktop, true);

    await service.stop();
  });
});

test("ww service exposes LAN discovery without auth", async () => {
  await withTempDir(async (baseDir) => {
    const token = "discover-token";
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "discover-machine",
      token,
      name: "Discovery Box",
      rootPath: baseDir,
    });

    const info = await service.start();
    const response = await fetch(
      `http://127.0.0.1:${info.port}/v1/discover?protocolVersion=${WW_PROTOCOL_VERSION}&appVersion=${encodeURIComponent(WW_APP_VERSION)}`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.service.name, "Discovery Box");
    assert.equal(payload.service.host, "127.0.0.1");
    assert.equal(payload.service.port, info.port);
    assert.equal(payload.service.machineId, "discover-machine");
    assert.equal(payload.service.trustId, deriveWwTrustId(token));
    assert.equal(payload.service.versions.protocol, WW_PROTOCOL_VERSION);
    assert.equal(payload.service.versions.app, WW_APP_VERSION);
    assert.equal(payload.service.installerUrl, WW_LAN_INSTALLER_URL);
    assert.equal(payload.service.capabilities.launchDesktop, false);
    assert.equal(payload.compatibility.ok, true);
    assert.equal(Object.hasOwn(payload.service, "token"), false);
    assert.equal(Object.hasOwn(payload.service, "rootPath"), false);
    assert.equal(Object.hasOwn(payload.service, "cwd"), false);
    assert.equal(Object.hasOwn(payload.service, "homeDir"), false);

    await service.stop();
  });
});

test("ww discovery advertises the request-local reachable host", async () => {
  await withTempDir(async (baseDir) => {
    const service = createWwService({
      host: "0.0.0.0",
      port: 0,
      token: "discover-token",
      name: "Discovery Box",
      rootPath: baseDir,
    });

    const info = await service.start();
    const response = await fetch(
      `http://127.0.0.1:${info.port}/v1/discover?protocolVersion=${WW_PROTOCOL_VERSION}&appVersion=${encodeURIComponent(WW_APP_VERSION)}`,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.service.host, "127.0.0.1");

    await service.stop();
  });
});

test("ww service info keeps portal metadata behind auth without echoing secrets", async () => {
  await withTempDir(async (baseDir) => {
    const token = "info-token";
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "info-machine",
      token,
      name: "Info Box",
      rootPath: baseDir,
    });
    const info = await service.start();
    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token,
    });

    const remoteInfo = await client.getInfo();
    assert.equal(remoteInfo.name, "Info Box");
    assert.equal(remoteInfo.machineId, "info-machine");
    assert.equal(remoteInfo.rootPath, baseDir);
    assert.equal(remoteInfo.trustId, deriveWwTrustId(token));
    assert.equal(remoteInfo.versions.protocol, WW_PROTOCOL_VERSION);
    assert.equal(remoteInfo.versions.app, WW_APP_VERSION);
    assert.equal(remoteInfo.installerUrl, WW_LAN_INSTALLER_URL);
    assert.equal(Object.hasOwn(remoteInfo, "token"), false);
    assert.equal(Object.hasOwn(remoteInfo, "cwd"), false);
    assert.equal(Object.hasOwn(remoteInfo, "homeDir"), false);

    await service.stop();
  });
});

test("ww service exposes an authenticated permanent-update status", async () => {
  await withTempDir(async (baseDir) => {
    const updateBundlePath = path.join(baseDir, "ww-update.tar.gz");
    await fs.writeFile(updateBundlePath, "verified-update-bytes");
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "update-machine",
      token: "update-token",
      name: "Update Box",
      rootPath: baseDir,
      updateBundlePath,
      getMirrorStatus: () => ({
        role: "leader",
        instanceId: "0123456789abcdef",
        completedCycles: 7,
      }),
    });
    const info = await service.start();
    const unauthorized = await fetch(`http://127.0.0.1:${info.port}/v1/update-status`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedMirror = await fetch(`http://127.0.0.1:${info.port}/v1/mirror-status`);
    assert.equal(unauthorizedMirror.status, 401);

    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "update-token",
    });
    const updatePeer = await client.connectForUpdate();
    const status = await client.getUpdateStatus();
    const mirrorStatus = await client.getMirrorStatus();
    assert.equal(updatePeer.capabilities.updateProtocol, WW_UPDATE_PROTOCOL_VERSION);
    assert.equal(updatePeer.capabilities.downloadUpdate, true);
    assert.equal(status.protocol, WW_UPDATE_PROTOCOL_VERSION);
    assert.match(status.running.hash, /^[a-f0-9]{64}$/);
    assert.match(status.source.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(mirrorStatus, {
      role: "leader",
      instanceId: "0123456789abcdef",
      completedCycles: 7,
    });

    const bundleResponse = await fetch(`http://127.0.0.1:${info.port}/v1/update-bundle`, {
      headers: {
        authorization: "Bearer update-token",
      },
    });
    assert.equal(bundleResponse.status, 200);
    assert.equal(await bundleResponse.text(), "verified-update-bytes");

    await service.stop();
  });
});

test("ww local machine explorer browses outside the portal and imports selections into it", async () => {
  await withTempDir(async (baseDir) => {
    const machineFolder = path.join(baseDir, "machine-files");
    const localPortal = path.join(baseDir, "local-portal");
    const localPortalEnvironment = path.join(localPortal, "Portal");
    await fs.mkdir(path.join(machineFolder, "project"), { recursive: true });
    await fs.writeFile(path.join(machineFolder, "project", "notes.txt"), "from the machine");

    const localEndpoint = createLocalEndpoint({
      name: "Portal Receiver",
      rootPath: localPortal,
    });

    await assert.rejects(
      localEndpoint.listDirectory({ path: machineFolder }),
      /locked to/,
    );

    const listing = await localEndpoint.listDirectory({
      path: machineFolder,
      scope: "machine",
      includeHidden: true,
    });
    assert.equal(listing.scope, "machine");
    assert.deepEqual(listing.items.map((entry) => entry.name), ["project"]);

    const roots = await localEndpoint.listDirectory({
      path: WW_MACHINE_ROOT_PATH,
      scope: "machine",
    });
    assert.equal(roots.scope, "machine");
    if (process.platform === "win32") {
      assert.equal(roots.path, WW_MACHINE_ROOT_PATH);
      assert.ok(roots.items.some((entry) => entry.path === path.parse(os.homedir()).root));
    } else {
      assert.equal(roots.path, path.parse(os.homedir()).root);
    }

    const result = await transferSelections({
      sourceEndpoint: localEndpoint,
      destinationEndpoint: localEndpoint,
      sourcePaths: [path.join(machineFolder, "project")],
      destinationDir: localPortalEnvironment,
      sourceScope: "machine",
      conflictPolicy: "rename",
    });

    assert.equal(result.transferredFiles, 1);
    assert.equal(
      await fs.readFile(path.join(localPortalEnvironment, "project", "notes.txt"), "utf8"),
      "from the machine",
    );
    assert.equal(await fs.readFile(path.join(machineFolder, "project", "notes.txt"), "utf8"), "from the machine");

    await assert.rejects(
      transferSelections({
        sourceEndpoint: localEndpoint,
        destinationEndpoint: localEndpoint,
        sourcePaths: [path.join(machineFolder, "project")],
        destinationDir: localPortalEnvironment,
        sourceScope: "machine",
        move: true,
      }),
      /copy-only/,
    );
  });
});

test("ww service exposes whole-machine browsing only to its pinned peer", async () => {
  await withTempDir(async (baseDir) => {
    const machineFolder = path.join(baseDir, "machine-files");
    await fs.mkdir(machineFolder, { recursive: true });
    await fs.writeFile(path.join(machineFolder, "notes.txt"), "paired access\n");
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "service-machine",
      token: "paired-explorer-token",
      rootPath: path.join(baseDir, "portal"),
      getTrustedPeerMachineId: () => "paired-machine",
    });
    const info = await service.start();
    try {
      const pairedClient = createRemoteWwClient({
        host: "127.0.0.1",
        port: info.port,
        token: "paired-explorer-token",
        localMachineId: "paired-machine",
      });
      const listing = await pairedClient.listDirectory({
        path: machineFolder,
        scope: "machine",
      });
      assert.deepEqual(listing.items.map((item) => item.name), ["notes.txt"]);

      const unpinnedService = createWwService({
        host: "127.0.0.1",
        port: 0,
        token: "unpinned-explorer-token",
        rootPath: path.join(baseDir, "other-portal"),
      });
      const unpinnedInfo = await unpinnedService.start();
      const unpinnedClient = createRemoteWwClient({
        host: "127.0.0.1",
        port: unpinnedInfo.port,
        token: "unpinned-explorer-token",
        localMachineId: "unknown-machine",
      });
      await assert.rejects(
        unpinnedClient.listDirectory({ path: machineFolder, scope: "machine" }),
        /only to the pinned WorkWire peer/,
      );
      await unpinnedService.stop();
    } finally {
      await service.stop();
    }
  });
});

test("ww service rejects mismatched connect negotiation with LAN installer guidance", async () => {
  await withTempDir(async (baseDir) => {
    const token = "negotiate-token";
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      token,
      name: "Mismatch Box",
      rootPath: baseDir,
    });

    const info = await service.start();
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/connect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client: {
          versions: {
            protocol: WW_PROTOCOL_VERSION,
            app: "9.9.9",
          },
          installerUrl: WW_LAN_INSTALLER_URL,
        },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "ERR_WW_APP_VERSION_MISMATCH");
    assert.match(payload.error.message, /Install the same current WW build on both PCs/);
    assert.equal(payload.service.versions.app, WW_APP_VERSION);

    await service.stop();
  });
});

test("ww client treats older peers without connect negotiation as incompatible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/connect")) {
      return createJsonResponse(404, {
        ok: false,
        error: {
          code: "ERR_NOT_FOUND",
          message: "No WW route matches POST /v1/connect.",
        },
      });
    }
    if (url.endsWith("/v1/info")) {
      return createJsonResponse(200, {
        ok: true,
        service: {
          name: "Old WW Box",
        },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };

  try {
    const client = createRemoteWwClient({
      host: "192.168.8.104",
      port: 4851,
      token: "client-token",
    });

    await assert.rejects(
      client.connect(),
      /Install the same current WW build on both PCs/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ww client retries transient failures only for idempotent control calls", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/v1\/info$/u);
    attempts += 1;
    if (attempts === 1) {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNRESET" };
      throw error;
    }
    return createJsonResponse(200, {
      ok: true,
      service: { machineId: "retry-peer", versions: { protocol: WW_PROTOCOL_VERSION, app: WW_APP_VERSION } },
    });
  };

  try {
    const client = createRemoteWwClient({ host: "192.0.2.10", port: 4851, token: "retry-token" });
    const info = await client.getInfo({ timeoutMs: 1_000 });
    assert.equal(info.machineId, "retry-peer");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ww service pairs the first authenticated machine and rejects other pinned peers", async () => {
  await withTempDir(async (baseDir) => {
    let trustedPeerMachineId = "";
    const pairedMachineIds = [];
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      token: "pair-token",
      machineId: "desk-machine",
      name: "Pair Box",
      rootPath: baseDir,
      onPairPeer: async ({ machineId }) => {
        pairedMachineIds.push(machineId);
        trustedPeerMachineId ||= machineId;
      },
      getTrustedPeerMachineId: () => trustedPeerMachineId,
    });

    const info = await service.start();
    const pairedClient = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "pair-token",
      localMachineId: "peer-a",
    });
    const pingBeforeConnect = await pairedClient.ping();
    assert.equal(pingBeforeConnect.machineId, "desk-machine");
    assert.deepEqual(pairedMachineIds, []);

    const pairedInfo = await pairedClient.connect();

    assert.equal(pairedInfo.machineId, "desk-machine");
    assert.equal(trustedPeerMachineId, "peer-a");
    assert.deepEqual(pairedMachineIds, ["peer-a"]);

    const otherClient = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "pair-token",
      localMachineId: "peer-b",
    });

    await assert.rejects(
      otherClient.ping(),
      /paired WW peer/i,
    );

    const localDesktopClient = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "pair-token",
      localMachineId: "desk-machine",
      localService: true,
    });
    const localInfo = await localDesktopClient.getInfo();
    assert.equal(localInfo.machineId, "desk-machine");

    await service.stop();
  });
});

test("ww service recovers from a configured port collision by rebinding to an open port", async () => {
  await withTempDir(async (baseDir) => {
    const primary = createWwService({
      host: "127.0.0.1",
      port: 0,
      token: "primary-token",
      name: "Primary Box",
      rootPath: path.join(baseDir, "primary"),
    });
    const primaryInfo = await primary.start();

    const logs = [];
    const secondary = createWwService({
      host: "127.0.0.1",
      port: primaryInfo.port,
      token: "secondary-token",
      name: "Secondary Box",
      rootPath: path.join(baseDir, "secondary"),
      log: (line) => logs.push(line),
    });
    const secondaryInfo = await secondary.start();

    assert.notEqual(secondaryInfo.port, primaryInfo.port);
    assert.match(logs.join("\n"), /port \d+ stayed busy after \d+ retries; drifting to an open port/i);

    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: secondaryInfo.port,
      token: "secondary-token",
    });
    const pingInfo = await client.ping();
    assert.equal(pingInfo.name, "Secondary Box");

    await secondary.stop();
    await primary.stop();
  });
});

test("ww transfer engine copies folders, resolves conflicts, and supports move", async () => {
  await withTempDir(async (baseDir) => {
    const remoteRoot = path.join(baseDir, "remote");
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      token: "transfer-token",
      name: "Peer Box",
      rootPath: remoteRoot,
    });
    const info = await service.start();

    const localRoot = path.join(baseDir, "local");
    await fs.mkdir(path.join(localRoot, "nest"), { recursive: true });
    await fs.mkdir(remoteRoot, { recursive: true });
    await fs.writeFile(path.join(localRoot, "report.txt"), "local report", "utf8");
    await fs.writeFile(path.join(localRoot, "nest", "alpha.txt"), "nested alpha", "utf8");
    await fs.mkdir(path.join(localRoot, "nest", " spaced folder "), { recursive: true });
    await fs.writeFile(
      path.join(localRoot, "nest", " spaced folder ", " spaced file .txt"),
      "spacing preserved",
      "utf8",
    );
    await fs.writeFile(path.join(remoteRoot, "report.txt"), "existing remote", "utf8");

    const localEndpoint = createLocalEndpoint({ name: "This PC", rootPath: localRoot });
    const remoteEndpoint = createRemoteEndpoint({
      host: "127.0.0.1",
      port: info.port,
      token: "transfer-token",
      label: "Other PC",
    });

    const copyResult = await transferSelections({
      sourceEndpoint: localEndpoint,
      destinationEndpoint: remoteEndpoint,
      sourcePaths: [
        path.join(localRoot, "report.txt"),
        path.join(localRoot, "nest"),
      ],
      destinationDir: remoteRoot,
      conflictPolicy: "rename",
      move: false,
    });

    assert.equal(copyResult.transferredFiles, 3);
    assert.equal(await fs.readFile(path.join(remoteRoot, "report (copy).txt"), "utf8"), "local report");
    assert.equal(await fs.readFile(path.join(remoteRoot, "nest", "alpha.txt"), "utf8"), "nested alpha");
    assert.equal(
      await fs.readFile(
        path.join(remoteRoot, "nest", " spaced folder ", " spaced file .txt"),
        "utf8",
      ),
      "spacing preserved",
    );

    // Repeating a folder transfer must merge into the existing folder. In
    // particular, files removed from the destination are restored instead of
    // the entire source folder being skipped or placed in a sibling copy.
    await fs.rm(path.join(remoteRoot, "nest", "alpha.txt"));
    const repeatFolderResult = await transferSelections({
      sourceEndpoint: localEndpoint,
      destinationEndpoint: remoteEndpoint,
      sourcePaths: [path.join(localRoot, "nest")],
      destinationDir: remoteRoot,
      conflictPolicy: "rename",
    });
    assert.equal(repeatFolderResult.transferredFiles, 2);
    assert.equal(await fs.readFile(path.join(remoteRoot, "nest", "alpha.txt"), "utf8"), "nested alpha");
    await assert.rejects(fs.access(path.join(remoteRoot, "nest (copy)")));

    await fs.rm(path.join(remoteRoot, "nest", "alpha.txt"));
    const refillFolderResult = await transferSelections({
      sourceEndpoint: localEndpoint,
      destinationEndpoint: remoteEndpoint,
      sourcePaths: [path.join(localRoot, "nest")],
      destinationDir: remoteRoot,
      conflictPolicy: "skip",
    });
    assert.equal(refillFolderResult.transferredFiles, 1);
    assert.equal(refillFolderResult.skippedFiles, 1);
    assert.equal(await fs.readFile(path.join(remoteRoot, "nest", "alpha.txt"), "utf8"), "nested alpha");

    const skipStages = [];
    const skipResult = await transferSelections({
      sourceEndpoint: localEndpoint,
      destinationEndpoint: remoteEndpoint,
      sourcePaths: [path.join(localRoot, "report.txt")],
      destinationDir: remoteRoot,
      conflictPolicy: "skip",
      move: false,
      onProgress(event) { skipStages.push(event.stage); },
    });
    assert.equal(skipResult.transferredFiles, 0);
    assert.equal(skipResult.transferredBytes, 0);
    assert.equal(skipResult.skippedFiles, 1);
    assert.equal(skipResult.processedFiles, 1);
    assert.equal(skipResult.processedBytes, skipResult.totals.bytes);
    assert.ok(skipStages.includes("skip"));

    await fs.writeFile(path.join(localRoot, "move-me.txt"), "move me", "utf8");
    const moveResult = await transferSelections({
      sourceEndpoint: localEndpoint,
      destinationEndpoint: remoteEndpoint,
      sourcePaths: [path.join(localRoot, "move-me.txt")],
      destinationDir: remoteRoot,
      conflictPolicy: "overwrite",
      move: true,
    });

    assert.equal(moveResult.items[0].deletedSource, true);
    await assert.rejects(fs.access(path.join(localRoot, "move-me.txt")));
    assert.equal(await fs.readFile(path.join(remoteRoot, "move-me.txt"), "utf8"), "move me");

    await service.stop();
  });
});

test("ww folder transfers skip symbolic links without failing or losing a moved source", async (context) => {
  await withTempDir(async (baseDir) => {
    const sourceRoot = path.join(baseDir, "source");
    const destinationRoot = path.join(baseDir, "destination");
    const sourceFolder = path.join(sourceRoot, "favicons");
    await fs.mkdir(sourceFolder, { recursive: true });
    await fs.mkdir(destinationRoot, { recursive: true });
    await fs.writeFile(path.join(sourceFolder, "favicon.png"), "image bytes");
    try {
      await fs.symlink("favicon.png", path.join(sourceFolder, "current-favicon"));
      await fs.symlink(sourceFolder, path.join(sourceRoot, "favicons-link"), "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    const sourceEndpoint = createLocalEndpoint({ name: "Source", rootPath: sourceRoot });
    const destinationEndpoint = createLocalEndpoint({ name: "Destination", rootPath: destinationRoot });
    const folderResult = await transferSelections({
      sourceEndpoint,
      destinationEndpoint,
      sourcePaths: [sourceFolder],
      destinationDir: destinationRoot,
      conflictPolicy: "rename",
      move: true,
    });

    assert.equal(folderResult.transferredFiles, 1);
    assert.equal(folderResult.skippedLinks, 1);
    assert.equal(folderResult.totals.skippedLinks, 1);
    assert.equal(folderResult.items[0].deletedSource, false);
    assert.match(folderResult.items[0].message, /1 symbolic link was skipped/);
    assert.equal(
      await fs.readFile(path.join(destinationRoot, "favicons", "favicon.png"), "utf8"),
      "image bytes",
    );
    assert.equal((await fs.lstat(sourceFolder)).isDirectory(), true);
    await assert.rejects(fs.lstat(path.join(destinationRoot, "favicons", "current-favicon")));

    const linkResult = await transferSelections({
      sourceEndpoint,
      destinationEndpoint,
      sourcePaths: [path.join(sourceRoot, "favicons-link")],
      destinationDir: destinationRoot,
    });
    assert.equal(linkResult.transferredFiles, 0);
    assert.equal(linkResult.skippedLinks, 1);
    assert.equal(linkResult.items[0].skipped, true);
    assert.match(linkResult.items[0].message, /skipped for safety/);
  });
});

test("ww move reports a source-delete failure without losing the copied destination", async () => {
  await withTempDir(async (baseDir) => {
    const sourceRoot = path.join(baseDir, "source");
    const destinationRoot = path.join(baseDir, "destination");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(destinationRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "keep-source.txt");
    await fs.writeFile(sourcePath, "important\n", "utf8");

    const sourceEndpoint = createLocalEndpoint({
      name: "Source",
      rootPath: sourceRoot,
    });
    const destinationEndpoint = createLocalEndpoint({
      name: "Destination",
      rootPath: destinationRoot,
    });
    const failingSourceEndpoint = {
      ...sourceEndpoint,
      async deletePaths() {
        return [{
          path: sourcePath,
          ok: false,
          error: {
            code: "EACCES",
            message: "source is read-only",
          },
        }];
      },
    };

    await assert.rejects(
      transferSelections({
        sourceEndpoint: failingSourceEndpoint,
        destinationEndpoint,
        sourcePaths: [sourcePath],
        destinationDir: destinationRoot,
        conflictPolicy: "overwrite",
        move: true,
      }),
      /source is read-only/,
    );
    assert.equal(await fs.readFile(sourcePath, "utf8"), "important\n");
    assert.equal(
      await fs.readFile(path.join(destinationRoot, "keep-source.txt"), "utf8"),
      "important\n",
    );
  });
});

test("ww overwrite keeps the old destination when the incoming stream fails", async () => {
  await withTempDir(async (baseDir) => {
    const sourceRoot = path.join(baseDir, "source");
    const destinationRoot = path.join(baseDir, "destination");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(destinationRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "report.txt");
    const destinationPath = path.join(destinationRoot, "report.txt");
    await fs.writeFile(sourcePath, "new contents\n", "utf8");
    await fs.writeFile(destinationPath, "old contents\n", "utf8");

    const sourceEndpoint = createLocalEndpoint({
      name: "Source",
      rootPath: sourceRoot,
    });
    const brokenSourceEndpoint = {
      ...sourceEndpoint,
      async createDownloadStream() {
        return {
          stream: new Readable({
            read() {
              this.push("partial");
              this.destroy(new Error("simulated network failure"));
            },
          }),
          mtimeMs: Date.now(),
          name: "report.txt",
        };
      },
    };
    const destinationEndpoint = createLocalEndpoint({
      name: "Destination",
      rootPath: destinationRoot,
    });

    await assert.rejects(
      transferSelections({
        sourceEndpoint: brokenSourceEndpoint,
        destinationEndpoint,
        sourcePaths: [sourcePath],
        destinationDir: destinationRoot,
        conflictPolicy: "overwrite",
      }),
      /simulated network failure/,
    );
    assert.equal(await fs.readFile(destinationPath, "utf8"), "old contents\n");
  });
});

test("ww remote upload honors slow-receiver backpressure without buffering the file", async () => {
  const totalBytes = 24 * 1024 * 1024;
  const chunkBytes = 64 * 1024;
  let producedBytes = 0;
  let receivedBytes = 0;
  let maximumLeadBytes = 0;
  const updateLead = () => {
    maximumLeadBytes = Math.max(maximumLeadBytes, producedBytes - receivedBytes);
  };
  const server = http.createServer((request, response) => {
    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      updateLead();
      request.pause();
      setTimeout(() => request.resume(), 1);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        record: { path: "/slow.bin", name: "slow.bin", kind: "file", size: receivedBytes },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: server.address().port,
      token: "backpressure-test",
    });
    const source = new Readable({
      read() {
        if (producedBytes >= totalBytes) {
          this.push(null);
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - producedBytes);
        producedBytes += size;
        updateLead();
        this.push(Buffer.alloc(size, producedBytes & 0xff));
      },
    });
    const record = await client.uploadFileStream("/slow.bin", source, { timeoutMs: 30_000 });
    assert.equal(record.size, totalBytes);
    assert.equal(producedBytes, totalBytes);
    assert.equal(receivedBytes, totalBytes);
    assert.ok(
      maximumLeadBytes < 12 * 1024 * 1024,
      `producer advanced ${maximumLeadBytes} bytes beyond the slow receiver`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ww aborts a large download cleanly and keeps control requests responsive", async () => {
  await withTempDir(async (baseDir) => {
    const targetPath = path.join(baseDir, "abort-download.bin");
    const handle = await fs.open(targetPath, "w");
    await handle.truncate(16 * 1024 * 1024);
    await handle.close();
    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      token: "abort-token",
      rootPath: baseDir,
      recoverPortCollision: false,
    });
    const info = await service.start();
    try {
      const client = createRemoteWwClient({
        host: "127.0.0.1",
        port: info.port,
        token: "abort-token",
      });
      const download = await client.createDownloadStream(targetPath);
      download.stream.once("error", () => {});
      download.stream.once("data", () => download.stream.destroy());
      await once(download.stream, "close");
      const startedAt = process.hrtime.bigint();
      await client.ping({ timeoutMs: 2_000 });
      const pingMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      assert.ok(pingMs < 1_000, `ping after aborted download took ${pingMs.toFixed(1)} ms`);
    } finally {
      await service.stop();
    }
  });
});

test("ww transfer coalesces tiny-chunk progress while preserving exact output", async () => {
  await withTempDir(async (baseDir) => {
    const destinationRoot = path.join(baseDir, "destination");
    await fs.mkdir(destinationRoot);
    const totalBytes = 2 * 1024 * 1024;
    const chunkBytes = 4 * 1024;
    const sourcePath = "/synthetic/tiny-chunks.bin";
    const sourceEndpoint = {
      async getInfo() {
        return { name: "tiny chunks", platform: process.platform };
      },
      async buildManifest() {
        return {
          root: { path: sourcePath, name: "tiny-chunks.bin", kind: "file", size: totalBytes, mtimeMs: 1_700_000_000_000 },
          directories: [],
          files: [],
          totals: { files: 1, directories: 0, bytes: totalBytes },
        };
      },
      async createDownloadStream() {
        async function* chunks() {
          for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            yield Buffer.alloc(Math.min(chunkBytes, totalBytes - offset), offset & 0xff);
          }
        }
        return { stream: Readable.from(chunks()), mtimeMs: 1_700_000_000_000, name: "tiny-chunks.bin" };
      },
    };
    const events = [];
    const transferStartedAt = Date.now();
    const result = await transferSelections({
      sourceEndpoint,
      destinationEndpoint: createLocalEndpoint({ name: "destination", rootPath: destinationRoot }),
      sourcePaths: [sourcePath],
      destinationDir: destinationRoot,
      conflictPolicy: "overwrite",
      onProgress(event) {
        const bytesInFlight = Number(event.bytesInFlight) || 0;
        events.push({
          stage: event.stage,
          liveTransferredBytes: (Number(event.result?.transferredBytes) || 0) + bytesInFlight,
          liveProcessedBytes: (Number(event.result?.processedBytes) || 0) + bytesInFlight,
        });
      },
    });
    const stages = events.map((event) => event.stage);
    const progressEvents = stages.filter((stage) => stage === "transfer-progress").length;
    assert.equal(result.transferredBytes, totalBytes);
    assert.equal(result.processedBytes, totalBytes);
    assert.equal(result.processedFiles, 1);
    assert.equal((await fs.stat(path.join(destinationRoot, "tiny-chunks.bin"))).size, totalBytes);
    assert.ok(progressEvents >= 2, `expected periodic progress, got ${progressEvents}`);
    const transferDurationMs = Date.now() - transferStartedAt;
    const maximumProgressEvents = Math.ceil(transferDurationMs / 80) + 2;
    assert.ok(progressEvents <= maximumProgressEvents, `progress event flood: ${progressEvents} in ${transferDurationMs}ms`);
    assert.ok(events.some((event) => (
      event.stage === "transfer-progress"
      && event.liveTransferredBytes > 0
      && event.liveTransferredBytes < totalBytes
    )), "expected real in-flight byte telemetry before the file completed");
    assert.ok(events.every((event, index) => (
      index === 0 || event.liveProcessedBytes >= events[index - 1].liveProcessedBytes
    )), "expected reported progress to be monotonic");
    assert.equal(stages.at(-1), "complete");
  });
});
