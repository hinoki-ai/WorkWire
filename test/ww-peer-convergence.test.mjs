import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConvergedPeerConfig,
  parseConvergeArgs,
} from "../scripts/converge-ww-peer.mjs";

const current = {
  ui: { remotePath: "", showHidden: false, conflictPolicy: "rename" },
  service: {
    name: "old-name",
    machineId: "local_machine_1234",
    token: "old-token-old-token-old-token",
  },
  peer: {},
  recentPeers: [{ host: "10.0.0.9", port: 4851, machineId: "old_peer_machine_9" }],
};

test("peer convergence preserves local identity and converges both token directions", () => {
  const next = buildConvergedPeerConfig(current, {
    token: "new_token_abcdefghijklmnopqrstuvwxyz",
    expectedServiceId: "local_machine_1234",
    serviceName: "HINOKI",
    peerLabel: "Sakura",
    peerHost: "192.168.8.100",
    peerMachineId: "remote_machine_5678",
    peerRoot: "C:\\Users\\Sakura\\WorkWire",
  });
  assert.equal(next.service.machineId, "local_machine_1234");
  assert.equal(next.service.token, "new_token_abcdefghijklmnopqrstuvwxyz");
  assert.equal(next.peer.token, next.service.token);
  assert.equal(next.peer.machineId, "remote_machine_5678");
  assert.equal(next.peer.host, "192.168.8.100");
  assert.equal(next.ui.remotePath, "C:\\Users\\Sakura\\WorkWire");
  assert.equal(next.recentPeers[0].machineId, "remote_machine_5678");
  assert.equal(current.service.token, "old-token-old-token-old-token");
});

test("peer convergence refuses an ambiguous config namespace", () => {
  assert.throws(() => buildConvergedPeerConfig(current, {
    token: "new_token_abcdefghijklmnopqrstuvwxyz",
    expectedServiceId: "another_machine_0000",
    serviceName: "HINOKI",
    peerLabel: "Sakura",
    peerHost: "192.168.8.100",
    peerMachineId: "remote_machine_5678",
    peerRoot: "C:\\Users\\Sakura\\WorkWire",
  }), (error) => error.code === "ERR_WW_WRONG_CONFIG_NAMESPACE");
});

test("peer convergence argv parser preserves Windows paths and consumes secrets only explicitly", () => {
  assert.deepEqual(parseConvergeArgs([
    "--portal", "C:\\Users\\Sakura\\WorkWire",
    "--token-file", "C:\\ProgramData\\WorkWire\\pairing.token",
    "--consume-token-file",
  ]), {
    portal: "C:\\Users\\Sakura\\WorkWire",
    "token-file": "C:\\ProgramData\\WorkWire\\pairing.token",
    "consume-token-file": true,
  });
});
