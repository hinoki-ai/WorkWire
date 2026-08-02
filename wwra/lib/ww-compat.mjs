import { WW_APP_VERSION } from "./ww-release.mjs";
import { WW_PROTOCOL_VERSION } from "./ww-protocol.mjs";

export { WW_APP_VERSION };
export { WW_PROTOCOL_VERSION };
export const WW_LAN_INSTALLER_URL = normalizeInstallerUrl(
  process.env.WW_LAN_INSTALLER_URL || "",
);

function buildInstallGuidance(installerUrl = "") {
  return installerUrl
    ? ` Install the matching WW build from ${installerUrl}.`
    : " Install the same current WW build on both PCs.";
}

function normalizeProtocolVersion(value, fallback = null) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return fallback;
  }
  const protocolVersion = Number(raw);
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    return fallback;
  }
  return protocolVersion;
}

function normalizeAppVersion(value, fallback = "") {
  const appVersion = String(value ?? "").trim();
  return appVersion || fallback;
}

export function normalizeInstallerUrl(value, fallback = "") {
  const installerUrl = String(value || fallback || "").trim();
  if (!installerUrl) {
    return "";
  }
  return installerUrl.endsWith("/") ? installerUrl : `${installerUrl}/`;
}

export function buildWwBuildInfo({
  protocolVersion = WW_PROTOCOL_VERSION,
  appVersion = WW_APP_VERSION,
  installerUrl = WW_LAN_INSTALLER_URL,
} = {}) {
  return {
    versions: {
      protocol: normalizeProtocolVersion(protocolVersion, WW_PROTOCOL_VERSION),
      app: normalizeAppVersion(appVersion, WW_APP_VERSION),
    },
    installerUrl: normalizeInstallerUrl(installerUrl, WW_LAN_INSTALLER_URL),
  };
}

export function readWwBuildInfo(source = {}) {
  const versions = source?.versions && typeof source.versions === "object"
    ? source.versions
    : source?.build && typeof source.build === "object"
      ? source.build
      : source;

  return {
    protocolVersion: normalizeProtocolVersion(
      versions?.protocol
      ?? versions?.protocolVersion
      ?? source?.protocolVersion
      ?? source?.protocol
      ?? source?.version,
      null,
    ),
    appVersion: normalizeAppVersion(
      versions?.app ?? versions?.appVersion ?? source?.appVersion,
      "",
    ),
    installerUrl: normalizeInstallerUrl(
      source?.installerUrl ?? source?.build?.installerUrl,
      WW_LAN_INSTALLER_URL,
    ),
  };
}

export function assessWwCompatibility({
  local = buildWwBuildInfo(),
  remote = {},
  peerLabel = "the other PC",
} = {}) {
  const localBuild = readWwBuildInfo(local);
  const remoteBuild = readWwBuildInfo(remote);
  const installerUrl = normalizeInstallerUrl(
    remoteBuild.installerUrl || localBuild.installerUrl,
    WW_LAN_INSTALLER_URL,
  );
  const label = String(peerLabel || "the other PC").trim() || "the other PC";

  if (remoteBuild.protocolVersion == null) {
    return {
      ok: false,
      code: "ERR_WW_PROTOCOL_VERSION_UNKNOWN",
      message: `WW can't link to ${label} because that build does not advertise a WW protocol version. This PC is WW ${localBuild.appVersion} (protocol ${localBuild.protocolVersion}).${buildInstallGuidance(installerUrl)}`,
      local: localBuild,
      remote: remoteBuild,
      installerUrl,
    };
  }

  if (remoteBuild.protocolVersion !== localBuild.protocolVersion) {
    return {
      ok: false,
      code: "ERR_WW_PROTOCOL_VERSION_MISMATCH",
      message: `WW can't link to ${label} because it speaks WW protocol ${remoteBuild.protocolVersion} and this PC speaks WW protocol ${localBuild.protocolVersion}.${buildInstallGuidance(installerUrl)}`,
      local: localBuild,
      remote: remoteBuild,
      installerUrl,
    };
  }

  if (!remoteBuild.appVersion) {
    return {
      ok: false,
      code: "ERR_WW_APP_VERSION_UNKNOWN",
      message: `WW can't link to ${label} because that build does not advertise its WW app version. This PC is running WW ${localBuild.appVersion}.${buildInstallGuidance(installerUrl)}`,
      local: localBuild,
      remote: remoteBuild,
      installerUrl,
    };
  }

  if (remoteBuild.appVersion !== localBuild.appVersion) {
    return {
      ok: false,
      code: "ERR_WW_APP_VERSION_MISMATCH",
      message: `WW can't link to ${label} because it is running WW ${remoteBuild.appVersion} and this PC is running WW ${localBuild.appVersion}.${buildInstallGuidance(installerUrl)}`,
      local: localBuild,
      remote: remoteBuild,
      installerUrl,
    };
  }

  return {
    ok: true,
    code: null,
    message: "",
    local: localBuild,
    remote: remoteBuild,
    installerUrl,
  };
}

export function createWwCompatibilityError(options = {}) {
  const compatibility = assessWwCompatibility(options);
  if (compatibility.ok) {
    return null;
  }

  const error = new Error(compatibility.message);
  error.code = compatibility.code;
  error.status = 409;
  error.compatibility = compatibility;
  return error;
}
