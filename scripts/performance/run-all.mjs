import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./common.mjs";

const args = parseArgs();
const quick = args.quick === true || args.quick === "true";
const outputDir = path.resolve(String(args["output-dir"] || "performance-results/latest"));
await fs.mkdir(outputDir, { recursive: true });

const commands = [
  ["node", ["--expose-gc", "scripts/performance/portal-search-benchmark.mjs", `--repeats=${quick ? 2 : 5}`, `--output=${path.join(outputDir, "portal-search.json")}`]],
  ["node", ["scripts/performance/electron-portal-benchmark.mjs", `--repeats=${quick ? 2 : 5}`, `--reloads=${quick ? 2 : 10}`, `--output=${path.join(outputDir, "electron-portal.json")}`]],
  ["node", ["--expose-gc", "scripts/performance/filesystem-benchmark.mjs", `--repeats=${quick ? 2 : 5}`, `--output=${path.join(outputDir, "filesystem.json")}`]],
  ["node", ["--expose-gc", "scripts/performance/service-stress-benchmark.mjs", `--rounds=${quick ? 2 : 5}`, `--output=${path.join(outputDir, "service-stress.json")}`]],
  ["node", ["--expose-gc", "scripts/performance/transfer-benchmark.mjs", `--repeats=${quick ? 2 : 3}`, ...(quick ? ["--sizes-mib=0,0.0625,100"] : []), `--output=${path.join(outputDir, "transfer.json")}`]],
  ["node", ["--expose-gc", "scripts/performance/lifecycle-soak.mjs", `--duration-seconds=${quick ? 5 : 60}`, `--iterations=${quick ? 500 : 100000}`, `--output=${path.join(outputDir, "soak.json")}`]],
  ["node", ["scripts/performance/recovery-scope-report.mjs", `--output=${path.join(outputDir, "recovery-scope.json")}`]],
];

for (const [command, commandArgs] of commands) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited ${code}`);
}
