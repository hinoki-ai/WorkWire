import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PLAYBOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "recovery", "playbooks");

function readPath(value, dottedPath) {
  return String(dottedPath || "").split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function conditionMatches(condition, inventory, inputs) {
  if (!condition) return true;
  if (condition.all) return condition.all.every((item) => conditionMatches(item, inventory, inputs));
  if (condition.any) return condition.any.some((item) => conditionMatches(item, inventory, inputs));
  if (condition.not) return !conditionMatches(condition.not, inventory, inputs);
  const source = condition.source === "inputs" ? inputs : inventory;
  const value = readPath(source, condition.path);
  if (Object.hasOwn(condition, "equals")) return value === condition.equals;
  if (Object.hasOwn(condition, "exists")) return condition.exists ? value !== undefined && value !== null : value === undefined || value === null;
  if (condition.includes) return Array.isArray(value) ? value.includes(condition.includes) : String(value || "").includes(String(condition.includes));
  return Boolean(value);
}

function substitute(value, inputs) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, inputs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, inputs)]));
  if (typeof value !== "string") return value;
  const exact = value.match(/^\$\{input\.([^}]+)\}$/);
  if (exact) return readPath(inputs, exact[1]);
  return value.replace(/\$\{input\.([^}]+)\}/g, (_, key) => String(readPath(inputs, key) ?? ""));
}

export async function loadRecoveryPlaybooks({ directory = DEFAULT_PLAYBOOK_DIR } = {}) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const playbooks = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const value = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"));
    if (!value.id || !Array.isArray(value.steps)) throw new Error(`Invalid recovery playbook ${entry.name}.`);
    playbooks.push(value);
  }
  return playbooks;
}

export async function getRecoveryPlaybook(id, options = {}) {
  return (await loadRecoveryPlaybooks(options)).find((playbook) => playbook.id === id) || null;
}

export function expandRecoveryPlaybook(playbook, {
  inventory = {},
  inputs = {},
  force = false,
  skip = [],
  insert = [],
} = {}) {
  if (!playbook?.id || !Array.isArray(playbook.steps)) throw new TypeError("A recovery playbook is required.");
  const skipped = new Set(skip.map(String));
  const steps = playbook.steps
    .filter((step) => !skipped.has(step.id))
    .filter((step) => conditionMatches(step.when, inventory, inputs))
    .map((step) => ({
      ...substitute(step, inputs),
      force: step.force === undefined ? force : step.force,
    }));
  for (const addition of insert) {
    const index = addition.before
      ? steps.findIndex((step) => step.id === addition.before)
      : addition.after ? steps.findIndex((step) => step.id === addition.after) + 1 : steps.length;
    steps.splice(index < 0 ? steps.length : index, 0, substitute(addition.step || addition, inputs));
  }
  return {
    playbookId: playbook.id,
    title: playbook.title,
    goal: substitute(playbook.goal || playbook.title, inputs),
    steps,
    verification: substitute(playbook.verification || [], inputs),
    plannerHints: substitute(playbook.plannerHints || [], inputs),
  };
}

export { conditionMatches, DEFAULT_PLAYBOOK_DIR };
