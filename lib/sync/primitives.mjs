import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function abortError(message = "Operation aborted.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

export function makeId(prefix, ...parts) {
  const input = parts.filter((value) => value !== undefined).join("\0");
  const suffix = input
    ? crypto.createHash("sha256").update(input).digest("hex").slice(0, 24)
    : crypto.randomBytes(12).toString("hex");
  return `${prefix}-${suffix}`;
}

export function normalizeRelative(value = "") {
  const raw = String(value || "").replaceAll("\\", "/");
  const segments = raw.split("/").filter((part) => part && part !== ".");
  if (raw.includes("\0") || segments.some((part) => part === "..")) {
    const error = new Error(`Unsafe relative path: ${value}`);
    error.code = "ERR_WW_UNSAFE_PATH";
    throw error;
  }
  return segments.join("/");
}

export function resolveInside(rootPath, relativePath = "") {
  const root = path.resolve(String(rootPath || ""));
  const relative = normalizeRelative(relativePath);
  const target = relative ? path.join(root, ...relative.split("/")) : root;
  const check = path.relative(root, target);
  if (check.startsWith("..") || path.isAbsolute(check)) {
    const error = new Error(`Path escapes ${root}.`);
    error.code = "ERR_WW_ROOT_ESCAPE";
    throw error;
  }
  return target;
}

export async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteJson(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(temporary, targetPath);
        break;
      } catch (error) {
        if (
          process.platform !== "win32"
          || !["EACCES", "EBUSY", "EPERM"].includes(error?.code)
          || attempt >= 20
        ) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, 5 * (attempt + 1))));
      }
    }
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readJson(targetPath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(targetPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return structuredClone(fallback);
    throw error;
  }
}

export async function hashFile(targetPath, { signal, start = 0, end = Infinity } = {}) {
  throwIfAborted(signal);
  const hash = crypto.createHash("sha256");
  const options = { start: Math.max(0, Number(start) || 0), highWaterMark: 1024 * 1024 };
  if (Number.isFinite(end)) options.end = Math.max(options.start, Number(end) - 1);
  const stream = fs.createReadStream(targetPath, options);
  const abort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return hash.digest("hex");
}

export function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function isZeroBuffer(buffer) {
  const words = new BigUint64Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 8));
  for (const word of words) if (word !== 0n) return false;
  for (let index = words.byteLength; index < buffer.byteLength; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

export async function readRange(fileHandle, offset, length) {
  const result = Buffer.allocUnsafe(length);
  let cursor = 0;
  while (cursor < length) {
    const { bytesRead } = await fileHandle.read(result, cursor, length - cursor, offset + cursor);
    if (!bytesRead) break;
    cursor += bytesRead;
  }
  return cursor === length ? result : result.subarray(0, cursor);
}

export async function writeAll(fileHandle, buffer, offset) {
  let cursor = 0;
  while (cursor < buffer.length) {
    const { bytesWritten } = await fileHandle.write(buffer, cursor, buffer.length - cursor, offset + cursor);
    if (!bytesWritten) throw new Error("Unable to make progress writing a file.");
    cursor += bytesWritten;
  }
}

export async function mapLimit(items, concurrency, worker) {
  const values = Array.from(items || []);
  const results = new Array(values.length);
  let cursor = 0;
  const count = Math.min(values.length, Math.max(1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

export async function delay(ms, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  }).finally(() => {});
}

export function jsonRecord(value) {
  return JSON.parse(JSON.stringify(value));
}
