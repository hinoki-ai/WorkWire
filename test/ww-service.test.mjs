import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  WW_APP_VERSION,
  WW_LAN_INSTALLER_URL,
  WW_PROTOCOL_VERSION,
} from "../lib/ww-compat.mjs";
import { deriveWwTrustId } from "../lib/ww-config-store.mjs";
import { createWwService } from "../lib/ww-service.mjs";
import { createRemoteWwClient } from "../lib/ww-client.mjs";
import { createLocalEndpoint, createRemoteEndpoint } from "../lib/ww-endpoint.mjs";
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
    assert.match(logs.join("\n"), /port \d+ is busy; retrying on an open port/i);

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
