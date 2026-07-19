import path from "node:path";
import process from "node:process";

export function recoveryPlatformDefaults(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const programData = String(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData");
    const base = path.win32.join(programData, "WorkWire");
    return {
      platform: "win32",
      configPath: path.win32.join(base, "recovery-agent.json"),
      installedIdPath: path.win32.join(base, "agent-id"),
      installedStateDir: path.win32.join(base, "recovery-state"),
      pxeStateDir: path.win32.join(base, "recovery-state"),
      cmdlinePath: "",
    };
  }
  return {
    platform: "posix",
    configPath: "/etc/workwire/recovery-agent.json",
    installedIdPath: "/etc/workwire/agent-id",
    installedStateDir: "/var/lib/workwire-recovery",
    pxeStateDir: "/run/workwire-recovery",
    cmdlinePath: "/proc/cmdline",
  };
}

export const WINDOWS_CAPABILITY_TOOLS = Object.freeze([
  "powershell", "cmd", "shutdown", "schtasks", "sc", "reg", "bcdedit",
  "diskpart", "chkdsk", "sfc", "robocopy", "tasklist", "taskkill", "netsh", "wmic",
]);
