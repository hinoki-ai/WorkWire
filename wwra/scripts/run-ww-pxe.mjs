#!/usr/bin/env node

import process from "node:process";
import { loadRecoveryConfig } from "../lib/recovery/ww-recovery-config.mjs";
import { createRecoveryBootManager } from "../lib/recovery/ww-recovery-boot.mjs";

const args = process.argv.slice(2);
const command = String(args.shift() || "status");
const interfaceIndex = args.indexOf("--interface");
const interfaceName = interfaceIndex === -1 ? "" : String(args[interfaceIndex + 1] || "");
const config = await loadRecoveryConfig();
const manager = createRecoveryBootManager({ config, log: (message) => process.stderr.write(`${message}\n`) });

try {
  if (command === "start") {
    const result = await manager.start({ interfaceName });
    process.stdout.write(`${JSON.stringify({ ok: true, pxe: result }, null, 2)}\n`);
    const shutdown = async () => {
      await manager.stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise(() => {});
  } else if (command === "stop") {
    process.stdout.write(`${JSON.stringify({ ok: true, pxe: await manager.stop() }, null, 2)}\n`);
  } else if (command === "status") {
    process.stdout.write(`${JSON.stringify({ ok: true, pxe: await manager.status() }, null, 2)}\n`);
  } else if (command === "prepare" || command === "install") {
    process.stdout.write(`${JSON.stringify({ ok: true, pxe: await manager.prepare({ interfaceName }) }, null, 2)}\n`);
  } else if (["arm", "local"].includes(command)) {
    const mac = args.find((value) => !value.startsWith("--"));
    if (!mac) throw new Error(`PXE ${command} requires MAC.`);
    process.stdout.write(`${JSON.stringify({ ok: true, policy: await manager[command](mac) }, null, 2)}\n`);
  } else {
    throw new Error(`Unknown WorkWire PXE command ${command}.`);
  }
} catch (error) {
  process.stderr.write(`${error.code || "ERR_WW_RECOVERY_PXE"}: ${error.message}\n`);
  process.exitCode = 6;
}
