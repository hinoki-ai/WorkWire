import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listTrash,
  restoreTrashItem,
  trashPaths,
  WW_TRASH_RETENTION_MS,
} from "../lib/ww-fs.mjs";

async function withTempDir(run) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "ww-trash-"));
  try {
    return await run(rootPath);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

test("ww trash keeps deleted files for five days and restores their original path", async () => {
  await withTempDir(async (rootPath) => {
    const originalPath = path.join(rootPath, "reports", "latest.txt");
    const deletedAt = Date.UTC(2026, 6, 17, 12, 0, 0);
    await fs.mkdir(path.dirname(originalPath), { recursive: true });
    await fs.writeFile(originalPath, "recover me\n", "utf8");

    const [deleted] = await trashPaths([originalPath], { rootPath, now: deletedAt });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.expiresAt, deletedAt + WW_TRASH_RETENTION_MS);
    await assert.rejects(fs.access(originalPath));

    const items = await listTrash(rootPath, { now: deletedAt + 1_000 });
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "latest.txt");
    assert.equal(items[0].originalPath, originalPath);

    const restored = await restoreTrashItem(rootPath, deleted.id, { now: deletedAt + 2_000 });
    assert.equal(restored.originalPath, originalPath);
    assert.equal(await fs.readFile(originalPath, "utf8"), "recover me\n");
    assert.deepEqual(await listTrash(rootPath, { now: deletedAt + 3_000 }), []);
  });
});

test("ww trash does not overwrite a replacement when restoring", async () => {
  await withTempDir(async (rootPath) => {
    const originalPath = path.join(rootPath, "draft.txt");
    await fs.writeFile(originalPath, "old\n", "utf8");
    const [deleted] = await trashPaths([originalPath], { rootPath, now: 1_000 });
    await fs.writeFile(originalPath, "new\n", "utf8");

    await assert.rejects(
      restoreTrashItem(rootPath, deleted.id, { now: 2_000 }),
      /already exists in its original location/,
    );
    assert.equal(await fs.readFile(originalPath, "utf8"), "new\n");
    assert.equal((await listTrash(rootPath, { now: 2_000 })).length, 1);
  });
});

test("ww trash permanently purges entries after the retention window", async () => {
  await withTempDir(async (rootPath) => {
    const originalPath = path.join(rootPath, "expired.txt");
    await fs.writeFile(originalPath, "gone\n", "utf8");
    const [deleted] = await trashPaths([originalPath], {
      rootPath,
      retentionMs: 500,
      now: 10_000,
    });

    const beforeExpiry = await listTrash(rootPath, { now: 10_499 });
    assert.equal(beforeExpiry.length, 1);
    assert.equal(beforeExpiry[0].id, deleted.id);
    assert.equal(beforeExpiry[0].name, "expired.txt");
    assert.deepEqual(await listTrash(rootPath, { now: 10_500 }), []);
    await assert.rejects(
      restoreTrashItem(rootPath, deleted.id, { now: 10_501 }),
      /ENOENT|no such file/i,
    );
  });
});
