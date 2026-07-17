import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPeerLaunchSuppression,
  buildWwLaunchIntent,
  parseWwDesktopFlags,
  peerLaunchSuppressionMatches,
} from "../lib/ww-launch-intent.mjs";

test("ww launch intent parser keeps only desktop flags", () => {
  const flags = parseWwDesktopFlags([
    "/usr/bin/node",
    "/tmp/WorkWire/desktop/ww-main.cjs",
    "--service-host",
    "127.0.0.1",
    "--service-port",
    "4851",
    "--service-token",
    "local-token",
    "--peer",
    "fileserver:5120",
    "--remote-path",
    "/srv/archive",
    "--hidden",
  ]);

  assert.deepEqual(flags, {
    "service-host": "127.0.0.1",
    "service-port": "4851",
    "service-token": "local-token",
    peer: "fileserver:5120",
    "remote-path": "/srv/archive",
    hidden: true,
  });
});

test("ww launch intent captures peer relink state", () => {
  const intent = buildWwLaunchIntent({
    "service-host": "127.0.0.1",
    "service-port": "4851",
    "service-token": "local-token",
    peer: "fileserver:5120",
    "peer-machine-id": "peer-machine",
    token: "peer-token",
    name: "Fileserver",
    local: "/srv/local/projects",
    "remote-path": "/srv/remote/archive",
    hidden: true,
    "skip-peer-launch": true,
  });

  assert.deepEqual(intent, {
    showHidden: true,
    skipPeerLaunch: true,
    localPath: "/srv/local/projects",
    remotePath: "/srv/remote/archive",
    service: {
      host: "127.0.0.1",
      port: 4851,
      token: "local-token",
    },
    peer: {
      host: "fileserver",
      port: 5120,
      machineId: "peer-machine",
      token: "peer-token",
      label: "Fileserver",
    },
  });
});

test("ww peer launch suppression only arms for skip-peer-launch handoffs", () => {
  assert.equal(buildPeerLaunchSuppression(buildWwLaunchIntent({})), null);

  assert.deepEqual(
    buildPeerLaunchSuppression(buildWwLaunchIntent({
      peer: "192.168.1.24:4851",
      "peer-machine-id": "peer-machine",
      token: "peer-token",
      "skip-peer-launch": true,
    })),
    {
      host: "192.168.1.24",
      port: 4851,
      token: "peer-token",
    },
  );
});

test("ww peer launch suppression matches the intended peer only", () => {
  const suppression = {
    host: "192.168.1.24",
    port: 4851,
    token: "peer-token",
  };

  assert.equal(peerLaunchSuppressionMatches(suppression, {
    host: "192.168.1.24",
    port: 4851,
    token: "peer-token",
  }), true);
  assert.equal(peerLaunchSuppressionMatches(suppression, {
    host: "192.168.1.24",
    port: 4851,
    token: "other-token",
  }), false);
  assert.equal(peerLaunchSuppressionMatches(suppression, {
    host: "192.168.1.25",
    port: 4851,
    token: "peer-token",
  }), false);
  assert.equal(peerLaunchSuppressionMatches({
    host: "192.168.1.24",
    port: 4851,
    token: "",
  }, {
    host: "192.168.1.24",
    port: 4851,
    token: "other-token",
  }), true);
});
