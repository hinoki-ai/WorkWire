import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkWireSyncEngine } from "../lib/sync/index.mjs";

test("three peers converge create, edit, rename, delete, offline reconnect, and conflict", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ww-three-peer-"));
  const roots = ["a", "b", "c"].map((name) => path.join(base, name));
  await Promise.all(roots.map((root) => fs.mkdir(root)));
  const engine = createWorkWireSyncEngine({ machineId: "a", stateDir: path.join(base, "state") });
  await engine.init();
  t.after(() => engine.close());
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 }));
  await engine.addPeer({ id: "b", rootPath: roots[1] });
  await engine.addPeer({ id: "c", rootPath: roots[2] });
  await engine.addFolder({ id: "shared", rootPath: roots[0], peers: ["b", "c"], chunkSize: 64 * 1024 });

  await fs.writeFile(path.join(roots[0], "one.txt"), "created");
  await engine.sync("shared");
  assert.equal(await fs.readFile(path.join(roots[2], "one.txt"), "utf8"), "created");

  await fs.writeFile(path.join(roots[1], "one.txt"), "edited on b");
  await engine.sync("shared");
  assert.equal(await fs.readFile(path.join(roots[0], "one.txt"), "utf8"), "edited on b");
  assert.equal(await fs.readFile(path.join(roots[2], "one.txt"), "utf8"), "edited on b");

  await fs.rename(path.join(roots[0], "one.txt"), path.join(roots[0], "renamed.txt"));
  await engine.sync("shared");
  for (const root of roots) assert.equal(await fs.readFile(path.join(root, "renamed.txt"), "utf8"), "edited on b");

  await engine.updatePeer("c", { online: false });
  await fs.writeFile(path.join(roots[0], "offline.txt"), "queued");
  const offline = await engine.sync("shared");
  assert.equal(offline.peers.find((peer) => peer.peerId === "c").offline, true);
  await engine.updatePeer("c", { online: true });
  await engine.sync("shared");
  assert.equal(await fs.readFile(path.join(roots[2], "offline.txt"), "utf8"), "queued");

  await fs.rm(path.join(roots[1], "renamed.txt"));
  await engine.sync("shared");
  for (const root of roots) await assert.rejects(fs.stat(path.join(root, "renamed.txt")), { code: "ENOENT" });

  await fs.writeFile(path.join(roots[0], "offline.txt"), "left simultaneous");
  await fs.writeFile(path.join(roots[1], "offline.txt"), "right simultaneous");
  const result = await engine.sync("shared", { peers: ["b"] });
  assert.equal(result.conflicts, 1);
  assert.equal(engine.getFolderStatus("shared").phase, "conflict");
});
