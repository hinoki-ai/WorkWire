import test from "node:test";
import assert from "node:assert/strict";
import { ipToInt, selectReachableLanAddressForPeer } from "../lib/ww-network.mjs";

test("ww network rejects malformed IPv4 octets", () => {
  assert.equal(ipToInt("192.168.1x.5"), null);
  assert.equal(ipToInt("192.168.001.5"), 0xc0a80105);
  assert.equal(ipToInt("192.168.1.256"), null);
});

test("ww network selects the same-subnet user LAN address for a peer", () => {
  const address = selectReachableLanAddressForPeer("192.168.8.44", {
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

  assert.equal(address, "192.168.8.50");
});
