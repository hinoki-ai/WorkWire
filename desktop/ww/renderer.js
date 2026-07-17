const refs = {
  showHidden: document.getElementById("show-hidden"),
  autoLink: document.getElementById("auto-link"),
  refreshAll: document.getElementById("refresh-all"),
  serviceName: document.getElementById("service-name"),
  serviceMeta: document.getElementById("service-meta"),
  peerName: document.getElementById("peer-name"),
  peerMeta: document.getElementById("peer-meta"),
  operationLabel: document.getElementById("operation-label"),
  operationMeta: document.getElementById("operation-meta"),
  operationBar: document.getElementById("operation-bar"),
  actionSummary: document.getElementById("action-summary"),
  inlineMessage: document.getElementById("inline-message"),
  localPane: document.getElementById("local-pane"),
  remotePane: document.getElementById("remote-pane"),
  localPaneMeta: document.getElementById("local-pane-meta"),
  remotePaneMeta: document.getElementById("remote-pane-meta"),
  localPathValue: document.getElementById("local-path-value"),
  remotePathValue: document.getElementById("remote-path-value"),
  localList: document.getElementById("local-list"),
  remoteList: document.getElementById("remote-list"),
  localSelectionMeta: document.getElementById("local-selection-meta"),
  remoteSelectionMeta: document.getElementById("remote-selection-meta"),
  localFilter: document.getElementById("local-filter"),
  remoteFilter: document.getElementById("remote-filter"),
  localUp: document.getElementById("local-up"),
  remoteUp: document.getElementById("remote-up"),
  localHome: document.getElementById("local-home"),
  remoteHome: document.getElementById("remote-home"),
  localRefresh: document.getElementById("local-refresh"),
  remoteRefresh: document.getElementById("remote-refresh"),
  copyToOther: document.getElementById("copy-to-other"),
  moveToOther: document.getElementById("move-to-other"),
  selectLocalOnly: document.getElementById("select-local-only"),
  selectRemoteOnly: document.getElementById("select-remote-only"),
  selectDifferent: document.getElementById("select-different"),
  selectVisible: document.getElementById("select-visible"),
  clearSelection: document.getElementById("clear-selection"),
  toggleActivePane: document.getElementById("toggle-active-pane"),
  compareLocalOnly: document.getElementById("compare-local-only"),
  compareRemoteOnly: document.getElementById("compare-remote-only"),
  compareDifferent: document.getElementById("compare-different"),
  compareMatch: document.getElementById("compare-match"),
};

const uiState = {
  snapshot: null,
  activeSide: "local",
  filters: {
    local: "",
    remote: "",
  },
  selections: {
    local: new Set(),
    remote: new Set(),
  },
  inlineMessage: null,
};

function api() {
  return window.wwApi;
}

function setInlineMessage(message = "", level = "info") {
  const normalized = String(message || "").trim();
  uiState.inlineMessage = normalized
    ? {
        message: normalized,
        level,
      }
    : null;
  renderInlineMessage();
}

function renderInlineMessage() {
  if (!uiState.inlineMessage) {
    refs.inlineMessage.hidden = true;
    refs.inlineMessage.textContent = "";
    refs.inlineMessage.className = "inline-message";
    return;
  }

  refs.inlineMessage.hidden = false;
  refs.inlineMessage.textContent = uiState.inlineMessage.message;
  refs.inlineMessage.className = `inline-message inline-message-${uiState.inlineMessage.level || "info"}`;
}

function formatBytes(value = 0) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / (1024 ** 2)).toFixed(1)} MB`;
  return `${(size / (1024 ** 3)).toFixed(1)} GB`;
}

function formatDate(value = 0) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "n/a";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(value)));
}

function entriesForSide(side) {
  return Array.isArray(uiState.snapshot?.panes?.[side]?.listing?.items)
    ? uiState.snapshot.panes[side].listing.items
    : [];
}

function currentPane(side) {
  return uiState.snapshot?.panes?.[side] || null;
}

function currentSelection(side) {
  return uiState.selections[side];
}

function pruneSelections() {
  for (const side of ["local", "remote"]) {
    const available = new Set(entriesForSide(side).map((entry) => entry.path));
    uiState.selections[side] = new Set(
      [...uiState.selections[side]].filter((value) => available.has(value)),
    );
  }
}

function hasActiveFilter(side) {
  return uiState.filters[side].trim().length > 0;
}

function setSnapshot(nextSnapshot) {
  uiState.snapshot = nextSnapshot;
  if (nextSnapshot?.ui) {
    refs.showHidden.checked = Boolean(nextSnapshot.ui.showHidden);
  }
  pruneSelections();
  render();
}

function setActiveSide(side) {
  uiState.activeSide = side;
  refs.localPane.classList.toggle("pane-active", side === "local");
  refs.remotePane.classList.toggle("pane-active", side === "remote");
  renderActionRail();
  renderPane("local");
  renderPane("remote");
}

function visibleEntries(side) {
  const filter = uiState.filters[side].trim().toLowerCase();
  const allEntries = entriesForSide(side);
  if (!filter) {
    return allEntries;
  }
  return allEntries.filter((entry) => entry.name.toLowerCase().includes(filter));
}

function remoteConnected() {
  return Boolean(uiState.snapshot?.peer?.connected);
}

function buildPeerEntryMap(side) {
  const otherSide = side === "local" ? "remote" : "local";
  return new Map(entriesForSide(otherSide).map((entry) => [entry.name, entry]));
}

function diffStatus(side, entry) {
  const otherMap = buildPeerEntryMap(side);
  const peerEntry = otherMap.get(entry.name);
  if (!peerEntry) {
    return {
      label: side === "local" ? "Only local" : "Only remote",
      className: side === "local" ? "status-only-local" : "status-only-remote",
    };
  }

  if (peerEntry.kind !== entry.kind) {
    return {
      label: "Type differs",
      className: "status-different",
    };
  }

  if (entry.kind === "file") {
    const sameSize = Number(entry.size) === Number(peerEntry.size);
    const closeMtime = Math.abs(Number(entry.mtimeMs) - Number(peerEntry.mtimeMs)) < 1000;
    if (sameSize && closeMtime) {
      return {
        label: "Matches",
        className: "status-match",
      };
    }
    return {
      label: "Meta differs",
      className: "status-different",
    };
  }

  return {
    label: "Shared dir",
    className: "status-match",
  };
}

function compareStats() {
  const localEntries = entriesForSide("local");
  const remoteEntries = entriesForSide("remote");
  let localOnly = 0;
  let remoteOnly = 0;
  let different = 0;
  let match = 0;

  for (const entry of localEntries) {
    const status = diffStatus("local", entry);
    if (status.className === "status-only-local") {
      localOnly += 1;
      continue;
    }
    if (status.className === "status-different") {
      different += 1;
      continue;
    }
    match += 1;
  }

  for (const entry of remoteEntries) {
    const status = diffStatus("remote", entry);
    if (status.className === "status-only-remote") {
      remoteOnly += 1;
    }
  }

  return {
    localOnly,
    remoteOnly,
    different,
    match,
  };
}

function selectedEntryStats(side) {
  const selected = entriesForSide(side).filter((entry) => currentSelection(side).has(entry.path));
  const files = selected.filter((entry) => entry.kind === "file");
  const directories = selected.filter((entry) => entry.kind === "directory");
  const bytes = files.reduce((total, entry) => total + (Number(entry.size) || 0), 0);
  return {
    count: selected.length,
    files: files.length,
    directories: directories.length,
    bytes,
  };
}

function setSelection(side, paths = []) {
  uiState.selections[side] = new Set(paths);
  render();
}

function toggleSelection(side, targetPath) {
  const selection = currentSelection(side);
  if (selection.has(targetPath)) {
    selection.delete(targetPath);
  } else {
    selection.add(targetPath);
  }
  render();
}

function selectByStatus(side, classNames = []) {
  const nextPaths = visibleEntries(side)
    .filter((entry) => classNames.includes(diffStatus(side, entry).className))
    .map((entry) => entry.path);
  setActiveSide(side);
  setSelection(side, nextPaths);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text != null) {
    element.textContent = text;
  }
  return element;
}

function formatUserFacingError(error) {
  const message = String(error?.message || "Action failed.").trim();
  if (!message) {
    return "Action failed.";
  }

  const lower = message.toLowerCase();
  if (
    lower.includes("peer")
    || lower.includes("token")
    || lower.includes("authorization")
    || lower.includes("fetch failed")
    || lower.includes("timed out")
    || lower.includes("econn")
    || lower.includes("enotfound")
    || lower.includes("ehostunreach")
    || lower.includes("http://")
    || lower.includes("https://")
    || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(message)
  ) {
    return "WW couldn't reach the other PC right now.";
  }

  return message;
}

function localServiceSummary() {
  return uiState.snapshot?.service?.info
    ? "Ready to share files."
    : "Waiting for local WorkWire...";
}

function remoteStateLabel() {
  return remoteConnected() ? "Connected" : "Waiting";
}

function remoteSummaryCopy() {
  if (remoteConnected()) {
    return "Other PC is ready for transfers.";
  }
  return "WW will link the other PC automatically when it is available.";
}

function emptyPaneMessage(side, pane, filteredEntries) {
  if (!pane?.listing) {
    if (side === "remote") {
      return remoteConnected()
        ? "Other PC is connected, but its files are not available right now."
        : "WW will link the other PC automatically when it is available.";
    }
    return "The local WorkWire folder is not available.";
  }

  if (filteredEntries.length > 0) {
    return "";
  }

  if (hasActiveFilter(side)) {
    return "No files match this filter.";
  }

  return side === "local"
    ? "Drop files into this WorkWire folder to see them here."
    : "The other WorkWire folder is empty.";
}

function renderPane(side) {
  const pane = currentPane(side);
  const listElement = side === "local" ? refs.localList : refs.remoteList;
  const metaElement = side === "local" ? refs.localPaneMeta : refs.remotePaneMeta;
  const pathElement = side === "local" ? refs.localPathValue : refs.remotePathValue;
  const selectionMetaElement = side === "local" ? refs.localSelectionMeta : refs.remoteSelectionMeta;
  const entries = visibleEntries(side);
  const totalEntries = entriesForSide(side).length;
  const selection = selectedEntryStats(side);

  pathElement.textContent = pane?.path || "";
  if (side === "remote" && !pane?.listing) {
    metaElement.textContent = remoteStateLabel();
  } else {
    metaElement.textContent = pane?.error
      ? pane.error
      : `${totalEntries} item${totalEntries === 1 ? "" : "s"}${pane?.listing?.parentPath ? "" : " · root"}`;
  }
  selectionMetaElement.textContent = selection.count > 0
    ? `${selection.count} selected · ${entries.length}/${totalEntries} shown · ${formatBytes(selection.bytes)}`
    : `${entries.length}/${totalEntries} shown`;

  listElement.replaceChildren();
  const emptyMessage = emptyPaneMessage(side, pane, entries);
  if (emptyMessage) {
    listElement.append(createElement("div", "empty-state", emptyMessage));
    return;
  }

  for (const entry of entries) {
    const row = createElement("div", "file-row");
    row.dataset.path = entry.path;
    row.dataset.side = side;
    row.classList.toggle("file-row-active", uiState.activeSide === side);
    row.classList.toggle("file-row-selected", currentSelection(side).has(entry.path));
    row.addEventListener("click", () => {
      setActiveSide(side);
      toggleSelection(side, entry.path);
    });

    const nameCell = createElement("div", "file-cell-name");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = currentSelection(side).has(entry.path);
    checkbox.ariaLabel = `Select ${entry.name}`;
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        currentSelection(side).add(entry.path);
      } else {
        currentSelection(side).delete(entry.path);
      }
      render();
    });

    const labelWrap = createElement("button", "file-name-button");
    labelWrap.type = "button";
    labelWrap.title = entry.path;
    labelWrap.addEventListener("click", async (event) => {
      event.stopPropagation();
      setActiveSide(side);
      if (entry.kind === "directory") {
        await runAction(() => api().openPath(side, entry.path));
      }
    });
    labelWrap.append(createElement(
      "span",
      `file-name-main file-name-${entry.kind === "directory" ? "directory" : entry.kind === "file" ? "file" : "other"}`,
      entry.kind === "directory" ? `${entry.name}/` : entry.name,
    ));

    nameCell.append(checkbox, labelWrap);

    const status = diffStatus(side, entry);
    const statusCell = createElement("span", `status-pill ${status.className}`, status.label);
    const sizeCell = createElement("span", "", entry.kind === "file" ? formatBytes(entry.size) : "--");
    const modifiedCell = createElement("span", "", formatDate(entry.mtimeMs));

    row.append(nameCell, statusCell, sizeCell, modifiedCell);
    listElement.append(row);
  }
}

function renderServiceCard() {
  refs.serviceName.textContent = "This PC";
  refs.serviceMeta.textContent = localServiceSummary();
}

function renderPeerCard() {
  const peer = uiState.snapshot?.peer;
  const connected = remoteConnected();
  refs.peerName.textContent = remoteStateLabel();
  refs.peerMeta.textContent = connected
    ? remoteSummaryCopy()
    : (peer?.error ? "WW is still trying to reach the other PC." : remoteSummaryCopy());
  refs.autoLink.textContent = connected ? "Find Again" : "Find Other PC";
}

function renderOperation() {
  const operation = uiState.snapshot?.operation || {};
  const totals = operation.totals || {};
  const totalBytes = Number(totals.bytes) || 0;
  const totalFiles = Number(totals.files) || 0;
  const percent = totalBytes > 0
    ? Math.min(100, Math.round((Number(operation.transferredBytes || 0) / totalBytes) * 100))
    : totalFiles > 0
      ? Math.min(100, Math.round((Number(operation.transferredFiles || 0) / totalFiles) * 100))
      : 0;

  refs.operationLabel.textContent = operation.active
    ? operation.label || "Working"
    : operation.stage === "error"
      ? "Transfer failed"
      : operation.stage === "complete"
        ? "Transfer complete"
        : "Idle";
  refs.operationMeta.textContent = operation.stage === "error"
    ? (operation.error || "Transfer failed.")
    : totalFiles > 0
      ? `${operation.transferredFiles || 0}/${totalFiles} files · ${formatBytes(operation.transferredBytes || 0)} / ${formatBytes(totalBytes)}`
      : "No active file transfers.";
  refs.operationBar.style.width = `${percent}%`;
}

function renderInsights() {
  const summary = compareStats();
  refs.compareLocalOnly.textContent = String(summary.localOnly);
  refs.compareRemoteOnly.textContent = String(summary.remoteOnly);
  refs.compareDifferent.textContent = String(summary.different);
  refs.compareMatch.textContent = String(summary.match);
}

function renderActionRail() {
  const remoteConnected = Boolean(uiState.snapshot?.peer?.connected);
  const activeSelectionSize = currentSelection(uiState.activeSide).size;
  const activeSideLabel = uiState.activeSide === "local" ? "This PC" : "Other PC";
  const destinationLabel = uiState.activeSide === "local" ? "Other PC" : "This PC";
  const summary = compareStats();
  const activePane = currentPane(uiState.activeSide);

  refs.copyToOther.disabled = !remoteConnected || activeSelectionSize === 0;
  refs.moveToOther.disabled = !remoteConnected || activeSelectionSize === 0;
  refs.selectLocalOnly.disabled = summary.localOnly === 0;
  refs.selectRemoteOnly.disabled = summary.remoteOnly === 0 || !remoteConnected;
  refs.selectDifferent.disabled = summary.different === 0;
  refs.selectVisible.disabled = visibleEntries(uiState.activeSide).length === 0;
  refs.clearSelection.disabled = activeSelectionSize === 0;

  refs.copyToOther.textContent = `Copy to ${destinationLabel}`;
  refs.moveToOther.textContent = `Move to ${destinationLabel}`;
  refs.actionSummary.textContent = activeSelectionSize > 0
    ? `${activeSelectionSize} selected on ${activeSideLabel}. Send them to ${destinationLabel}${activePane?.path ? ` from ${activePane.path}` : ""}.`
    : `${activeSideLabel} is active. Select files there, then send them to ${destinationLabel}.`;
}

function render() {
  if (!uiState.snapshot) {
    return;
  }
  renderServiceCard();
  renderPeerCard();
  renderOperation();
  renderInsights();
  renderPane("local");
  renderPane("remote");
  renderActionRail();
  renderInlineMessage();
}

function selectedPaths(side) {
  return [...currentSelection(side)];
}

async function runAction(action) {
  setInlineMessage("");
  try {
    return await action();
  } catch (error) {
    setInlineMessage(formatUserFacingError(error), "error");
    throw error;
  }
}

async function transferActiveSelection(move) {
  const fromSide = uiState.activeSide;
  const paths = selectedPaths(fromSide);

  if (!uiState.snapshot?.peer?.connected) {
    setInlineMessage("WW is still looking for the other PC.", "info");
    return;
  }

  if (paths.length === 0) {
    setInlineMessage(`Select files on ${fromSide === "local" ? "This PC" : "Other PC"} first.`, "info");
    return;
  }

  await runAction(() => api().transfer({
    fromSide,
    targetPaths: paths,
    move,
    conflictPolicy: uiState.snapshot?.ui?.conflictPolicy || "rename",
  }));
  currentSelection(fromSide).clear();
  render();
}

function bindPaneActions() {
  refs.localPane.addEventListener("click", () => setActiveSide("local"));
  refs.remotePane.addEventListener("click", () => setActiveSide("remote"));
  refs.autoLink.addEventListener("click", () => void runAction(() => api().autoLink()));
  refs.refreshAll.addEventListener("click", () => void runAction(() => api().refresh()));
  refs.showHidden.addEventListener("change", () => void runAction(() => api().setHidden(refs.showHidden.checked)));
  refs.selectLocalOnly.addEventListener("click", () => selectByStatus("local", ["status-only-local"]));
  refs.selectRemoteOnly.addEventListener("click", () => selectByStatus("remote", ["status-only-remote"]));
  refs.selectDifferent.addEventListener("click", () => selectByStatus(uiState.activeSide, ["status-different"]));
  refs.selectVisible.addEventListener("click", () => setSelection(
    uiState.activeSide,
    visibleEntries(uiState.activeSide).map((entry) => entry.path),
  ));
  refs.clearSelection.addEventListener("click", () => setSelection(uiState.activeSide, []));
  refs.toggleActivePane.addEventListener("click", () => setActiveSide(uiState.activeSide === "local" ? "remote" : "local"));

  refs.localFilter.addEventListener("input", () => {
    uiState.filters.local = refs.localFilter.value;
    renderPane("local");
  });
  refs.remoteFilter.addEventListener("input", () => {
    uiState.filters.remote = refs.remoteFilter.value;
    renderPane("remote");
  });

  refs.localRefresh.addEventListener("click", () => void runAction(() => api().refresh("local")));
  refs.remoteRefresh.addEventListener("click", () => void runAction(() => api().refresh("remote")));

  refs.localUp.addEventListener("click", () => {
    const parent = currentPane("local")?.listing?.parentPath;
    if (parent) {
      void runAction(() => api().openPath("local", parent));
    }
  });
  refs.remoteUp.addEventListener("click", () => {
    const parent = currentPane("remote")?.listing?.parentPath;
    if (parent) {
      void runAction(() => api().openPath("remote", parent));
    }
  });
  refs.localHome.addEventListener("click", () => {
    const rootPath = uiState.snapshot?.service?.info?.rootPath;
    if (rootPath) {
      void runAction(() => api().openPath("local", rootPath));
    }
  });
  refs.remoteHome.addEventListener("click", () => {
    const rootPath = uiState.snapshot?.peer?.info?.rootPath;
    if (rootPath) {
      void runAction(() => api().openPath("remote", rootPath));
    }
  });

  refs.copyToOther.addEventListener("click", () => void transferActiveSelection(false));
  refs.moveToOther.addEventListener("click", () => void transferActiveSelection(true));
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTypingTarget = target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey;

    if (event.key === "Escape") {
      if (currentSelection(uiState.activeSide).size > 0) {
        event.preventDefault();
        setSelection(uiState.activeSide, []);
        return;
      }
      if (uiState.inlineMessage) {
        event.preventDefault();
        setInlineMessage("");
      }
      return;
    }

    if (isTypingTarget) {
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      setActiveSide(uiState.activeSide === "local" ? "remote" : "local");
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(uiState.activeSide, visibleEntries(uiState.activeSide).map((entry) => entry.path));
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      void runAction(() => api().autoLink());
      return;
    }

    if (hasModifier) {
      return;
    }

    if (event.key === "F5") {
      event.preventDefault();
      void transferActiveSelection(false);
      return;
    }

    if (event.key === "F6") {
      event.preventDefault();
      void transferActiveSelection(true);
      return;
    }

    if (event.key === "F9") {
      event.preventDefault();
      void runAction(() => api().refresh());
    }
  });
}

async function init() {
  bindPaneActions();
  bindKeyboardShortcuts();
  const initialState = await api().getState();
  setSnapshot(initialState);

  api().onEvent((event) => {
    if (event?.state) {
      setSnapshot(event.state);
    }
  });
}

await init();
