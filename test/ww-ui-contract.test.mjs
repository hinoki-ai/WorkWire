import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await fs.readFile(new URL("../desktop/ww/index.html", import.meta.url), "utf8");
const rendererSource = await fs.readFile(new URL("../desktop/ww/renderer.js", import.meta.url), "utf8");
const stylesSource = await fs.readFile(new URL("../desktop/ww/styles.css", import.meta.url), "utf8");
const mainSource = await fs.readFile(new URL("../desktop/ww-main.mjs", import.meta.url), "utf8");

test("ww desktop shell exposes the two-pane workspace with a narrow center action rail", () => {
  const dom = new JSDOM(html);
  const { document } = dom.window;

  assert.ok(document.querySelector(".workspace"));
  assert.ok(document.querySelector(".action-rail"));
  assert.ok(document.getElementById("local-pane"));
  assert.ok(document.getElementById("remote-pane"));
  assert.ok(document.getElementById("auto-link"));
  assert.ok(document.getElementById("action-summary"));
  assert.ok(document.getElementById("local-path-value"));
  assert.ok(document.getElementById("remote-path-value"));
  assert.ok(document.getElementById("local-filter"));
  assert.ok(document.getElementById("remote-filter"));
  assert.ok(document.getElementById("copy-to-other"));
  assert.ok(document.getElementById("move-to-other"));
  assert.ok(document.getElementById("select-local-only"));
  assert.ok(document.getElementById("select-remote-only"));
  assert.ok(document.getElementById("select-different"));
  assert.equal(document.getElementById("service-name")?.textContent?.trim(), "This PC");
  assert.equal(document.getElementById("peer-name")?.textContent?.trim(), "Waiting");
  assert.equal(document.querySelector(".topbar"), null);
  assert.equal(document.getElementById("notification-list"), null);
  assert.equal(document.getElementById("modal-layer"), null);
  assert.equal(document.getElementById("create-form"), null);
  assert.equal(document.getElementById("rename-form"), null);
  assert.equal(document.getElementById("delete-form"), null);
  assert.equal(document.getElementById("transfer-form"), null);
  assert.equal(document.querySelector(".hero"), null);
  assert.equal(document.querySelector(".status-grid"), null);
  assert.equal(document.querySelector(".insight-grid"), null);
  assert.equal(document.getElementById("connect-form"), null);
  assert.equal(document.getElementById("remote-connect"), null);
});

test("ww renderer keeps dual-pane compare, auto-link, and keyboard behaviors without modal flow", () => {
  assert.match(rendererSource, /function diffStatus/);
  assert.match(rendererSource, /function compareStats/);
  assert.match(rendererSource, /function hasActiveFilter/);
  assert.match(rendererSource, /function bindKeyboardShortcuts/);
  assert.match(rendererSource, /function formatUserFacingError/);
  assert.match(rendererSource, /function remoteStateLabel/);
  assert.match(rendererSource, /refs\.showHidden/);
  assert.match(rendererSource, /refs\.autoLink/);
  assert.match(rendererSource, /api\(\)\.autoLink\(\)/);
  assert.match(rendererSource, /conflictPolicy/);
  assert.match(rendererSource, /transfer/);
  assert.match(rendererSource, /No files match this filter/);
  assert.match(rendererSource, /Drop files into this WorkWire folder/);
  assert.match(rendererSource, /refs\.serviceName\.textContent = "This PC"/);
  assert.match(rendererSource, /refs\.peerName\.textContent = remoteStateLabel\(\)/);
  assert.match(rendererSource, /WW couldn't reach the other PC right now\./);
  assert.match(rendererSource, /Find Again/);
  assert.doesNotMatch(rendererSource, /notificationList/);
  assert.doesNotMatch(rendererSource, /modalLayer/);
  assert.doesNotMatch(rendererSource, /copyRight/);
  assert.doesNotMatch(rendererSource, /connectForm/);
  assert.doesNotMatch(rendererSource, /file-name-sub/);
  assert.doesNotMatch(rendererSource, /Searching LAN/);
  assert.doesNotMatch(rendererSource, /Reconnect/);
  assert.doesNotMatch(rendererSource, /refs\.serviceMeta\.textContent = serviceInfo\.rootPath/);
  assert.doesNotMatch(rendererSource, /\$\{saved\.host\}:\$\{saved\.port\}/);
});

test("ww desk enforces a restrictive content policy and keeps tokens out of renderer state", () => {
  const dom = new JSDOM(html);
  const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || "";
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(rendererSource, /serviceToken/);
  assert.doesNotMatch(rendererSource, /serviceUrls/);
  assert.match(mainSource, /function serializePeer/);
  assert.match(mainSource, /token: _token/);
  assert.doesNotMatch(mainSource, /saved: clone\(config\.peer\)/);
});

test("ww default peer recovery copy stays non-technical even when pairing or version checks fail", () => {
  assert.match(mainSource, /needs the same WorkWire build/);
  assert.match(mainSource, /not the paired Other PC/);
  assert.doesNotMatch(mainSource, /Use the same deployment token on both PCs/);
  assert.doesNotMatch(mainSource, /save an explicit peer token/);
});

test("ww stylesheet defines the simplified workspace rail treatments", () => {
  assert.match(stylesSource, /\.workspace/);
  assert.match(stylesSource, /\.action-rail/);
  assert.match(stylesSource, /\.pane-local/);
  assert.match(stylesSource, /\.pane-remote/);
  assert.match(stylesSource, /\.status-only-local/);
  assert.match(stylesSource, /\.status-only-remote/);
  assert.match(stylesSource, /\.rail-chip/);
  assert.match(stylesSource, /\.inline-message/);
  assert.doesNotMatch(stylesSource, /\.topbar/);
  assert.doesNotMatch(stylesSource, /\.modal-card/);
  assert.doesNotMatch(stylesSource, /\.notification-list/);
});
