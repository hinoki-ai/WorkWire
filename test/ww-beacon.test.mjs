import test from "node:test";
import assert from "node:assert/strict";
import {
  WW_APP_VERSION,
  WW_LAN_INSTALLER_URL,
  WW_PROTOCOL_VERSION,
} from "../lib/ww-compat.mjs";
import {
  WW_BEACON_VERSION,
  collectLanBeaconTargets,
  normalizeLanBeaconPayload,
} from "../lib/ww-beacon.mjs";
import { WW_UPDATE_PROTOCOL_VERSION } from "../lib/ww-update.mjs";

test("ww beacon computes LAN broadcast targets plus global broadcast", () => {
  const targets = collectLanBeaconTargets({
    networkInterfaces: {
      eno1: [
        {
          address: "192.168.8.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
        },
      ],
      wlan0: [
        {
          address: "10.0.0.12",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
        },
      ],
    },
  });

  assert.deepEqual(targets.sort(), [
    "10.0.0.255",
    "192.168.8.255",
    "255.255.255.255",
  ]);
});

test("ww beacon ignores non-user interfaces by default", () => {
  const targets = collectLanBeaconTargets({
    networkInterfaces: {
      docker0: [
        {
          address: "172.17.0.1",
          family: "IPv4",
          internal: false,
          netmask: "255.255.0.0",
        },
      ],
      wlan0: [
        {
          address: "192.168.8.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
        },
      ],
    },
  });

  assert.deepEqual(targets, [
    "192.168.8.255",
    "255.255.255.255",
  ]);
});

test("ww beacon normalizes a received peer payload", () => {
  const peer = normalizeLanBeaconPayload({
    kind: "ww-beacon",
    name: "Office PC",
    version: WW_BEACON_VERSION,
    versions: {
      protocol: WW_PROTOCOL_VERSION,
      app: WW_APP_VERSION,
    },
    installerUrl: WW_LAN_INSTALLER_URL,
    port: 4851,
    machineId: "peer-machine-id",
    trustId: "deployment-trust",
    canLaunchDesktop: true,
  }, {
    address: "::ffff:192.168.8.104",
  });

  assert.equal(peer.host, "192.168.8.104");
  assert.equal(peer.port, 4851);
  assert.equal(peer.label, "Office PC");
  assert.equal(peer.machineId, "peer-machine-id");
  assert.equal(peer.trustId, "deployment-trust");
  assert.equal(peer.compatibility.ok, true);
  assert.equal(peer.updateCompatibility.ok, true);
  assert.equal(peer.info.capabilities.launchDesktop, true);
  assert.equal(peer.info.capabilities.updateProtocol, WW_UPDATE_PROTOCOL_VERSION);
  assert.equal(peer.info.machineId, "peer-machine-id");
  assert.equal(peer.info.trustId, "deployment-trust");
  assert.equal(peer.info.versions.protocol, WW_PROTOCOL_VERSION);
  assert.equal(peer.info.versions.app, WW_APP_VERSION);
  assert.equal(peer.info.installerUrl, WW_LAN_INSTALLER_URL);
  assert.equal(Object.hasOwn(peer, "token"), false);
  assert.equal(String(peer.remotePath || ""), "");
});

test("ww beacon keeps update discovery alive when desktop protocols differ", () => {
  const peer = normalizeLanBeaconPayload({
    kind: "ww-beacon",
    version: WW_BEACON_VERSION,
    name: "Future PC",
    versions: {
      protocol: 999,
      app: "future-app",
    },
    updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
    port: 4851,
    machineId: "future-machine",
  }, {
    address: "192.168.8.105",
  });

  assert.equal(peer.compatibility.ok, false);
  assert.equal(peer.updateCompatibility.ok, true);
  assert.equal(peer.info.capabilities.updateProtocol, WW_UPDATE_PROTOCOL_VERSION);
});

test("ww beacon ignores incompatible beacon envelope versions", () => {
  const peer = normalizeLanBeaconPayload({
    kind: "ww-beacon",
    version: 99,
    name: "Office PC",
    port: 4851,
  }, {
    address: "192.168.8.104",
  });

  assert.equal(peer, null);
});
