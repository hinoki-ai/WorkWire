import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { createRecoveryVault } from "../lib/continuity/index.mjs";

async function temporaryRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function objectFilename(vaultRoot, hash) {
  const value = hash.replace(/^sha256:/, "");
  return path.join(vaultRoot, "objects", "sha256", value.slice(0, 2), value.slice(2));
}

test("chunk-addressed snapshots deduplicate changed files and restore full trees, subtrees, and one file", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-vault-");
  const source = path.join(root, "source");
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  const common = Buffer.alloc(16 * 1024, 0x71);
  const firstBytes = Buffer.concat([common, Buffer.alloc(16 * 1024, 0x11), common]);
  const secondBytes = Buffer.concat([common, Buffer.alloc(16 * 1024, 0x22), common]);
  await fs.writeFile(path.join(source, "disk.img"), firstBytes);
  await fs.writeFile(path.join(source, "nested", "note.txt"), "continuity\n");

  const vault = createRecoveryVault({ root: vaultRoot, chunkSize: 16 * 1024 });
  await vault.init();
  const first = await vault.snapshotPaths([source], { label: "first" });
  await fs.writeFile(path.join(source, "disk.img"), secondBytes);
  const second = await vault.snapshotPaths([source], { label: "second" });
  const stats = await vault.getStats();
  assert.equal(stats.objectCount, 4); // common, two changed chunks, and note.txt
  assert.ok(stats.dedupRatio > 1.9);
  const difference = vault.diffSnapshots(first.id, second.id);
  assert.equal(difference.changed.find((item) => item.path === "source/disk.img").contentChanged, true);

  const fullDestination = path.join(root, "full");
  await vault.restoreSnapshot(second.id, fullDestination);
  assert.equal(digest(await fs.readFile(path.join(fullDestination, "source", "disk.img"))), digest(secondBytes));
  assert.equal(await fs.readFile(path.join(fullDestination, "source", "nested", "note.txt"), "utf8"), "continuity\n");

  const subtreeDestination = path.join(root, "subtree");
  await vault.restoreSnapshot(second.id, subtreeDestination, { subtree: "source/nested" });
  assert.equal(await fs.readFile(path.join(subtreeDestination, "source", "nested", "note.txt"), "utf8"), "continuity\n");

  const oneFile = path.join(root, "one-file.img");
  await vault.restoreSnapshot(second.id, oneFile, { path: "source/disk.img", asFile: true });
  assert.equal(digest(await fs.readFile(oneFile)), digest(secondBytes));
  await vault.close();
});

test("interrupted large ingest and restore resume from durable exact chunk offsets", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-resume-");
  const vaultRoot = path.join(root, "vault");
  const source = path.join(root, "large.bin");
  const chunks = Array.from({ length: 8 }, (_, index) => Buffer.alloc(8 * 1024, index + 1));
  const bytes = Buffer.concat(chunks);
  await fs.writeFile(source, bytes);
  const vault = createRecoveryVault({ root: vaultRoot, chunkSize: 8 * 1024 });
  await vault.init();

  let ingestError;
  await assert.rejects(
    vault.snapshotPaths([source], { failAfterBytes: 3 * 8 * 1024 }),
    (error) => { ingestError = error; return error.code === "ERR_WW_VAULT_INTERRUPTED"; },
  );
  assert.equal(ingestError.resumeOffset, 3 * 8 * 1024);
  assert.equal((await vault.getStats()).incompleteOperations, 1);
  const resumedProgress = [];
  const snapshot = await vault.snapshotPaths([source], { operationId: ingestError.operationId, onProgress: (item) => resumedProgress.push(item) });
  assert.equal(resumedProgress[0].resumedFrom, 3 * 8 * 1024);
  assert.equal((await vault.getStats()).incompleteOperations, 0);

  const destination = path.join(root, "restored.bin");
  let restoreError;
  await assert.rejects(
    vault.restoreSnapshot(snapshot.id, destination, { path: "large.bin", asFile: true, failAfterBytes: 2 * 8 * 1024 }),
    (error) => { restoreError = error; return error.code === "ERR_WW_VAULT_INTERRUPTED"; },
  );
  assert.equal(restoreError.resumeOffset, 2 * 8 * 1024);
  const restored = await vault.restoreSnapshot(snapshot.id, destination, { path: "large.bin", asFile: true });
  assert.ok(restored.resumedFrom >= 2 * 8 * 1024);
  assert.equal(digest(await fs.readFile(destination)), digest(bytes));
  assert.equal((await vault.getStats()).incompleteOperations, 0);
  await vault.close();
});

test("arbitrary stream images resume and stream restore reproduces exact bytes", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-stream-");
  const vault = createRecoveryVault({ root: path.join(root, "vault"), chunkSize: 4096 });
  await vault.init();
  const bytes = Buffer.concat(Array.from({ length: 12 }, (_, index) => Buffer.alloc(4096, 0x30 + index)));
  let interruption;
  await assert.rejects(
    vault.ingestStream(Readable.from(bytes), { name: "patient.img", failAfterBytes: 4 * 4096 }),
    (error) => { interruption = error; return error.code === "ERR_WW_VAULT_INTERRUPTED"; },
  );
  const snapshot = await vault.ingestStream(
    Readable.from(bytes.subarray(interruption.resumeOffset)),
    { operationId: interruption.operationId, offset: interruption.resumeOffset },
  );
  const output = [];
  const writable = new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  await vault.restoreSnapshot(snapshot.id, writable, { path: "patient.img" });
  await new Promise((resolve) => writable.on("finish", resolve));
  assert.equal(digest(Buffer.concat(output)), digest(bytes));
  await vault.close();
});

test("scrub precisely detects missing and corrupt objects", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-scrub-");
  const vaultRoot = path.join(root, "vault");
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, Buffer.concat([Buffer.alloc(4096, 1), Buffer.alloc(4096, 2), Buffer.alloc(4096, 3)]));
  const vault = createRecoveryVault({ root: vaultRoot, chunkSize: 4096 });
  await vault.init();
  const snapshot = await vault.ingestFile(source);
  const chunks = snapshot.entries[0].content.chunks;
  await fs.rm(objectFilename(vaultRoot, chunks[0].hash));
  await fs.writeFile(objectFilename(vaultRoot, chunks[1].hash), "corrupt");
  const result = await vault.scrub();
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingObjects.map((item) => item.hash), [chunks[0].hash]);
  assert.deepEqual(result.corruptObjects.map((item) => item.hash), [chunks[1].hash]);
  assert.deepEqual(result.missingObjects[0].referencedBy, [snapshot.id]);
  assert.equal((await vault.getStats()).lastScrubResult.ok, false);
  await vault.close();
});

test("retention pruning preserves pinned and reachable content while artifact imports reuse objects", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-prune-");
  const vaultRoot = path.join(root, "vault");
  const source = path.join(root, "artifact.bin");
  const bytes = Buffer.concat([Buffer.alloc(4096, 5), Buffer.alloc(4096, 6)]);
  await fs.writeFile(source, bytes);
  const vault = createRecoveryVault({ root: vaultRoot, chunkSize: 4096 });
  await vault.init();
  const pinned = await vault.ingestFile(source, { pinned: true, label: "pin" });
  const beforeImport = await vault.getStats();
  const artifact = await vault.ingestArtifact(source, { label: "existing recovery artifact" });
  assert.equal((await vault.getStats()).objectCount, beforeImport.objectCount);
  await fs.writeFile(source, Buffer.concat([Buffer.alloc(4096, 5), Buffer.alloc(4096, 9)]));
  const disposable = await vault.ingestFile(source);

  const bucketed = await vault.prune({ hourly: 1 });
  assert.ok(bucketed.retainedSnapshots.includes(pinned.id));
  assert.ok(bucketed.retainedSnapshots.includes(disposable.id));
  assert.ok(bucketed.prunedSnapshots.includes(artifact.id));

  const dry = await vault.prune({ keepLast: 0 });
  assert.equal(dry.execute, false);
  assert.ok(dry.retainedSnapshots.includes(pinned.id));
  assert.ok(dry.prunedSnapshots.includes(artifact.id));
  assert.ok(dry.prunedSnapshots.includes(disposable.id));
  assert.ok(vault.getSnapshot(disposable.id));

  const executed = await vault.prune({ keepLast: 0, execute: true });
  assert.ok(executed.retainedSnapshots.includes(pinned.id));
  assert.equal(vault.getSnapshot(artifact.id), null);
  assert.equal(vault.getSnapshot(disposable.id), null);
  assert.ok(vault.getSnapshot(pinned.id));
  assert.equal((await vault.scrub()).ok, true);
  const restored = path.join(root, "pinned.bin");
  await vault.restoreSnapshot(pinned.id, restored, { path: "artifact.bin", asFile: true });
  assert.equal(digest(await fs.readFile(restored)), digest(bytes));
  await vault.close();
});

test("sparse zero regions consume no objects and restore as sparse-compatible exact data", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-sparse-");
  const source = path.join(root, "sparse.img");
  const handle = await fs.open(source, "w");
  await handle.write(Buffer.from("head"), 0, 4, 0);
  await handle.write(Buffer.from("tail"), 0, 4, 3 * 4096);
  await handle.close();
  const vault = createRecoveryVault({ root: path.join(root, "vault"), chunkSize: 4096 });
  await vault.init();
  const snapshot = await vault.ingestFile(source);
  assert.ok(snapshot.entries[0].content.chunks.some((chunk) => chunk.zero));
  const destination = path.join(root, "sparse-restored.img");
  await vault.restoreSnapshot(snapshot.id, destination, { path: "sparse.img", asFile: true });
  assert.equal(digest(await fs.readFile(destination)), digest(await fs.readFile(source)));
  assert.ok(fsSync.statSync(destination).size === fsSync.statSync(source).size);
  await vault.close();
});
