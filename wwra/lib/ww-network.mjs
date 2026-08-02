import os from "node:os";

const NON_USER_INTERFACE_PATTERNS = [
  /^anpi/i,
  /^awdl/i,
  /^br-/i,
  /^bridge/i,
  /^docker\d*$/i,
  /^gif/i,
  /^ham\d*$/i,
  /^ifb\d*$/i,
  /^llw/i,
  /^lo\d*$/i,
  /^stf/i,
  /^tap\d*$/i,
  /^tailscale/i,
  /^tun\d*$/i,
  /^utun\d*$/i,
  /^vboxnet/i,
  /^veth/i,
  /^virbr/i,
  /^vEthernet/i,
  /^vmnet/i,
  /^wg\d*$/i,
  /^zt/i,
];
const NON_USER_INTERFACE_TEXT_PATTERNS = [
  /\bbluetooth\b/i,
  /\bbridge\b/i,
  /\bdocker\b/i,
  /\bhyper-v\b/i,
  /\btailscale\b/i,
  /\btunnel\b/i,
  /\bvirtual\b/i,
  /\bvmware\b/i,
  /\bvpn\b/i,
  /\bvbox\b/i,
  /\bwireguard\b/i,
  /\bzerotier\b/i,
];

function normalizeFamily(record = {}) {
  return typeof record?.family === "string"
    ? record.family
    : `IPv${record?.family || ""}`;
}

function isWildcardHost(host = "") {
  const normalized = String(host || "").trim();
  return !normalized || normalized === "0.0.0.0" || normalized === "::";
}

function isIpv4LinkLocal(addressInt) {
  return (addressInt & 0xffff0000) === 0xa9fe0000;
}

function scoreInterfaceName(name = "") {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) {
    return 99;
  }
  if (
    normalized === "ethernet"
    || normalized === "wi-fi"
    || normalized === "wifi"
    || normalized === "wlan"
  ) {
    return 0;
  }
  if (/^(en|eth|eno|ens|enp)/.test(normalized)) {
    return 1;
  }
  if (/^(wl|wlan|wifi)/.test(normalized)) {
    return 2;
  }
  return 10;
}

function scoreAddress(addressInt) {
  if ((addressInt & 0xff000000) === 0x0a000000) {
    return 0;
  }
  if ((addressInt & 0xfff00000) === 0xac100000) {
    return 1;
  }
  if ((addressInt & 0xffff0000) === 0xc0a80000) {
    return 2;
  }
  return 10;
}

function compareAddressStrings(left = "", right = "") {
  const leftValue = ipToInt(left);
  const rightValue = ipToInt(right);
  return (leftValue ?? 0) - (rightValue ?? 0);
}

function compareLanInterfaceRecords(left = {}, right = {}) {
  const interfaceScoreDiff = scoreInterfaceName(left.name) - scoreInterfaceName(right.name);
  if (interfaceScoreDiff !== 0) {
    return interfaceScoreDiff;
  }

  const addressScoreDiff = scoreAddress(left.addressInt) - scoreAddress(right.addressInt);
  if (addressScoreDiff !== 0) {
    return addressScoreDiff;
  }

  const nameDiff = String(left.name || "").localeCompare(String(right.name || ""));
  if (nameDiff !== 0) {
    return nameDiff;
  }

  return compareAddressStrings(left.address, right.address);
}

function netmaskToPrefix(netmaskInt = null) {
  if (netmaskInt == null) {
    return null;
  }

  let prefix = 0;
  let encounteredZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const isSet = ((netmaskInt >>> bit) & 1) === 1;
    if (isSet) {
      if (encounteredZero) {
        return null;
      }
      prefix += 1;
      continue;
    }
    encounteredZero = true;
  }

  return prefix;
}

function buildPrefixMask(prefix = 24) {
  const normalizedPrefix = Math.max(0, Math.min(32, Number(prefix) || 0));
  if (normalizedPrefix === 0) {
    return 0;
  }
  return (0xffffffff << (32 - normalizedPrefix)) >>> 0;
}

export function ipToInt(ipAddress = "") {
  const parts = String(ipAddress || "").trim().split(".");
  if (parts.length !== 4) {
    return null;
  }

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = ((value << 8) | octet) >>> 0;
  }

  return value >>> 0;
}

export function intToIp(value = 0) {
  const normalized = Number(value) >>> 0;
  return [
    (normalized >>> 24) & 255,
    (normalized >>> 16) & 255,
    (normalized >>> 8) & 255,
    normalized & 255,
  ].join(".");
}

export function normalizeRemoteAddress(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized === "::1") {
    return "127.0.0.1";
  }
  if (normalized.startsWith("::ffff:")) {
    return normalized.slice("::ffff:".length);
  }
  return normalized;
}

export function isLikelyUserLanInterface(name = "") {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return false;
  }

  if (NON_USER_INTERFACE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (NON_USER_INTERFACE_TEXT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return true;
}

export function collectLanInterfaceRecords({
  networkInterfaces = os.networkInterfaces(),
  includeNonUserInterfaces = false,
  includeLinkLocal = false,
} = {}) {
  const records = [];

  for (const [name, interfaceRecords] of Object.entries(networkInterfaces || {})) {
    if (!includeNonUserInterfaces && !isLikelyUserLanInterface(name)) {
      continue;
    }

    for (const record of interfaceRecords || []) {
      if (record?.internal || normalizeFamily(record) !== "IPv4") {
        continue;
      }

      const address = normalizeRemoteAddress(record.address);
      const netmask = normalizeRemoteAddress(record.netmask);
      const addressInt = ipToInt(address);
      const netmaskInt = ipToInt(netmask);
      const prefix = netmaskToPrefix(netmaskInt);
      if (!address || !netmask || addressInt == null || netmaskInt == null || prefix == null) {
        continue;
      }
      if (!includeLinkLocal && isIpv4LinkLocal(addressInt)) {
        continue;
      }

      records.push({
        name,
        address,
        netmask,
        addressInt,
        netmaskInt,
        prefix,
        network: addressInt & netmaskInt,
        broadcast: (addressInt | ((~netmaskInt) >>> 0)) >>> 0,
      });
    }
  }

  return records.sort(compareLanInterfaceRecords);
}

export function collectLanBroadcastTargets({
  networkInterfaces = os.networkInterfaces(),
  includeNonUserInterfaces = false,
  includeGlobalBroadcast = true,
} = {}) {
  const interfaceRecords = collectLanInterfaceRecords({
    networkInterfaces,
    includeNonUserInterfaces,
  });
  if (interfaceRecords.length === 0) {
    return [];
  }

  const targets = new Set(
    interfaceRecords.map((record) => intToIp(record.broadcast)),
  );
  if (includeGlobalBroadcast) {
    targets.add("255.255.255.255");
  }

  return [...targets].sort(compareAddressStrings);
}

export function collectLanDiscoveryHosts({
  networkInterfaces = os.networkInterfaces(),
  localAddresses = [],
  includeNonUserInterfaces = false,
} = {}) {
  const excludedHosts = new Set(
    (Array.isArray(localAddresses) ? localAddresses : [])
      .map((value) => normalizeRemoteAddress(value))
      .filter((value) => value.includes(".") && ipToInt(value) != null),
  );
  const hosts = new Set();

  for (const record of collectLanInterfaceRecords({
    networkInterfaces,
    includeNonUserInterfaces,
  })) {
    const effectivePrefix = record.prefix < 24 ? 24 : record.prefix;
    if (effectivePrefix >= 31) {
      continue;
    }

    const mask = buildPrefixMask(effectivePrefix);
    const network = record.addressInt & mask;
    const broadcast = network | ((~mask) >>> 0);
    for (let value = network + 1; value < broadcast; value += 1) {
      const host = intToIp(value);
      if (host !== record.address && !excludedHosts.has(host)) {
        hosts.add(host);
      }
    }
  }

  return [...hosts].sort(compareAddressStrings);
}

export function selectReachableLanAddressForPeer(peerHost = "", {
  networkInterfaces = os.networkInterfaces(),
  includeNonUserInterfaces = false,
} = {}) {
  const interfaceRecords = collectLanInterfaceRecords({
    networkInterfaces,
    includeNonUserInterfaces,
  });
  if (interfaceRecords.length === 0) {
    return "";
  }

  const peerAddress = normalizeRemoteAddress(peerHost);
  const peerAddressInt = ipToInt(peerAddress);
  if (peerAddressInt != null) {
    for (const record of interfaceRecords) {
      if ((peerAddressInt & record.netmaskInt) === record.network) {
        return record.address;
      }
    }
  }

  return interfaceRecords[0].address;
}

export function resolveAdvertisedHost(host = "", {
  networkInterfaces = os.networkInterfaces(),
  includeNonUserInterfaces = false,
} = {}) {
  const normalizedHost = normalizeRemoteAddress(host);
  if (!isWildcardHost(normalizedHost)) {
    return normalizedHost;
  }

  return selectReachableLanAddressForPeer("", {
    networkInterfaces,
    includeNonUserInterfaces,
  }) || "127.0.0.1";
}
