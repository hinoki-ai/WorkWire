function looksLikeElectronAppPath(value = "") {
  const candidate = String(value || "").trim();
  if (!candidate) {
    return false;
  }

  if (candidate.includes("/") || candidate.includes("\\")) {
    return true;
  }

  return [".js", ".cjs", ".mjs", ".asar"].some((suffix) => candidate.endsWith(suffix));
}

export function extractElectronAppArgv(rawArgv = process.argv) {
  const argv = Array.isArray(rawArgv) ? [...rawArgv] : [];
  if (argv.length <= 1) {
    return [];
  }

  const second = String(argv[1] || "").trim();
  if (!second) {
    return argv.slice(2);
  }

  if (second.startsWith("--")) {
    return argv.slice(1);
  }

  if (looksLikeElectronAppPath(second)) {
    return argv.slice(2);
  }

  return argv.slice(1);
}
