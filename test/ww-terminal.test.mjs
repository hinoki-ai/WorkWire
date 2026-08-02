import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createWwTerminalAnimator,
  createWwTerminalFormatter,
  resolveWwTerminalMode,
  sanitiseWwTerminalText,
  visibleWwTerminalWidth,
  WW_TERMINAL_ANIMATIONS,
  WW_TERMINAL_ASTERISK_STAGES,
  WW_TERMINAL_COLORS,
  WW_TERMINAL_PALETTE,
} from "../lib/ww-terminal.mjs";

const stripAnsi = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

function captureStream({ isTTY = true, columns = 80 } = {}) {
  const writes = [];
  return {
    isTTY,
    columns,
    writes,
    write(value) {
      writes.push(String(value));
    },
  };
}

test("WorkWire service console uses the ARAMAC palette, canonical identity, and machine line", () => {
  const formatter = createWwTerminalFormatter({
    stream: captureStream({ columns: 80 }),
    title: "Sakura",
    version: "1.2.3",
    env: { TERM: "xterm-256color" },
  });

  const output = formatter.format("WW service ready for Sakura");
  const plain = stripAnsi(output);
  const rows = plain.split("\n");

  assert.match(output, new RegExp(WW_TERMINAL_COLORS.coral.replace(/[\[\]]/g, "\\$&")));
  assert.match(output, /\u001b\[38;5;183m/);
  assert.match(plain, /ARAMAC - WORKWIRE - v1\.2\.3/);
  assert.match(plain, /SAKURA SERVICE CONSOLE/);
  assert.match(plain, /WW service ready for Sakura/);
  assert.equal(formatter.innerWidth, 74);
  assert.equal(rows.every((row) => visibleWwTerminalWidth(row) <= 80), true);

  const error = formatter.format("WW service failed to start");
  assert.match(error, /\u001b\[38;5;203m/);
  assert.match(error, /\u001b\[38;5;252m/);
  assert.match(output, /\u001b\[38;5;246m/);
});

test("WorkWire panels remain width-safe at 80 and 120 columns", () => {
  for (const columns of [80, 120]) {
    const formatter = createWwTerminalFormatter({
      stream: captureStream({ columns }),
      title: "HINOKI",
      version: "0.1.0",
      env: { TERM: "xterm-256color" },
    });
    const output = formatter.format("WW service listening on http://127.0.0.1:4851");
    assert.equal(formatter.innerWidth, columns - 6);
    assert.equal(stripAnsi(output).split("\n").every((row) => visibleWwTerminalWidth(row) <= columns), true);
  }
});

test("WorkWire panels stay symmetrically centered on odd terminal widths", () => {
  const formatter = createWwTerminalFormatter({
    stream: captureStream({ columns: 127 }),
    title: "HINOKI",
    version: "0.1.0",
    env: { TERM: "xterm-256color" },
  });
  const rows = stripAnsi(formatter.format("WW service ready for HINOKI")).split("\n");
  assert.equal(formatter.innerWidth, 119);
  assert.equal(rows[0].indexOf("╔"), 4);
  assert.equal(rows[0].indexOf("╗"), 122);
});

test("Unicode rendering uses stable box and lifecycle glyphs", () => {
  const formatter = createWwTerminalFormatter({
    stream: captureStream({ columns: 80 }),
    title: "HINOKI",
    version: "0.1.0",
    env: { TERM: "xterm-256color" },
  });
  const output = formatter.format("WW service listening on 127.0.0.1:4851");
  assert.equal(formatter.unicode, true);
  const plain = stripAnsi(output);
  assert.match(plain, /╔[═]+╗/);
  assert.match(plain, /→ WW service listening/);
});

test("NO_COLOR, TERM=dumb, and WW_UNICODE=0 use plain ASCII geometry", () => {
  for (const env of [
    { NO_COLOR: "1", TERM: "xterm-256color" },
    { TERM: "dumb" },
    { TERM: "xterm-256color", WW_UNICODE: "0" },
  ]) {
    const formatter = createWwTerminalFormatter({
      stream: captureStream({ columns: 80 }),
      title: "Sakura",
      version: "0.1.0",
      env,
    });
    const output = formatter.format("WW service ready for Sakura");
    assert.equal(formatter.color, env.NO_COLOR || env.TERM === "dumb" || env.WW_UNICODE === "0" ? false : true);
    assert.equal(formatter.unicode, false);
    assert.doesNotMatch(output, /\u001b\[/);
    assert.match(output, /\+[-=]+\+/);
    assert.match(output, /\|  \[OK\] WW service ready for Sakura/);
  }
});

test("redirected output stays plain and never captures animation frames", () => {
  const stream = captureStream({ isTTY: false, columns: 80 });
  const formatter = createWwTerminalFormatter({
    stream,
    title: "HINOKI",
    version: "0.1.0",
    env: { TERM: "xterm-256color", WW_ANIMATION: "on" },
  });
  assert.equal(resolveWwTerminalMode({ stream, env: { WW_ANIMATION: "on" } }).animation, false);
  assert.equal(formatter.animationEnabled, false);
  assert.equal(formatter.format("WW service listening on 127.0.0.1:4851"), "WW service listening on 127.0.0.1:4851");
  assert.deepEqual(stream.writes, []);
});

test("animation on/off is TTY-only and every registered frame is bounded", () => {
  const stream = captureStream({ columns: 80 });
  let nextTimer = 0;
  const pending = new Set();
  const formatter = createWwTerminalFormatter({
    stream,
    env: { TERM: "xterm-256color", WW_ANIMATION: "on" },
    setTimeoutImpl(callback) {
      const timer = ++nextTimer;
      pending.add(timer);
      void callback;
      return timer;
    },
    clearTimeoutImpl(timer) {
      pending.delete(timer);
    },
  });
  assert.equal(formatter.animationEnabled, true);
  assert.equal(formatter.animate("asterisk", { label: "thinking" }), true);
  assert.equal(formatter.stopAnimation(), true);
  assert.equal(pending.size, 0);
  assert.match(stream.writes.join(""), /\u001b\[2K\r/);

  const off = createWwTerminalFormatter({
    stream: captureStream({ columns: 80 }),
    env: { TERM: "xterm-256color", WW_ANIMATION: "off" },
  });
  assert.equal(off.animationEnabled, false);
  assert.equal(off.animate("pulse", { label: "sync" }), false);

  for (const definition of Object.values(WW_TERMINAL_ANIMATIONS)) {
    for (const frame of definition.frames) {
      assert.equal(visibleWwTerminalWidth(frame) <= 80, true);
    }
  }
  assert.deepEqual([...WW_TERMINAL_ASTERISK_STAGES], ["·", "✢", "*", "✶", "✻", "✽"]);
});

test("animation termination clears timers and responds to SIGINT/SIGTERM", () => {
  const stream = captureStream({ columns: 80 });
  const processLike = new EventEmitter();
  const pending = new Set();
  const animator = createWwTerminalAnimator({
    stream,
    env: { TERM: "xterm-256color", WW_ANIMATION: "on" },
    setTimeoutImpl(callback) {
      const timer = pending.size + 1;
      pending.add(timer);
      void callback;
      return timer;
    },
    clearTimeoutImpl(timer) {
      pending.delete(timer);
    },
  });
  assert.equal(animator.bindSignals(processLike), true);
  assert.equal(animator.start("pulse", { label: "sync" }), true);
  processLike.emit("SIGINT");
  assert.equal(animator.active, false);
  assert.equal(pending.size, 0);
  assert.equal(stream.writes.at(-1), "\u001b[2K\r");
});

test("terminal text redacts sensitive assignments before display or logging", () => {
  assert.equal(
    sanitiseWwTerminalText("Config: token=secret-value password=hunter2"),
    "Config: token=[REDACTED] password=[REDACTED]",
  );
});
