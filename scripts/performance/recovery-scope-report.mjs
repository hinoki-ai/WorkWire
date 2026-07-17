import fs from "node:fs/promises";
import path from "node:path";
import {
  emitResult,
  environmentRecord,
  parseArgs,
} from "./common.mjs";

const args = parseArgs();
const todoPath = path.resolve("docs/RECOVERY-PORTAL-TODO.md");
const todo = await fs.readFile(todoPath, "utf8");
const phaseMatches = [...todo.matchAll(/^## Phase (\d+) — (.+)$/gm)];
const phases = phaseMatches.map((match, index) => {
  const start = match.index;
  const end = phaseMatches[index + 1]?.index ?? todo.length;
  const body = todo.slice(start, end);
  const checked = (body.match(/^- \[[xX]\]/gm) || []).length;
  const unchecked = (body.match(/^- \[ \]/gm) || []).length;
  return {
    phase: Number(match[1]),
    title: match[2].trim(),
    checked,
    unchecked,
    complete: unchecked === 0 && checked > 0,
  };
});
const firstIncomplete = phases.find((phase) => !phase.complete) || null;

async function exists(relativePath) {
  try {
    await fs.access(path.resolve(relativePath));
    return true;
  } catch {
    return false;
  }
}

const recoveryModules = {
  configuration: await exists("lib/recovery/config.mjs"),
  protocol: await exists("lib/recovery/protocol.mjs"),
  durableStore: await exists("lib/recovery/store.mjs"),
  controller: await exists("lib/recovery/controller.mjs"),
  agent: await exists("lib/recovery/agent.mjs"),
  inventory: await exists("lib/recovery/inventory.mjs"),
  recoveryPortal: await exists("desktop/recovery"),
};

const component = String(args.component || "all");
await emitResult({
  report: "recovery-performance-scope",
  component,
  environment: environmentRecord(),
  phaseState: {
    completedPhase: phases.filter((phase) => phase.complete).at(-1) || null,
    nextPhase: firstIncomplete,
    phases,
  },
  recoveryModules,
  classification: Object.values(recoveryModules).some(Boolean)
    ? "IMPLEMENTATION PRESENT — benchmark the present modules before advancing"
    : "NOT APPLICABLE TO CURRENT IMPLEMENTATION",
  explanation: "The recovery specification is a future implementation plan. Phase 0 remains entirely unchecked, so recovery event stores, WebSocket agents, SSE, command output, artifacts, and inventory cannot be truthfully load-tested. The gate benchmarks the active Files implementation and does not introduce production mocks to fabricate recovery measurements.",
}, { output: String(args.output || "") });
