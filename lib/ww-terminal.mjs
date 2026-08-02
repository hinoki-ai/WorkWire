// WorkWire's foreground service console follows the ARAMAC master shell
// language without importing a GUI renderer or a terminal UI dependency.

const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI = "\u001b[";
const ERASE_LINE = `${ANSI}2K\r`;

export const WW_TERMINAL_PALETTE = Object.freeze({
  coral: 210,
  lavender: 183,
  error: 203,
  text: 252,
  muted: 246,
});

export const WW_TERMINAL_COLORS = Object.freeze({
  coral: `${ANSI}38;5;${WW_TERMINAL_PALETTE.coral}m`,
  lavender: `${ANSI}38;5;${WW_TERMINAL_PALETTE.lavender}m`,
  error: `${ANSI}38;5;${WW_TERMINAL_PALETTE.error}m`,
  text: `${ANSI}38;5;${WW_TERMINAL_PALETTE.text}m`,
  muted: `${ANSI}38;5;${WW_TERMINAL_PALETTE.muted}m`,
  reset: `${ANSI}0m`,
});

const UNICODE_GLYPHS = Object.freeze({
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  doubleTopLeft: "╔",
  doubleTopRight: "╗",
  doubleBottomLeft: "╚",
  doubleBottomRight: "╝",
  horizontal: "─",
  doubleHorizontal: "═",
  vertical: "│",
  doubleVertical: "║",
  ready: "✓",
  info: "→",
  error: "✖",
  bullet: "•",
});

const ASCII_GLYPHS = Object.freeze({
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  doubleTopLeft: "+",
  doubleTopRight: "+",
  doubleBottomLeft: "+",
  doubleBottomRight: "+",
  horizontal: "-",
  doubleHorizontal: "=",
  vertical: "|",
  doubleVertical: "|",
  ready: "[OK]",
  info: ">",
  error: "[ERR]",
  bullet: "*",
});

// The terminal-safe part of the NEXUS/Hinokode motion vocabulary. The cells
// stay fixed-width so a changing frame never shifts the service label.
export const WW_TERMINAL_ASTERISK_STAGES = Object.freeze(["·", "✢", "*", "✶", "✻", "✽"]);
const THINKER_FRAMES = Object.freeze([
  ...WW_TERMINAL_ASTERISK_STAGES,
  ...[...WW_TERMINAL_ASTERISK_STAGES].reverse(),
]);
const QUADRANT_FRAMES = Object.freeze(["◐", "◓", "◑", "◒"]);
const BRIDGE_FRAMES = Object.freeze(["·|·", "·/·", "·—·", "·\\·"]);
const NEXY_FRAMES = Object.freeze([
  " ▐▛███▜▌ ▝▜   ▛▘",
  " ▐▟███▟▌ ▝▜   ▛▘",
  " ▐▙███▙▌ ▝▜   ▛▘",
  "▗▟▛███▜▙▖  ▜   ▛ ",
]);

const ANIMATION_DEFINITIONS = Object.freeze({
  startup: Object.freeze({
    frames: THINKER_FRAMES,
    durationMs: 480,
    frameMs: 100,
    loop: false,
  }),
  sparkle: Object.freeze({
    frames: Object.freeze(["✦", "✧", "·", "✧"]),
    durationMs: 640,
    frameMs: 120,
    loop: true,
  }),
  twinkle: Object.freeze({
    frames: Object.freeze(["✧", "✦", "✧", "·", ...THINKER_FRAMES.slice(0, 4)]),
    durationMs: 640,
    frameMs: 120,
    loop: true,
  }),
  refresh: Object.freeze({
    frames: Object.freeze(["↻", "⟳", "↻", "⟳"]),
    durationMs: 720,
    frameMs: 120,
    loop: true,
  }),
  sync: Object.freeze({
    frames: Object.freeze(["⇄", "⇆", "⇄", "⇆"]),
    durationMs: 720,
    frameMs: 120,
    loop: true,
  }),
  bot: Object.freeze({
    frames: Object.freeze(["◌", "◎", "◉", "◎"]),
    durationMs: 720,
    frameMs: 140,
    loop: true,
  }),
  assistant: Object.freeze({
    frames: Object.freeze(["◌", "◎", "◌", "◎"]),
    durationMs: 720,
    frameMs: 140,
    loop: true,
  }),
  thinking: Object.freeze({
    frames: Object.freeze(["·  ", "·· ", "···", " ··", "  ·"]),
    durationMs: 720,
    frameMs: 140,
    loop: true,
  }),
  scan: Object.freeze({
    frames: Object.freeze(["▏", "▎", "▍", "▋", "▊", "▉", "█"]),
    durationMs: 840,
    frameMs: 100,
    loop: false,
  }),
  pulse: Object.freeze({
    frames: Object.freeze(["○", "◌", "◍", "●", "◍", "◌", ...QUADRANT_FRAMES]),
    durationMs: 720,
    frameMs: 120,
    loop: true,
  }),
  "status-ready": Object.freeze({
    frames: Object.freeze(["✓", "✓"]),
    durationMs: 240,
    frameMs: 120,
    loop: false,
  }),
  "status-error": Object.freeze({
    frames: Object.freeze(["✖", "✖"]),
    durationMs: 240,
    frameMs: 120,
    loop: false,
  }),
  success: Object.freeze({
    frames: Object.freeze(["·", "✦", "✓"]),
    durationMs: 360,
    frameMs: 120,
    loop: false,
  }),
  failure: Object.freeze({
    frames: Object.freeze(["·", "!", "✖"]),
    durationMs: 360,
    frameMs: 120,
    loop: false,
  }),
  asterisk: Object.freeze({
    frames: THINKER_FRAMES,
    durationMs: 1_152,
    frameMs: 144,
    loop: true,
  }),
  quadrant: Object.freeze({
    frames: QUADRANT_FRAMES,
    durationMs: 400,
    frameMs: 100,
    loop: true,
  }),
  bridge: Object.freeze({
    frames: BRIDGE_FRAMES,
    durationMs: 600,
    frameMs: 150,
    loop: true,
  }),
  nexy: Object.freeze({
    frames: NEXY_FRAMES,
    durationMs: 720,
    frameMs: 60,
    loop: true,
  }),
  blink: Object.freeze({ frames: Object.freeze(["●", "·", "●"]), durationMs: 300, frameMs: 100, loop: false }),
  twist: Object.freeze({ frames: Object.freeze(["✻", "✶", "✽", "✶", "✻"]), durationMs: 700, frameMs: 140, loop: false }),
  draw: Object.freeze({ frames: Object.freeze(["·", "▏", "▎", "▍", "▋", "█"]), durationMs: 550, frameMs: 100, loop: false }),
  "pop-in": Object.freeze({ frames: Object.freeze(["○", "◌", "●"]), durationMs: 550, frameMs: 110, loop: false }),
  sway: Object.freeze({ frames: Object.freeze(["/", "|", "\\", "|"]), durationMs: 750, frameMs: 125, loop: false }),
  flash: Object.freeze({ frames: Object.freeze(["●", "·", "●"]), durationMs: 360, frameMs: 120, loop: false }),
  pop: Object.freeze({ frames: Object.freeze(["○", "●", "○"]), durationMs: 360, frameMs: 120, loop: false }),
  write: Object.freeze({ frames: Object.freeze(["▏", "▎", "▍", "▋", "█"]), durationMs: 650, frameMs: 130, loop: false }),
  turn: Object.freeze({ frames: QUADRANT_FRAMES, durationMs: 800, frameMs: 200, loop: false }),
  spin: Object.freeze({ frames: Object.freeze(["◴", "◷", "◶", "◵"]), durationMs: 900, frameMs: 225, loop: false }),
  grow: Object.freeze({ frames: Object.freeze(["-", "=", "≡"]), durationMs: 300, frameMs: 100, loop: false }),
  lid: Object.freeze({ frames: Object.freeze(["⌜", "╱", "⌝"]), durationMs: 400, frameMs: 130, loop: false }),
  drop: Object.freeze({ frames: Object.freeze(["•", "·", " "]), durationMs: 300, frameMs: 100, loop: false }),
});

export const WW_TERMINAL_ANIMATIONS = ANIMATION_DEFINITIONS;

function stripAnsi(value = "") {
  return String(value).replace(ANSI_ESCAPE_RE, "");
}

function characterWidth(character) {
  if (!character || character === "\u200d" || /[\u0000-\u001f\u007f]/u.test(character)) {
    return 0;
  }
  if (/\p{Mark}/u.test(character)) {
    return 0;
  }
  return /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character)
    ? 2
    : 1;
}

export function visibleWwTerminalWidth(value = "") {
  let width = 0;
  for (const character of stripAnsi(value)) {
    width += characterWidth(character);
  }
  return width;
}

function repeat(character, count) {
  return String(character).repeat(Math.max(0, Number(count) || 0));
}

function truncate(value, width) {
  const source = String(value);
  const limit = Math.max(0, Number(width) || 0);
  let result = "";
  let used = 0;
  let index = 0;
  while (index < source.length) {
    const escape = source.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/u);
    if (escape) {
      result += escape[0];
      index += escape[0].length;
      continue;
    }
    const character = Array.from(source.slice(index))[0];
    const cells = characterWidth(character);
    if (used + cells > limit) break;
    result += character;
    used += cells;
    index += character.length;
  }
  return result;
}

function streamIsTty(stream) {
  return Boolean(stream?.isTTY);
}

function terminalColumns(stream, env) {
  const candidates = [stream?.columns, env?.COLUMNS];
  for (const candidate of candidates) {
    const width = Number(candidate);
    if (Number.isInteger(width) && width >= 8) return width;
  }
  return 80;
}

function hasNoColor(env = {}) {
  return Object.prototype.hasOwnProperty.call(env || {}, "NO_COLOR");
}

function isDumbTerminal(env = {}) {
  return String(env?.TERM || "").toLowerCase() === "dumb";
}

export function resolveWwTerminalMode({ stream, env = process.env } = {}) {
  const interactive = streamIsTty(stream);
  const noColor = hasNoColor(env);
  const dumb = isDumbTerminal(env);
  const unicode = interactive && !noColor && !dumb && env?.WW_UNICODE !== "0";
  const animationSetting = String(env?.WW_ANIMATION || "auto").trim().toLowerCase();
  const animation = interactive
    && !noColor
    && !dumb
    && env?.WW_UNICODE !== "0"
    && animationSetting !== "off";
  return Object.freeze({
    interactive,
    color: interactive && !noColor && !dumb && env?.WW_UNICODE !== "0",
    unicode,
    animation,
    animationSetting: animationSetting === "on" || animationSetting === "off" ? animationSetting : "auto",
  });
}

export function sanitiseWwTerminalText(value = "") {
  return stripAnsi(String(value))
    .replace(/[\r\n]+/gu, " ")
    .replace(/\b(token|password|passphrase|secret|authorization|bearer)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu, "$1=[REDACTED]")
    .trim();
}

function messageTone(message) {
  const lower = String(message).toLowerCase();
  if (/\b(error|failed|failure|unable|unavailable|busy|mismatch|drift)\b/u.test(lower)) {
    return { icon: "error", iconColor: "error" };
  }
  if (/\b(ready|online|success|refreshed|activated)\b/u.test(lower)) {
    return { icon: "ready", iconColor: "coral" };
  }
  return { icon: "info", iconColor: "lavender" };
}

function normaliseTitle(title = "SERVICE") {
  const cleaned = sanitiseWwTerminalText(title).replace(/[^A-Za-z0-9 _-]/gu, " ").replace(/\s+/gu, " ").trim();
  return (cleaned || "SERVICE").toUpperCase();
}

function style(value, color, enabled) {
  return enabled ? `${WW_TERMINAL_COLORS[color]}${value}${WW_TERMINAL_COLORS.reset}` : value;
}

function animationDefinition(name) {
  const key = String(name || "").trim().toLowerCase();
  return ANIMATION_DEFINITIONS[key] || ANIMATION_DEFINITIONS.pulse;
}

function animationFrame(definition, index, label, width) {
  const frame = definition.frames[index % definition.frames.length];
  const content = `${frame} ${sanitiseWwTerminalText(label)}`.trim();
  return truncate(content, Math.max(1, width));
}

export function createWwTerminalAnimator({
  stream,
  env = process.env,
  columns,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const mode = resolveWwTerminalMode({ stream, env });
  const width = Math.max(8, Number(columns) || terminalColumns(stream, env));
  let timer = null;
  let finishTimer = null;
  let active = false;
  let rendered = false;
  let frameIndex = 0;
  let resolveRun = null;
  let boundProcess = null;
  let signalHandler = null;

  const write = (value) => {
    if (mode.animation && typeof stream?.write === "function") stream.write(value);
  };

  const clearFrame = () => {
    if (!rendered) return;
    write(ERASE_LINE);
    rendered = false;
  };

  const unbindSignals = () => {
    if (!boundProcess || !signalHandler || typeof boundProcess.removeListener !== "function") {
      boundProcess = null;
      signalHandler = null;
      return;
    }
    boundProcess.removeListener("SIGINT", signalHandler);
    boundProcess.removeListener("SIGTERM", signalHandler);
    boundProcess = null;
    signalHandler = null;
  };

  const stop = ({ clear = true, unbindSignals: shouldUnbindSignals = true } = {}) => {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (finishTimer !== null) {
      clearTimeoutImpl(finishTimer);
      finishTimer = null;
    }
    const wasActive = active;
    active = false;
    if (clear) clearFrame();
    if (shouldUnbindSignals) unbindSignals();
    if (resolveRun) {
      const resolve = resolveRun;
      resolveRun = null;
      resolve({ completed: false, stopped: true, active: wasActive });
    }
    return wasActive;
  };

  const start = (name, { label = "", durationMs, loop } = {}) => {
    // Replacing one frame sequence must not detach the SIGINT/SIGTERM guard
    // that owns the whole console session.
    stop({ unbindSignals: false });
    if (!mode.animation) return false;
    const definition = animationDefinition(name);
    const maxDuration = Math.max(0, Number(durationMs ?? definition.durationMs) || 0);
    const shouldLoop = loop ?? definition.loop;
    const startedAt = Date.now();
    frameIndex = 0;
    active = true;

    const tick = () => {
      if (!active) return;
      if (!shouldLoop && Date.now() - startedAt >= maxDuration) {
        stop();
        return;
      }
      clearFrame();
      write(`${ERASE_LINE}${animationFrame(definition, frameIndex, label, width)}`);
      rendered = true;
      frameIndex += 1;
      timer = setTimeoutImpl(tick, Math.max(20, Number(definition.frameMs) || 100));
    };

    tick();
    return true;
  };

  const run = (name, options = {}) => {
    if (!mode.animation) return Promise.resolve({ completed: false, disabled: true });
    const definition = animationDefinition(name);
    const durationMs = Math.max(0, Number(options.durationMs ?? definition.durationMs) || 0);
    stop({ unbindSignals: false });
    return new Promise((resolve) => {
      start(name, { ...options, durationMs, loop: true });
      resolveRun = resolve;
      finishTimer = setTimeoutImpl(() => {
        if (!active) return;
        const complete = resolveRun;
        resolveRun = null;
        stop();
        complete?.({ completed: true, stopped: false, disabled: false });
      }, durationMs + Math.max(20, Number(definition.frameMs) || 100));
    });
  };

  const bindSignals = (processLike = process) => {
    if (!mode.animation || !processLike || typeof processLike.once !== "function") return false;
    unbindSignals();
    signalHandler = () => stop();
    processLike.once("SIGINT", signalHandler);
    processLike.once("SIGTERM", signalHandler);
    boundProcess = processLike;
    return true;
  };

  return {
    get enabled() { return mode.animation; },
    get active() { return active; },
    get mode() { return mode; },
    start,
    run,
    stop,
    bindSignals,
    unbindSignals,
  };
}

export function createWwTerminalFormatter({
  stream,
  title = "SERVICE",
  version = "0.0.0",
  env = process.env,
  maxWidth = 120,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const mode = resolveWwTerminalMode({ stream, env });
  const columns = terminalColumns(stream, env || {});
  // The master UI reserves three cells of breathing room on either side.
  const panelWidth = Math.max(8, Math.min(Number(maxWidth) || 120, columns - 6));
  const margin = repeat(" ", Math.max(0, Math.floor((columns - panelWidth) / 2)));
  const glyphs = mode.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
  const panelTitle = normaliseTitle(title);
  const panelVersion = sanitiseWwTerminalText(version).replace(/\s+/gu, " ").trim() || "0.0.0";
  const animator = createWwTerminalAnimator({
    stream,
    env,
    columns,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  let headerPrinted = false;

  const border = (character) => style(character, "lavender", mode.color);
  const headerRow = (content) => {
    const contentWidth = Math.max(1, panelWidth - 6);
    const clipped = truncate(content, contentWidth);
    const padding = repeat(" ", Math.max(0, contentWidth - visibleWwTerminalWidth(clipped)));
    return `${margin}${border(glyphs.doubleVertical)}  ${clipped}${padding}  ${border(glyphs.doubleVertical)}`;
  };
  const outputRow = (message) => {
    const tone = messageTone(message);
    const icon = glyphs[tone.icon];
    const iconWidth = visibleWwTerminalWidth(icon);
    const contentWidth = Math.max(1, panelWidth - 6);
    const messageWidth = Math.max(1, contentWidth - iconWidth - 1);
    const clippedMessage = truncate(message, messageWidth);
    const rendered = `${style(icon, tone.iconColor, mode.color)} ${style(clippedMessage, "text", mode.color)}`;
    const padding = repeat(" ", Math.max(0, contentWidth - visibleWwTerminalWidth(rendered)));
    return `${margin}${border(glyphs.vertical)}  ${rendered}${padding}  ${border(glyphs.vertical)}`;
  };

  return {
    get interactive() { return mode.interactive; },
    get color() { return mode.color; },
    get unicode() { return mode.unicode; },
    get animationEnabled() { return animator.enabled; },
    get columns() { return columns; },
    get panelWidth() { return panelWidth; },
    get innerWidth() { return panelWidth; },
    get machine() { return panelTitle; },

    format(message = "") {
      const cleanMessage = sanitiseWwTerminalText(message);
      animator.stop();
      if (!mode.interactive) return cleanMessage;

      const lines = [];
      if (!headerPrinted) {
        const rule = repeat(glyphs.doubleHorizontal, Math.max(1, panelWidth - 2));
        lines.push(`${margin}${border(glyphs.doubleTopLeft)}${border(rule)}${border(glyphs.doubleTopRight)}`);
        const heading = `${style("ARAMAC", "coral", mode.color)} ${style("-", "muted", mode.color)} ${style("WORKWIRE", "lavender", mode.color)} ${style("-", "muted", mode.color)} ${style(`v${panelVersion}`, "coral", mode.color)}`;
        lines.push(headerRow(heading));
        lines.push(headerRow(`${panelTitle} ${style("SERVICE CONSOLE", "text", mode.color)}`));
        lines.push(`${margin}${border(glyphs.doubleBottomLeft)}${border(rule)}${border(glyphs.doubleBottomRight)}`);
        headerPrinted = true;
      }
      lines.push(outputRow(cleanMessage));
      return lines.join("\n");
    },

    animate(name, options = {}) {
      return animator.start(name, options);
    },

    runAnimation(name, options = {}) {
      return animator.run(name, options);
    },

    stopAnimation(options = {}) {
      return animator.stop(options);
    },

    bindAnimationSignals(processLike = process) {
      return animator.bindSignals(processLike);
    },

    close() {
      animator.stop();
      if (!mode.interactive || !headerPrinted) return "";
      const rule = repeat(glyphs.horizontal, Math.max(1, panelWidth - 2));
      headerPrinted = false;
      return `${margin}${border(glyphs.bottomLeft)}${border(rule)}${border(glyphs.bottomRight)}`;
    },
  };
}
