import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildWwInstallCommand,
  buildWwLanArtifactName,
  buildWwLanManifest,
  renderWwLanChecksums,
  renderServedWwInstallScript,
  renderWwLanLandingPage,
} from "../lib/ww-lan-installer.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(__dirname, "..");
const installScriptPath = path.join(repoDir, "scripts", "install-ww-from-lan.sh");

async function createTarArchive(archivePath, rootDir, entryName) {
  await execFileAsync("tar", [
    "-czf",
    archivePath,
    "-C",
    rootDir,
    entryName,
  ], {
    maxBuffer: 4_000_000,
  });
}

async function createArtifactFixture(tempRoot) {
  const bundleRoot = path.join(tempRoot, "bundle");
  const wwDir = path.join(bundleRoot, "ww");
  const artifactPath = path.join(tempRoot, "ww-linux-x64.tar.gz");

  await fs.mkdir(wwDir, { recursive: true });
  await fs.writeFile(
    path.join(wwDir, "ww"),
    "#!/usr/bin/env bash\nset -euo pipefail\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(wwDir, "install-ww.sh"),
    `#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
printf 'ready\\n' > "$ROOT_DIR/install-result.txt"
`,
    "utf8",
  );
  await fs.chmod(path.join(wwDir, "ww"), 0o755);
  await fs.chmod(path.join(wwDir, "install-ww.sh"), 0o755);

  await createTarArchive(artifactPath, bundleRoot, "ww");
  return artifactPath;
}

async function hashFileSha256(filePath) {
  const body = await fs.readFile(filePath);
  return createHash("sha256").update(body).digest("hex");
}

async function startFixtureServer(artifactPath, {
  checksum = "",
} = {}) {
  let artifactRequests = 0;
  const expectedChecksum = checksum || await hashFileSha256(artifactPath);
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://fixture.local");
    if (requestUrl.pathname === "/ww-linux-x64.tar.gz") {
      artifactRequests += 1;
      const artifact = await fs.readFile(artifactPath);
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(artifact.length),
      });
      response.end(artifact);
      return;
    }

    if (requestUrl.pathname === "/SHA256SUMS") {
      const body = `${expectedChecksum}  ww-linux-x64.tar.gz\n`;
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }

    if (requestUrl.pathname === "/manifest.json") {
      const manifest = buildWwLanManifest({
        version: "1.2.3",
        arch: "x64",
        generatedAt: "2026-04-13T00:00:00.000Z",
        stableSha256: expectedChecksum,
      });
      const body = `${JSON.stringify(manifest)}\n`;
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }

    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("Not found.\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    getArtifactRequests: () => artifactRequests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function runLanInstall(baseUrl, targetDir) {
  return execFileAsync("bash", [
    installScriptPath,
    baseUrl,
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      WW_LAN_TARGET_DIR: targetDir,
      WW_LAN_ARCH: "x64",
    },
    maxBuffer: 4_000_000,
  });
}

test("WW LAN manifest and landing page expose the self-contained Linux artifacts", () => {
  const manifest = buildWwLanManifest({
    version: "1.2.3+ww1.abcdef012345",
    artifactVersion: "1.2.3-ww1.abcdef012345",
    packageVersion: "1.2.3",
    buildHash: "f".repeat(64),
    arch: "x64",
    generatedAt: "2026-04-13T00:00:00.000Z",
    stableSha256: "a".repeat(64),
    stableSize: 111,
    versionedSha256: "b".repeat(64),
    versionedSize: 222,
    appImageSha256: "c".repeat(64),
    appImageSize: 333,
  });
  const page = renderWwLanLandingPage({ manifest });
  const checksums = renderWwLanChecksums(manifest);

  assert.equal(buildWwLanArtifactName("1.2.3", "x64"), "WorkWire-1.2.3-linux-x64.tar.gz");
  assert.equal(manifest.artifact.name, "ww-linux-x64.tar.gz");
  assert.equal(manifest.version, "1.2.3+ww1.abcdef012345");
  assert.equal(manifest.artifactVersion, "1.2.3-ww1.abcdef012345");
  assert.equal(manifest.release.packageVersion, "1.2.3");
  assert.equal(manifest.release.buildHash, "f".repeat(64));
  assert.equal(manifest.artifact.versionedName, "WorkWire-1.2.3-ww1.abcdef012345-linux-x64.tar.gz");
  assert.equal(manifest.artifact.appImageName, "WorkWire-1.2.3-ww1.abcdef012345-linux-x86_64.AppImage");
  assert.equal(manifest.checksumPath, "/SHA256SUMS");
  assert.equal(manifest.artifact.sha256, "a".repeat(64));
  assert.equal(manifest.artifact.versionedSha256, "b".repeat(64));
  assert.equal(manifest.artifact.appImageSha256, "c".repeat(64));
  assert.match(page, /includes Electron and the WorkWire runtime/i);
  assert.match(page, /ww-linux-x64\.tar\.gz/);
  assert.match(page, /WorkWire-1\.2\.3-ww1\.abcdef012345-linux-x86_64\.AppImage/);
  assert.match(page, /SHA256SUMS/);
  assert.match(checksums, /^a{64}  ww-linux-x64\.tar\.gz$/m);
  assert.match(checksums, /^c{64}  WorkWire-1\.2\.3-ww1\.abcdef012345-linux-x86_64\.AppImage$/m);
  assert.equal(buildWwInstallCommand("http://192.168.8.50:8765/"), "curl -fsSL http://192.168.8.50:8765/install.sh | bash");
});

test("served install script injects the request base URL once", () => {
  const servedScript = renderServedWwInstallScript({
    baseUrl: "http://192.168.8.50:8765/",
    manifest: buildWwLanManifest({
      version: "1.2.3",
      arch: "x64",
      stableSha256: "d".repeat(64),
    }),
    template: "#!/usr/bin/env bash\nprintf 'fixture\\n'\n",
  });

  assert.match(servedScript, /^#!\/usr\/bin\/env bash\nWW_LAN_BASE_URL="http:\/\/192\.168\.8\.50:8765"/);
  assert.match(servedScript, /\nWW_LAN_MANIFEST_URL="http:\/\/192\.168\.8\.50:8765\/manifest\.json"\n/);
  assert.match(servedScript, /\nWW_LAN_CHECKSUM_URL="http:\/\/192\.168\.8\.50:8765\/SHA256SUMS"\n/);
  assert.match(servedScript, /\nWW_LAN_ARTIFACT_NAME="ww-linux-x64\.tar\.gz"\n/);
  assert.match(servedScript, /\nWW_LAN_ARTIFACT_SHA256="d{64}"\n/);
  assert.match(servedScript, /printf 'fixture\\n'/);
  assert.equal(servedScript.split("#!/usr/bin/env bash").length, 2);
});

test("install-ww-from-lan downloads the self-contained WW bundle and runs its install hook", {
  skip: process.platform === "win32" ? "The LAN shell installer targets Linux; Windows convergence has its own native installer gate." : false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-lan-install-"));

  try {
    const artifactPath = await createArtifactFixture(tempRoot);
    const server = await startFixtureServer(artifactPath);
    const targetDir = path.join(tempRoot, "workwire-target");

    try {
      await runLanInstall(server.baseUrl, targetDir);
    } finally {
      await server.close();
    }

    const installResult = await fs.readFile(path.join(targetDir, "install-result.txt"), "utf8");
    assert.equal(installResult, "ready\n");
    assert.equal(server.getArtifactRequests(), 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("install-ww-from-lan aborts on checksum mismatch before replacing the staged bundle", {
  skip: process.platform === "win32" ? "The LAN shell installer targets Linux; Windows convergence has its own native installer gate." : false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-lan-install-"));

  try {
    const artifactPath = await createArtifactFixture(tempRoot);
    const server = await startFixtureServer(artifactPath, {
      checksum: "0".repeat(64),
    });
    const targetDir = path.join(tempRoot, "workwire-target");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "sentinel.txt"), "keep\n", "utf8");

    try {
      await assert.rejects(
        runLanInstall(server.baseUrl, targetDir),
        /checksum mismatch/i,
      );
    } finally {
      await server.close();
    }

    assert.equal(await fs.readFile(path.join(targetDir, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
