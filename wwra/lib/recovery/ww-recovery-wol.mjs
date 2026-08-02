import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { collectLanBroadcastTargets } from "../ww-network.mjs";

export function normalizeMacAddress(value = "") {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  if (!/^[0-9a-f]{12}$/.test(compact)) {
    const error = new Error(`Invalid Wake-on-LAN MAC address ${value}.`);
    error.code = "ERR_WW_RECOVERY_BAD_REQUEST";
    throw error;
  }
  return compact.match(/.{2}/g).join(":");
}

export function buildWakeMagicPacket(macAddress) {
  const normalized = normalizeMacAddress(macAddress);
  const mac = Buffer.from(normalized.replaceAll(":", ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sendPacket({ packet, address, port, dgramImpl }) {
  const socket = dgramImpl.createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          socket.send(packet, port, address, (error) => error ? reject(error) : resolve());
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    socket.close();
  }
}

export async function sendWakeOnLan({
  mac,
  broadcast,
  port = 9,
  fallbackPort = 7,
  burst = 3,
  intervalMs = 100,
  includeFallback = false,
  networkInterfaces,
  dgramImpl = dgram,
} = {}) {
  const normalizedMac = normalizeMacAddress(mac);
  const packet = buildWakeMagicPacket(normalizedMac);
  const broadcasts = broadcast
    ? [String(broadcast)]
    : collectLanBroadcastTargets({ networkInterfaces });
  if (broadcasts.length === 0) broadcasts.push("255.255.255.255");
  const ports = [Number(port) || 9];
  if (includeFallback && Number(fallbackPort) && !ports.includes(Number(fallbackPort))) ports.push(Number(fallbackPort));
  const attempts = [];
  const count = Math.max(1, Number(burst) || 3);
  for (let iteration = 0; iteration < count; iteration += 1) {
    for (const target of broadcasts) {
      for (const targetPort of ports) {
        try {
          await sendPacket({ packet, address: target, port: targetPort, dgramImpl });
          attempts.push({ address: target, port: targetPort, sent: true });
        } catch (error) {
          attempts.push({ address: target, port: targetPort, sent: false, error: error.message });
        }
      }
    }
    if (iteration + 1 < count && intervalMs > 0) await wait(intervalMs);
  }
  return {
    mac: normalizedMac,
    packetSent: attempts.some((attempt) => attempt.sent),
    machineOnline: false,
    attempts,
  };
}

export function createPowerAdapter({
  type = "wol",
  config = {},
  spawnImpl = spawn,
  wakeImpl = sendWakeOnLan,
} = {}) {
  if (type === "wol") {
    return {
      async getStatus() { return { power: "unknown", source: "wol" }; },
      async powerOn(options = {}) { return wakeImpl({ ...config, ...options }); },
      async powerOff() { throw new Error("Wake-on-LAN cannot power a machine off."); },
      async reset() { throw new Error("Wake-on-LAN cannot reset a machine."); },
      async setNextBoot() { throw new Error("Wake-on-LAN cannot select a boot source."); },
      async openConsole() { throw new Error("Wake-on-LAN does not provide a console."); },
    };
  }
  if (type === "custom-command") {
    const execute = (command, args = []) => new Promise((resolve, reject) => {
      const child = spawnImpl(String(command), args.map(String), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      child.stdout?.on("data", (chunk) => stdout.push(chunk));
      child.stderr?.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
    const action = (name) => async () => {
      const argv = Array.isArray(config[name]) ? config[name] : [];
      if (argv.length === 0) throw new Error(`No custom ${name} command is configured.`);
      return execute(argv[0], argv.slice(1));
    };
    return {
      getStatus: action("getStatus"),
      powerOn: action("powerOn"),
      powerOff: action("powerOff"),
      reset: action("reset"),
      setNextBoot: action("setNextBoot"),
      openConsole: action("openConsole"),
    };
  }
  throw new Error(`Power adapter ${type} is not implemented. Reserved adapters: ipmi, redfish, amt.`);
}
