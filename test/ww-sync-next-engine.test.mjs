import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileSyncPolicy,
  createWorkWireSyncEngine,
  getSyncCapabilities,
  WW_SYNC_ENGINE_VERSION,
} from "../lib/sync/index.mjs";

async function temporaryRoots(t, names) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ww-sync-next-"));
  const roots = Object.fromEntries(names.map((name) => [name, path.join(base, name)]));
  await Promise.all(Object.values(roots).map((root) => fs.mkdir(root, { recursive: true })));
  return { base, cleanup: () => fs.rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 }), ...roots };
}

async function createEngine(t, base, root, peerRoots, folder = {}) {
  const engine = createWorkWireSyncEngine({ machineId: folder.machineId || "machine-a", stateDir: path.join(base, folder.stateName || "state") });
  await engine.init();
  t.after(() => engine.close());
  for (const [id, peerRoot] of Object.entries(peerRoots)) await engine.addPeer({ id, rootPath: peerRoot });
  await engine.addFolder({
    id: folder.id || "folder",
    rootPath: root,
    peers: Object.keys(peerRoots),
    chunkSize: 64 * 1024,
    largeFileThreshold: 0,
    concurrency: 1,
    ...folder,
  });
  return engine;
}

test("sync policy handles comments, directory rules, negation, and explanations", () => {
  const policy = compileSyncPolicy({ rules: ["# comment", "build/", "!build/keep.txt", "*.tmp", "\\#literal"] });
  assert.equal(policy.test("readme.md"), true);
  assert.equal(policy.test("build/output.bin"), false);
  assert.equal(policy.test("build/keep.txt"), true);
  assert.equal(policy.test("cache.tmp"), false);
  assert.match(policy.explain("cache.tmp").reason, /excluded by rule/);
  assert.equal(getSyncCapabilities().engineVersion, WW_SYNC_ENGINE_VERSION);
});

test("same-size same-mtime changes use delta chunks and exact byte counters", async (t) => {
  const roots = await temporaryRoots(t, ["left", "right"]);
  const source = Buffer.alloc(256 * 1024, 0x31);
  await fs.writeFile(path.join(roots.left, "large.bin"), source);
  const engine = await createEngine(t, roots.base, roots.left, { right: roots.right });
  t.after(roots.cleanup);
  await engine.sync("folder");
  const originalStats = await fs.stat(path.join(roots.left, "large.bin"));
  source.fill(0x72, 64 * 1024, 128 * 1024);
  await fs.writeFile(path.join(roots.left, "large.bin"), source);
  await fs.utimes(path.join(roots.left, "large.bin"), originalStats.atime, originalStats.mtime);
  const result = await engine.sync("folder");
  assert.equal(result.transferredBytes, 64 * 1024);
  assert.equal(result.reusedBytes, 192 * 1024);
  assert.deepEqual(await fs.readFile(path.join(roots.right, "large.bin")), source);
});

test("interrupted transfer resumes by verified chunks and leaves old destination intact", async (t) => {
  const roots = await temporaryRoots(t, ["left", "right"]);
  const target = path.join(roots.right, "image.bin");
  await fs.writeFile(path.join(roots.left, "image.bin"), Buffer.alloc(320 * 1024, 0x11));
  let engine = await createEngine(t, roots.base, roots.left, { right: roots.right }, { stateName: "resume-state" });
  t.after(roots.cleanup);
  await engine.sync("folder");
  const oldDestination = await fs.readFile(target);
  const next = Buffer.alloc(320 * 1024, 0x88);
  await fs.writeFile(path.join(roots.left, "image.bin"), next);
  const controller = new AbortController();
  await assert.rejects(engine.sync("folder", {
    signal: controller.signal,
    onProgress(progress) {
      if (progress.stage === "transfer-progress" && progress.processedBytes >= 64 * 1024) controller.abort();
    },
  }), { name: "AbortError" });
  assert.deepEqual(await fs.readFile(target), oldDestination);
  await engine.close();

  engine = createWorkWireSyncEngine({ machineId: "machine-a", stateDir: path.join(roots.base, "resume-state") });
  await engine.init();
  const result = await engine.sync("folder");
  assert.ok(result.transferredBytes < next.length);
  assert.deepEqual(await fs.readFile(target), next);
  await engine.close();
});

test("send-only, receive-only, archive-only, rules, symlinks, pause, priority, and bandwidth are active", async (t) => {
  const roots = await temporaryRoots(t, ["send", "sendPeer", "receive", "receivePeer", "archive", "archivePeer"]);
  await fs.writeFile(path.join(roots.send, "send.txt"), "source");
  await fs.writeFile(path.join(roots.send, "ignored.tmp"), "ignore");
  await fs.symlink("send.txt", path.join(roots.send, "link.txt"));
  await fs.writeFile(path.join(roots.sendPeer, "send.txt"), "peer");
  const send = await createEngine(t, roots.base, roots.send, { sendPeer: roots.sendPeer }, {
    id: "send-folder", stateName: "send-state", mode: "send-only", rules: ["*.tmp"], symlinkPolicy: "preserve-link",
  });
  await send.sync("send-folder");
  assert.equal(await fs.readFile(path.join(roots.sendPeer, "send.txt"), "utf8"), "source");
  await assert.rejects(fs.stat(path.join(roots.sendPeer, "ignored.tmp")), { code: "ENOENT" });
  assert.equal(await fs.readlink(path.join(roots.sendPeer, "link.txt")), "send.txt");

  await fs.writeFile(path.join(roots.receive, "pull.txt"), "old");
  await fs.writeFile(path.join(roots.receivePeer, "pull.txt"), "remote");
  const receive = await createEngine(t, roots.base, roots.receive, { receivePeer: roots.receivePeer }, {
    id: "receive-folder", stateName: "receive-state", mode: "receive-only",
  });
  await receive.sync("receive-folder");
  assert.equal(await fs.readFile(path.join(roots.receive, "pull.txt"), "utf8"), "remote");

  await fs.writeFile(path.join(roots.archivePeer, "kept.txt"), "archive me");
  const archive = await createEngine(t, roots.base, roots.archive, { archivePeer: roots.archivePeer }, {
    id: "archive-folder", stateName: "archive-state", mode: "archive-only",
  });
  t.after(roots.cleanup);
  await archive.sync("archive-folder");
  await fs.rm(path.join(roots.archivePeer, "kept.txt"));
  await archive.sync("archive-folder");
  assert.equal(await fs.readFile(path.join(roots.archive, "kept.txt"), "utf8"), "archive me");

  const fast = Buffer.alloc(128 * 1024, 0x43);
  await fs.writeFile(path.join(roots.send, "z-low.bin"), fast);
  await fs.writeFile(path.join(roots.send, "a-high.bin"), fast);
  await send.updateFolder("send-folder", { priority: ["z-low.bin"], bandwidthLimit: 256 * 1024 });
  let firstPath = "";
  let paused = false;
  const startedAt = Date.now();
  await send.sync("send-folder", {
    onProgress(progress) {
      if (!firstPath && progress.stage === "transfer-progress") firstPath = progress.path;
      if (!paused && progress.stage === "transfer-progress") {
        paused = true;
        void send.pause("send-folder").then(() => setTimeout(() => void send.resume("send-folder"), 100));
      }
    },
  });
  assert.equal(firstPath, "z-low.bin");
  assert.ok(Date.now() - startedAt >= 450, "bandwidth limiter and pause should delay transfer");
});

test("versions restore overwritten and deleted bytes; simultaneous edits create resolvable conflicts", async (t) => {
  const roots = await temporaryRoots(t, ["left", "right"]);
  await fs.writeFile(path.join(roots.left, "record.txt"), "base");
  await fs.writeFile(path.join(roots.right, "record.txt"), "base");
  const engine = await createEngine(t, roots.base, roots.left, { right: roots.right }, { mode: "receive-only" });
  await engine.sync("folder");
  await fs.writeFile(path.join(roots.right, "record.txt"), "new remote");
  await engine.sync("folder");
  const overwritten = engine.getVersions("record.txt", { folderId: "folder" }).find((version) => version.size === 4);
  assert.ok(overwritten);
  const restoredOld = path.join(roots.base, "restored-old.txt");
  await engine.restoreVersion(overwritten.id, restoredOld);
  assert.equal(await fs.readFile(restoredOld, "utf8"), "base");
  await fs.rm(path.join(roots.right, "record.txt"));
  await engine.sync("folder");
  const deleted = engine.getVersions("record.txt", { folderId: "folder" }).find((version) => version.size === 10);
  assert.ok(deleted);
  await engine.restoreVersion(deleted.id);
  assert.equal(await fs.readFile(path.join(roots.left, "record.txt"), "utf8"), "new remote");

  const conflictRoots = await temporaryRoots(t, ["conflictLeft", "conflictRight"]);
  await fs.writeFile(path.join(conflictRoots.conflictLeft, "same.txt"), "base");
  await fs.writeFile(path.join(conflictRoots.conflictRight, "same.txt"), "base");
  const conflicts = await createEngine(t, conflictRoots.base, conflictRoots.conflictLeft, { conflictRight: conflictRoots.conflictRight }, { stateName: "conflict-state" });
  t.after(roots.cleanup);
  t.after(conflictRoots.cleanup);
  await conflicts.sync("folder");
  await fs.writeFile(path.join(conflictRoots.conflictLeft, "same.txt"), "left");
  await fs.writeFile(path.join(conflictRoots.conflictRight, "same.txt"), "right");
  const conflictResult = await conflicts.sync("folder");
  assert.equal(conflictResult.conflicts, 1);
  const [conflict] = conflicts.getConflicts("folder", { state: "unresolved" });
  assert.equal(conflict.left.entry.hash === conflict.right.entry.hash, false);
  await conflicts.resolveConflict(conflict.id, "keep-right");
  assert.equal(await fs.readFile(path.join(conflictRoots.conflictLeft, "same.txt"), "utf8"), "right");
});
