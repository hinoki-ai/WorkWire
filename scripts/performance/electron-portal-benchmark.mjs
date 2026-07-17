import { spawn } from "node:child_process";
import path from "node:path";
import electronPath from "electron";
import {
  emitResult,
  parseArgs,
} from "./common.mjs";

const args = parseArgs();
const workerPath = path.resolve("scripts/performance/electron-portal-worker.cjs");
const workerArgs = [
  workerPath,
  `--sizes=${String(args.sizes || "100,1000,10000,50000")}`,
  `--repeats=${String(args.repeats || "5")}`,
  `--reloads=${String(args.reloads || "5")}`,
  `--soak-cycles=${String(args["soak-cycles"] ?? "10")}`,
  `--soak-entries=${String(args["soak-entries"] || "10000")}`,
  `--queries-per-cycle=${String(args["queries-per-cycle"] || "50")}`,
  `--ipc-messages=${String(args["ipc-messages"] || "1000")}`,
];

const child = spawn(electronPath, workerArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WW_PERF_DIAGNOSTICS: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});
if (exitCode !== 0) {
  throw new Error(`Electron portal benchmark exited ${exitCode}.\n${stderr}\n${stdout}`);
}
const marker = "WW_PERF_RESULT:";
const line = stdout.split(/\r?\n/).find((value) => value.startsWith(marker));
if (!line) throw new Error(`Electron portal benchmark emitted no result.\n${stderr}\n${stdout}`);
const result = JSON.parse(line.slice(marker.length));
await emitResult(result, { output: String(args.output || "") });
