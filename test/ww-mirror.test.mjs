import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildMirrorConflictPath,
  createWwMirror,
  isMirrorLeader,
  planMirrorActions,
  scanLocalMirrorTree,
} from "../lib/ww-mirror.mjs";
import { createWwService } from "../lib/ww-service.mjs";
import { createRemoteWwClient } from "../lib/ww-client.mjs";

function record(kind, size = 0, mtimeMs = 0) {
  return { kind, size, mtimeMs };
}

async function withTempDir(run) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-mirror-"));
  try {
    return await run(baseDir);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

test("ww mirror scans only canonical user content", async (context) => {
  await withTempDir(async (rootPath) => {
    await fs.mkdir(path.join(rootPath, "docs"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "docs", "kept.txt"), "kept\n");
    await fs.writeFile(path.join(rootPath, "docs", ".ww-upload-1-partial.tmp"), "partial");
    for (const internalName of [".workwire", ".codex", ".git", "dist", "link", "node_modules", "runtime"]) {
      await fs.mkdir(path.join(rootPath, internalName), { recursive: true });
      await fs.writeFile(path.join(rootPath, internalName, "ignored.txt"), "ignored\n");
    }
    try {
      await fs.symlink(path.join(rootPath, "docs", "kept.txt"), path.join(rootPath, "shortcut"));
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    const records = await scanLocalMirrorTree(rootPath);
    assert.deepEqual([...records.keys()], ["docs", "docs/kept.txt"]);
  });
});

test("ww mirror plans deterministic copies, deletions, and conflicts", () => {
  const fresh = planMirrorActions({
    local: new Map([["new.txt", record("file", 3, 10)]]),
    remote: new Map(),
  });
  assert.deepEqual(fresh, [{
    type: "copy",
    from: "local",
    path: "new.txt",
    record: record("file", 3, 10),
  }]);

  const deleted = planMirrorActions({
    local: new Map([["gone.txt", record("file", 3, 10)]]),
    remote: new Map(),
    previousLocal: new Map([["gone.txt", record("file", 3, 10)]]),
    previousRemote: new Map([["gone.txt", record("file", 3, 10)]]),
  });
  assert.deepEqual(deleted, [{ type: "delete", path: "gone.txt" }]);

  const conflict = planMirrorActions({
    local: new Map([["shared.txt", record("file", 5, 20)]]),
    remote: new Map([["shared.txt", record("file", 6, 30)]]),
    previousLocal: new Map([["shared.txt", record("file", 4, 10)]]),
    previousRemote: new Map([["shared.txt", record("file", 4, 10)]]),
    machineId: "machine-a",
    peerMachineId: "machine-b",
  });
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].from, "remote");
  assert.equal(conflict[0].conflict, true);
  assert.equal(conflict[0].record.mtimeMs, 30);
});

test("ww mirror elects one stable leader and creates deterministic conflict names", () => {
  assert.equal(isMirrorLeader("a-machine", "b-machine"), true);
  assert.equal(isMirrorLeader("b-machine", "a-machine"), false);
  assert.equal(isMirrorLeader("", "b-machine"), true);
  assert.equal(
    buildMirrorConflictPath("docs/report.txt", "b-machine", record("file", 5, 1234)),
    buildMirrorConflictPath("docs/report.txt", "b-machine", record("file", 5, 1234)),
  );
  assert.match(
    buildMirrorConflictPath("docs/report.txt", "b-machine", record("file", 5, 1234)),
    /^docs\/report \(WW conflict [a-f0-9]{8}-1234\)\.txt$/,
  );
});

test("ww mirror follows a refreshed peer route and preserves simultaneous edits", async () => {
  await withTempDir(async (baseDir) => {
    const localRoot = path.join(baseDir, "local");
    const remoteRoot = path.join(baseDir, "remote");
    const statePath = path.join(baseDir, "state", "mirror.json");
    await fs.mkdir(localRoot, { recursive: true });
    await fs.mkdir(remoteRoot, { recursive: true });
    await fs.writeFile(path.join(localRoot, "shared.txt"), "initial\n");

    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "b-machine",
      token: "mirror-token",
      name: "Mirror Peer",
      rootPath: remoteRoot,
    });
    const serviceInfo = await service.start();
    let activePeer = {
      host: "127.0.0.1",
      port: 1,
      machineId: "b-machine",
      token: "mirror-token",
    };
    const mirror = createWwMirror({
      rootPath: localRoot,
      statePath,
      peer: activePeer,
      getPeer: () => activePeer,
      machineId: "a-machine",
      expectedRemoteRootPath: remoteRoot,
      intervalMs: 60_000,
    });

    try {
      await mirror.syncNow();
      assert.match(mirror.getStatus().error, /fetch failed|connect/i);

      activePeer = {
        ...activePeer,
        port: serviceInfo.port,
      };
      await mirror.syncNow();
      assert.equal(await fs.readFile(path.join(remoteRoot, "shared.txt"), "utf8"), "initial\n");
      assert.equal(mirror.getStatus().connected, true);
      assert.equal(mirror.getStatus().role, "leader");

      const baseTime = Date.now() + 5_000;
      await fs.writeFile(path.join(localRoot, "shared.txt"), "local winner\n");
      await fs.utimes(path.join(localRoot, "shared.txt"), baseTime / 1_000, (baseTime + 2_000) / 1_000);
      await fs.writeFile(path.join(remoteRoot, "shared.txt"), "remote preserved\n");
      await fs.utimes(path.join(remoteRoot, "shared.txt"), baseTime / 1_000, (baseTime + 1_000) / 1_000);
      const remoteRecord = await fs.stat(path.join(remoteRoot, "shared.txt"));
      const conflictRelativePath = buildMirrorConflictPath(
        "shared.txt",
        "b-machine",
        record("file", remoteRecord.size, remoteRecord.mtimeMs),
      );

      await mirror.syncNow();
      assert.equal(await fs.readFile(path.join(localRoot, "shared.txt"), "utf8"), "local winner\n");
      assert.equal(await fs.readFile(path.join(remoteRoot, "shared.txt"), "utf8"), "local winner\n");
      assert.equal(await fs.readFile(path.join(remoteRoot, conflictRelativePath), "utf8"), "remote preserved\n");

      await mirror.syncNow();
      assert.equal(await fs.readFile(path.join(localRoot, conflictRelativePath), "utf8"), "remote preserved\n");

      await fs.rm(path.join(localRoot, "shared.txt"));
      await mirror.syncNow();
      await assert.rejects(fs.access(path.join(remoteRoot, "shared.txt")));

      assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    } finally {
      await mirror.stop();
      await service.stop();
    }
  });
});

test("ww mirror keeps the permanent update channel alive across app-version mismatch", async () => {
  await withTempDir(async (baseDir) => {
    const localRoot = path.join(baseDir, "local");
    const remoteRoot = path.join(baseDir, "remote");
    await fs.mkdir(localRoot, { recursive: true });
    await fs.mkdir(remoteRoot, { recursive: true });
    await fs.writeFile(path.join(localRoot, "new-runtime.mjs"), "export const updated = true;\n");

    const service = createWwService({
      host: "127.0.0.1",
      port: 0,
      machineId: "b-machine",
      token: "update-token",
      name: "Older App Peer",
      rootPath: remoteRoot,
    });
    const serviceInfo = await service.start();
    let strictConnectCalled = false;
    const mirror = createWwMirror({
      rootPath: localRoot,
      statePath: path.join(baseDir, "state", "mirror.json"),
      peer: {
        host: "127.0.0.1",
        port: serviceInfo.port,
        machineId: "b-machine",
        token: "update-token",
      },
      machineId: "a-machine",
      expectedRemoteRootPath: remoteRoot,
      intervalMs: 60_000,
      clientFactory(peer) {
        const client = createRemoteWwClient(peer);
        return {
          ...client,
          async connect() {
            strictConnectCalled = true;
            throw new Error("The desktop app versions differ.");
          },
        };
      },
    });

    try {
      await mirror.syncNow();
      assert.equal(strictConnectCalled, false);
      assert.equal(
        await fs.readFile(path.join(remoteRoot, "new-runtime.mjs"), "utf8"),
        "export const updated = true;\n",
      );
      assert.equal(mirror.getStatus().connected, true);
    } finally {
      await mirror.stop();
      await service.stop();
    }
  });
});
