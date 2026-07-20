import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function iso(value = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = canonicalize(value[key]);
    }
    return output;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix, value, length = 32) {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, length)}`;
}

export function generatedId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(9).toString("base64url")}`;
}

export function jsonSafe(value, label = "record") {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("undefined");
    return JSON.parse(text);
  } catch (cause) {
    throw new TypeError(`${label} must be JSON-serializable: ${cause.message}`);
  }
}

export async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filename);
    const directory = await fs.open(path.dirname(filename), "r").catch(() => null);
    if (directory) {
      await directory.sync().catch(() => {});
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function tokenize(value) {
  return [...new Set(String(value || "").toLocaleLowerCase().normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}_.:@/-]+/u)
    .flatMap((token) => token.split(/[/:@]+/))
    .filter(Boolean))];
}

export function safeRelative(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) {
    throw new TypeError(`Unsafe relative path: ${value}`);
  }
  return normalized;
}

export async function pathExists(filename) {
  return fs.access(filename).then(() => true, () => false);
}

export function compareTime(left, right) {
  return String(left.timestamp || left.createdAt || "").localeCompare(String(right.timestamp || right.createdAt || ""));
}

export function pickTimestamp(record = {}) {
  return iso(record.timestamp || record.observedAt || record.collectedAt || record.createdAt || Date.now());
}
