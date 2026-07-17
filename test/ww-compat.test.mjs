import test from "node:test";
import assert from "node:assert/strict";
import {
  assessWwCompatibility,
  buildWwBuildInfo,
  createWwCompatibilityError,
} from "../lib/ww-compat.mjs";

test("ww compatibility accepts matching app and protocol versions", () => {
  const local = buildWwBuildInfo({
    protocolVersion: 1,
    appVersion: "0.1.0",
    installerUrl: "http://192.168.8.44:8765/",
  });

  const compatibility = assessWwCompatibility({
    local,
    remote: {
      versions: {
        protocol: 1,
        app: "0.1.0",
      },
      installerUrl: "http://192.168.8.44:8765/",
    },
    peerLabel: "Office PC",
  });

  assert.equal(compatibility.ok, true);
  assert.equal(compatibility.code, null);
});

test("ww compatibility reports protocol and app version mismatches with installer guidance", () => {
  const protocolMismatch = assessWwCompatibility({
    local: {
      versions: {
        protocol: 1,
        app: "0.1.0",
      },
      installerUrl: "http://192.168.8.44:8765/",
    },
    remote: {
      versions: {
        protocol: 2,
        app: "0.1.0",
      },
      installerUrl: "http://192.168.8.44:8765/",
    },
    peerLabel: "Office PC",
  });

  assert.equal(protocolMismatch.ok, false);
  assert.equal(protocolMismatch.code, "ERR_WW_PROTOCOL_VERSION_MISMATCH");
  assert.match(protocolMismatch.message, /Office PC/);
  assert.match(protocolMismatch.message, /protocol 2/);
  assert.match(protocolMismatch.message, /protocol 1/);
  assert.match(protocolMismatch.message, /http:\/\/192\.168\.8\.44:8765\//);

  const appMismatch = createWwCompatibilityError({
    local: {
      versions: {
        protocol: 1,
        app: "0.1.0",
      },
      installerUrl: "http://192.168.8.44:8765/",
    },
    remote: {
      versions: {
        protocol: 1,
        app: "0.2.0",
      },
      installerUrl: "http://192.168.8.44:8765/",
    },
    peerLabel: "Office PC",
  });

  assert.equal(appMismatch?.code, "ERR_WW_APP_VERSION_MISMATCH");
  assert.equal(appMismatch?.status, 409);
  assert.match(appMismatch?.message || "", /running WW 0\.2\.0/);
  assert.match(appMismatch?.message || "", /running WW 0\.1\.0/);
});
