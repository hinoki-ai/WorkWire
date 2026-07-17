import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createLocalEndpoint } from "../lib/ww-endpoint.mjs";

async function withTempDir(run) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-endpoint-"));
  try {
    return await run(baseDir);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

function toPortalRelative(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath ? relativePath.split(path.sep).join("/") : ".";
}

test("ww local endpoint hides internal portal folders from root listings and transfer manifests", async () => {
  await withTempDir(async (rootPath) => {
    await fs.mkdir(path.join(rootPath, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootPath, ".workwire"), { recursive: true });
    await fs.mkdir(path.join(rootPath, "link"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "docs", "notes.txt"), "kept\n", "utf8");
    await fs.writeFile(path.join(rootPath, ".workwire", "state.json"), "hidden\n", "utf8");
    await fs.writeFile(path.join(rootPath, "link", "pairing.json"), "hidden\n", "utf8");

    const endpoint = createLocalEndpoint({
      rootPath,
      name: "test-box",
    });

    const listing = await endpoint.listDirectory({
      path: rootPath,
      includeHidden: true,
    });
    assert.deepEqual(listing.items.map((entry) => entry.name), ["docs"]);

    const manifest = await endpoint.buildManifest({
      path: rootPath,
    });
    assert.deepEqual(
      manifest.directories.map((entry) => toPortalRelative(rootPath, entry.path)),
      [".", "docs"],
    );
    assert.deepEqual(
      manifest.files.map((entry) => entry.relativePath),
      ["docs/notes.txt"],
    );
  });
});

test("ww local endpoint preserves valid spaces while blocking internal rename and copy destinations", async () => {
  await withTempDir(async (rootPath) => {
    const sourcePath = path.join(rootPath, "source.txt");
    await fs.writeFile(sourcePath, "source\n", "utf8");
    const endpoint = createLocalEndpoint({ rootPath, name: "test-box" });

    const renamed = await endpoint.rename({
      path: sourcePath,
      nextName: " spaced name .txt ",
    });
    assert.equal(renamed.name, " spaced name .txt ");
    assert.equal(await fs.readFile(renamed.path, "utf8"), "source\n");

    await assert.rejects(
      endpoint.rename({ path: renamed.path, nextName: "link" }),
      /reserved for internal files/,
    );
    await assert.rejects(
      endpoint.copyPath({
        sourcePath: renamed.path,
        destinationPath: path.join(rootPath, ".workwire", "copy.txt"),
      }),
      /reserved for internal files/,
    );
  });
});

test("ww local endpoint hides and blocks transient upload artifacts at every depth", async () => {
  await withTempDir(async (rootPath) => {
    const nestedPath = path.join(rootPath, "docs");
    const temporaryPath = path.join(nestedPath, ".ww-upload-1-fixture.tmp");
    await fs.mkdir(nestedPath, { recursive: true });
    await fs.writeFile(temporaryPath, "partial", "utf8");
    const endpoint = createLocalEndpoint({ rootPath, name: "test-box" });

    const listing = await endpoint.listDirectory({ path: nestedPath, includeHidden: true });
    assert.deepEqual(listing.items, []);
    const manifest = await endpoint.buildManifest({ path: rootPath });
    assert.equal(manifest.files.some((entry) => entry.path === temporaryPath), false);
    await assert.rejects(endpoint.stat({ path: temporaryPath }), /reserved for internal files/);
  });
});

test("ww local endpoint rejects direct access to internal portal folders", async () => {
  await withTempDir(async (rootPath) => {
    await fs.mkdir(path.join(rootPath, ".workwire"), { recursive: true });
    await fs.mkdir(path.join(rootPath, "link"), { recursive: true });

    const endpoint = createLocalEndpoint({
      rootPath,
      name: "test-box",
    });

    await assert.rejects(
      endpoint.listDirectory({
        path: path.join(rootPath, ".workwire"),
        includeHidden: true,
      }),
      /reserved for internal files/,
    );
    await assert.rejects(
      endpoint.stat({
        path: path.join(rootPath, "link"),
      }),
      /reserved for internal files/,
    );
  });
});

test("ww local endpoint blocks symlink escapes and portal-root mutation", async (context) => {
  await withTempDir(async (baseDir) => {
    const rootPath = path.join(baseDir, "portal");
    const outsidePath = path.join(baseDir, "outside");
    await fs.mkdir(rootPath, { recursive: true });
    await fs.mkdir(outsidePath, { recursive: true });
    await fs.writeFile(path.join(outsidePath, "secret.txt"), "outside\n", "utf8");

    try {
      await fs.symlink(outsidePath, path.join(rootPath, "escape"), "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    const endpoint = createLocalEndpoint({
      rootPath,
      name: "test-box",
    });

    await assert.rejects(
      endpoint.stat({
        path: path.join(rootPath, "escape", "secret.txt"),
      }),
      /resolves outside/,
    );
    await assert.rejects(
      endpoint.createFile({
        path: path.join(rootPath, "escape", "created.txt"),
        contents: "blocked\n",
      }),
      /resolves outside/,
    );
    await assert.rejects(
      endpoint.deletePaths({
        paths: [rootPath],
      }),
      /cannot delete the portal root/,
    );
  });
});

test("ww local endpoint keeps the previous destination intact when an upload fails", async () => {
  await withTempDir(async (rootPath) => {
    const targetPath = path.join(rootPath, "report.txt");
    await fs.writeFile(targetPath, "original\n", "utf8");
    const endpoint = createLocalEndpoint({
      rootPath,
      name: "test-box",
    });
    const brokenStream = new Readable({
      read() {
        this.push("partial");
        this.destroy(new Error("simulated connection loss"));
      },
    });

    await assert.rejects(
      endpoint.uploadFileStream(targetPath, brokenStream, {
        overwrite: true,
      }),
      /simulated connection loss/,
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), "original\n");
    assert.deepEqual(
      (await fs.readdir(rootPath)).filter((name) => name.startsWith(".ww-upload-")),
      [],
    );
  });
});

test("ww upload atomically replaces a directory only after the full file arrives", async () => {
  await withTempDir(async (rootPath) => {
    const targetPath = path.join(rootPath, "switch-kind");
    await fs.mkdir(targetPath);
    await fs.writeFile(path.join(targetPath, "important.txt"), "keep\n", "utf8");
    const endpoint = createLocalEndpoint({ rootPath, name: "test-box" });
    const brokenStream = new Readable({
      read() {
        this.push("partial");
        this.destroy(new Error("interrupted"));
      },
    });

    await assert.rejects(
      endpoint.uploadFileStream(targetPath, brokenStream, { overwrite: true }),
      /interrupted/,
    );
    assert.equal(await fs.readFile(path.join(targetPath, "important.txt"), "utf8"), "keep\n");

    await endpoint.uploadFileStream(targetPath, Readable.from(["complete\n"]), { overwrite: true });
    assert.equal(await fs.readFile(targetPath, "utf8"), "complete\n");
    assert.deepEqual(
      (await fs.readdir(rootPath)).filter((name) => name.startsWith(".ww-")),
      [],
    );
  });
});
