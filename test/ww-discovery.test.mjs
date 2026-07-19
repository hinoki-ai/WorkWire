import test from "node:test";
import assert from "node:assert/strict";
import {
  WW_APP_VERSION,
  WW_LAN_INSTALLER_URL,
  WW_PROTOCOL_VERSION,
} from "../lib/ww-compat.mjs";
import { discoverLanPeers, enumerateLanDiscoveryHosts } from "../lib/ww-discovery.mjs";
import { WW_UPDATE_PROTOCOL_VERSION } from "../lib/ww-update.mjs";

test("ww discovery enumerates the local /24 while excluding this machine", () => {
  const hosts = enumerateLanDiscoveryHosts({
    networkInterfaces: {
      eno1: [
        {
          address: "192.168.8.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
        },
      ],
    },
  });

  assert.equal(hosts[0], "192.168.8.1");
  assert.equal(hosts.at(-1), "192.168.8.254");
  assert.equal(hosts.includes("192.168.8.50"), false);
  assert.equal(hosts.length, 253);
});

test("ww discovery ignores non-user interfaces by default", () => {
  const hosts = enumerateLanDiscoveryHosts({
    networkInterfaces: {
      docker0: [
        {
          address: "172.17.0.1",
          family: "IPv4",
          internal: false,
          netmask: "255.255.0.0",
        },
      ],
      eno1: [
        {
          address: "192.168.8.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
        },
      ],
    },
  });

  assert.equal(hosts[0], "192.168.8.1");
  assert.equal(hosts.at(-1), "192.168.8.254");
  assert.equal(hosts.includes("172.17.0.2"), false);
  assert.equal(hosts.length, 253);
});

test("ww discovery keeps only reachable WW peers from scan responses", async () => {
  const peers = await discoverLanPeers({
    port: 4851,
    localAddresses: ["192.168.8.102"],
    networkInterfaces: {
      eno1: [
        {
          address: "192.168.8.102",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.252",
        },
      ],
    },
    fetchImpl: async (url) => {
      const target = new URL(url).hostname;
      assert.equal(new URL(url).searchParams.get("protocolVersion"), String(WW_PROTOCOL_VERSION));
      assert.equal(new URL(url).searchParams.get("appVersion"), WW_APP_VERSION);
      assert.equal(new URL(url).searchParams.get("installerUrl"), WW_LAN_INSTALLER_URL);
      if (target === "192.168.8.101") {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              service: {
                name: "Office PC",
                port: 4851,
                machineId: "office-machine",
                versions: {
                  protocol: WW_PROTOCOL_VERSION,
                  app: WW_APP_VERSION,
                },
                installerUrl: WW_LAN_INSTALLER_URL,
                trustId: "deployment-trust",
                capabilities: {
                  launchDesktop: true,
                },
              },
            };
          },
        };
      }

      return {
        ok: false,
        async json() {
          return {};
        },
      };
    },
  });

  assert.deepEqual(peers, [
    {
      host: "192.168.8.101",
      port: 4851,
      label: "Office PC",
      machineId: "office-machine",
      trustId: "deployment-trust",
      updateCompatibility: {
        ok: true,
        code: null,
        message: "",
        localVersion: WW_UPDATE_PROTOCOL_VERSION,
        remoteVersion: WW_UPDATE_PROTOCOL_VERSION,
      },
      compatibility: {
        ok: true,
        code: null,
        message: "",
        local: {
          protocolVersion: WW_PROTOCOL_VERSION,
          appVersion: WW_APP_VERSION,
          installerUrl: WW_LAN_INSTALLER_URL,
        },
        remote: {
          protocolVersion: WW_PROTOCOL_VERSION,
          appVersion: WW_APP_VERSION,
          installerUrl: WW_LAN_INSTALLER_URL,
        },
        installerUrl: WW_LAN_INSTALLER_URL,
      },
      info: {
        name: "Office PC",
        host: "192.168.8.101",
        port: 4851,
        machineId: "office-machine",
        trustId: "deployment-trust",
        versions: {
          protocol: WW_PROTOCOL_VERSION,
          app: WW_APP_VERSION,
        },
        installerUrl: WW_LAN_INSTALLER_URL,
        capabilities: {
          launchDesktop: true,
          updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
          downloadUpdate: false,
        },
        updateCompatibility: {
          ok: true,
          code: null,
          message: "",
          localVersion: WW_UPDATE_PROTOCOL_VERSION,
          remoteVersion: WW_UPDATE_PROTOCOL_VERSION,
        },
        compatibility: {
          ok: true,
          code: null,
          message: "",
          local: {
            protocolVersion: WW_PROTOCOL_VERSION,
            appVersion: WW_APP_VERSION,
            installerUrl: WW_LAN_INSTALLER_URL,
          },
          remote: {
            protocolVersion: WW_PROTOCOL_VERSION,
            appVersion: WW_APP_VERSION,
            installerUrl: WW_LAN_INSTALLER_URL,
          },
          installerUrl: WW_LAN_INSTALLER_URL,
        },
        source: "discover",
      },
    },
  ]);
});

test("ww discovery advertises local build info and preserves compatibility metadata", async () => {
  let discoveryUrl = null;

  const peers = await discoverLanPeers({
    port: 4851,
    localAddresses: ["192.168.8.50"],
    networkInterfaces: {
      eno1: [
        {
          address: "192.168.8.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.252",
        },
      ],
    },
    fetchImpl: async (url) => {
      discoveryUrl = new URL(url);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            service: {
              name: "Office PC",
              host: "192.168.8.101",
              port: 4851,
              machineId: "office-machine",
              trustId: "deployment-trust",
              versions: {
                protocol: 2,
                app: "9.9.9",
              },
              installerUrl: "http://192.168.8.44:8765/",
              capabilities: {
                launchDesktop: true,
              },
            },
            compatibility: {
              ok: false,
              code: "ERR_WW_APP_VERSION_MISMATCH",
              message: "install the same build",
            },
          };
        },
      };
    },
  });

  assert.equal(discoveryUrl?.searchParams.has("protocolVersion"), true);
  assert.equal(discoveryUrl?.searchParams.has("appVersion"), true);
  assert.equal(discoveryUrl?.searchParams.has("installerUrl"), true);
  assert.equal(Object.hasOwn(peers[0], "token"), false);
  assert.equal(Object.hasOwn(peers[0].info, "rootPath"), false);
  assert.deepEqual(peers[0].compatibility, {
    ok: false,
    code: "ERR_WW_APP_VERSION_MISMATCH",
    message: "install the same build",
  });
  assert.deepEqual(peers[0].info.versions, {
    protocol: 2,
    app: "9.9.9",
  });
  assert.equal(peers[0].info.installerUrl, "http://192.168.8.44:8765/");
});

test("ww discovery deduplicates the same machine across DHCP host changes", async () => {
  const peers = await discoverLanPeers({
    port: 4851,
    localAddresses: ["192.168.8.50"],
    networkInterfaces: {
      eno1: [
        {
          address: "192.168.8.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.252",
        },
      ],
      wlan0: [
        {
          address: "10.0.0.20",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.252",
        },
      ],
    },
    fetchImpl: async (url) => {
      const target = new URL(url).hostname;
      if (target === "192.168.8.101" || target === "10.0.0.21") {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              service: {
                name: "Office PC",
                port: 4851,
                machineId: "office-machine",
                trustId: "deployment-trust",
                versions: {
                  protocol: WW_PROTOCOL_VERSION,
                  app: WW_APP_VERSION,
                },
                installerUrl: WW_LAN_INSTALLER_URL,
              },
            };
          },
        };
      }

      return {
        ok: false,
        async json() {
          return {};
        },
      };
    },
  });

  assert.equal(peers.length, 1);
  assert.equal(peers[0].machineId, "office-machine");
});
