function availableTool(record) {
  return record === true || typeof record === "string" || record?.available === true;
}
export function buildPlatformActionCapabilityMatrix({
  platform = process.platform,
  architecture = process.arch,
  tools = {},
  actions = [],
} = {}) {
  const matrix = {};
  for (const descriptor of actions) {
    const requiredTools = Array.isArray(descriptor.requiredTools) ? descriptor.requiredTools : [];
    const missingTools = requiredTools.filter((tool) => !availableTool(tools[tool]));
    matrix[descriptor.name] = {
      action: descriptor.name,
      platform,
      architecture,
      available: missingTools.length === 0,
      mutates: descriptor.mutates === true,
      requiredTools,
      missingTools,
      fallback: missingTools.length > 0 ? {
        action: "shell.exec",
        available: true,
        unrestricted: true,
        reason: `Native tools unavailable: ${missingTools.join(", ")}.`,
      } : null,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    platform,
    architecture,
    arm64: architecture === "arm64" || architecture === "aarch64",
    actions: matrix,
  };
}

export function summarizePlatformCapabilities(matrix = {}) {
  const actions = Object.values(matrix.actions || {});
  return {
    platform: matrix.platform,
    architecture: matrix.architecture,
    arm64: matrix.arm64 === true,
    nativeActions: actions.filter((action) => action.available).length,
    shellFallbackActions: actions.filter((action) => !action.available && action.fallback?.available).length,
    unavailableActions: actions.filter((action) => !action.available && !action.fallback?.available).length,
  };
}
