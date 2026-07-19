import {
  createSearchIndex as buildSearchIndex,
  createSearchIndexAsync as buildSearchIndexAsync,
  normalizeSearch,
  rankSearchIndex as searchIndex,
  rankSearchIndexAsync as searchIndexAsync,
} from "./search.js";
import {
  formatSecondsRemaining,
  formatTransferDuration,
  formatTransferPercent,
  getTransferProgress,
} from "./transfer-progress.js";
import { createRecoveryRenderer } from "./recovery-renderer.js";

const SEARCH_RESULT_LIMIT = 10;
const VIRTUAL_ROW_HEIGHT = 44;
const VIRTUAL_ROW_OVERSCAN = 8;
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const refs = {
  showHidden: document.getElementById("show-hidden"),
  refreshAll: document.getElementById("refresh-all"),
  windowClose: document.getElementById("window-close"),
  transferPanel: document.getElementById("transfer-panel"),
  operationLabel: document.getElementById("operation-label"),
  operationArrow: document.getElementById("operation-arrow"),
  operationPercent: document.getElementById("operation-percent"),
  operationDismiss: document.getElementById("operation-dismiss"),
  operationCurrent: document.getElementById("operation-current"),
  operationProgress: document.getElementById("operation-progress"),
  operationMeta: document.getElementById("operation-meta"),
  operationSpeed: document.getElementById("operation-speed"),
  operationFiles: document.getElementById("operation-files"),
  operationEta: document.getElementById("operation-eta"),
  operationBar: document.getElementById("operation-bar"),
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
  localSearchResults: document.getElementById("local-search-results"),
  remoteSearchResults: document.getElementById("remote-search-results"),
  copyToOther: document.getElementById("copy-to-other"),
  moveToOther: document.getElementById("move-to-other"),
  selectLocalOnly: document.getElementById("select-local-only"),
  selectRemoteOnly: document.getElementById("select-remote-only"),
  selectDifferent: document.getElementById("select-different"),
  selectVisible: document.getElementById("select-visible"),
  clearSelection: document.getElementById("clear-selection"),
  deleteSelection: document.getElementById("delete-selection"),
  restoreDeleted: document.getElementById("restore-deleted"),
  toggleActivePane: document.getElementById("toggle-active-pane"),
  compareLocalOnly: document.getElementById("compare-local-only"),
  compareRemoteOnly: document.getElementById("compare-remote-only"),
  compareDifferent: document.getElementById("compare-different"),
  compareMatch: document.getElementById("compare-match"),
  exploreMachine: document.getElementById("explore-machine"),
  explorerLayer: document.getElementById("explorer-layer"),
  explorerMeta: document.getElementById("explorer-meta"),
  explorerPathValue: document.getElementById("explorer-path-value"),
  explorerHome: document.getElementById("explorer-home"),
  explorerUp: document.getElementById("explorer-up"),
  explorerRefresh: document.getElementById("explorer-refresh"),
  explorerClose: document.getElementById("explorer-close"),
  explorerFilter: document.getElementById("explorer-filter"),
  explorerList: document.getElementById("explorer-list"),
  explorerSelectionMeta: document.getElementById("explorer-selection-meta"),
  explorerFetch: document.getElementById("explorer-fetch"),
  restoreLayer: document.getElementById("restore-layer"),
  restoreClose: document.getElementById("restore-close"),
  restoreMeta: document.getElementById("restore-meta"),
  restoreFilter: document.getElementById("restore-filter"),
  restoreMessage: document.getElementById("restore-message"),
  restoreList: document.getElementById("restore-list"),
};

const uiState = {
  snapshot: null,
  activeSide: "local",
  filters: {
    local: "",
    remote: "",
  },
  search: {
    local: { activeIndex: -1, source: null, index: null, indexing: false, indexGeneration: 0, query: null, generation: 0, pendingRender: false, results: [], topResults: [] },
    remote: { activeIndex: -1, source: null, index: null, indexing: false, indexGeneration: 0, query: null, generation: 0, pendingRender: false, results: [], topResults: [] },
  },
  viewport: {
    local: { frame: 0 },
    remote: { frame: 0 },
    explorer: { frame: 0 },
  },
  selections: {
    local: new Set(),
    remote: new Set(),
  },
  explorer: {
    selection: new Set(),
    filter: "",
    indexSource: null,
    index: null,
  },
  restore: {
    open: false,
    side: "local",
    items: [],
    filter: "",
    loading: false,
    restoringId: "",
    error: "",
  },
  inlineMessage: null,
  deleteArmed: false,
  deleteDisarmTimer: null,
  transferHideTimer: null,
  transferDismissedId: null,
};

const comparisonCache = {
  localSource: null,
  remoteSource: null,
  localMap: new Map(),
  remoteMap: new Map(),
  localStatuses: new Map(),
  remoteStatuses: new Map(),
  summary: { localOnly: 0, remoteOnly: 0, different: 0, match: 0 },
  generation: 0,
  mapsReady: true,
  ready: true,
};

function api() {
  return window.wwApi;
}

const recoveryUi = createRecoveryRenderer({
  recoveryApi: () => api()?.recovery,
});

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
  return DATE_FORMATTER.format(new Date(Number(value)));
}

function formatTimeRemaining(value = 0) {
  const remaining = Math.max(0, Number(value) - Date.now());
  if (remaining <= 0) return "Expiring now";
  const hours = Math.ceil(remaining / (60 * 60 * 1_000));
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
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
    if (uiState.selections[side].size > 0) {
      const selected = uiState.selections[side];
      uiState.selections[side] = new Set(
        entriesForSide(side).filter((entry) => selected.has(entry.path)).map((entry) => entry.path),
      );
    }
  }

  if (uiState.explorer.selection.size > 0) {
    const selected = uiState.explorer.selection;
    uiState.explorer.selection = new Set(
      explorerEntries().filter((entry) => selected.has(entry.path)).map((entry) => entry.path),
    );
  }
}

function explorerSnapshot() {
  return uiState.snapshot?.explorer || null;
}

function explorerOpenState() {
  return Boolean(explorerSnapshot()?.open);
}

function explorerEntries() {
  return Array.isArray(explorerSnapshot()?.listing?.items)
    ? explorerSnapshot().listing.items
    : [];
}

function visibleExplorerEntries() {
  const allEntries = explorerEntries();
  if (uiState.explorer.indexSource !== allEntries) {
    uiState.explorer.indexSource = allEntries;
    uiState.explorer.index = buildSearchIndex(allEntries);
  }
  const filter = normalizeSearch(uiState.explorer.filter);
  if (!filter) return allEntries;
  return uiState.explorer.index.records
    .filter((record) => record.normalizedName.includes(filter))
    .map((record) => record.entry);
}

function hasActiveFilter(side) {
  return uiState.filters[side].trim().length > 0;
}

function ensureSearchResults(side) {
  const search = uiState.search[side];
  const entries = entriesForSide(side);
  if (search.source !== entries) {
    search.source = entries;
    search.query = null;
    search.generation += 1;
    search.indexGeneration += 1;
    const indexGeneration = search.indexGeneration;
    if (entries.length <= 2_000) {
      search.index = buildSearchIndex(entries);
      search.indexing = false;
    } else {
      search.index = {
        source: entries,
        records: [],
        byPath: new Map(),
      };
      search.indexing = true;
      void buildSearchIndexAsync(entries, {
        shouldContinue: () => search.indexGeneration === indexGeneration && search.source === entries,
      }).then((index) => {
        if (!index || search.indexGeneration !== indexGeneration || search.source !== entries) return;
        search.index = index;
        search.indexing = false;
        search.query = null;
        renderPane(side);
        renderActionRail();
      });
    }
    search.results = [];
    search.topResults = [];
    search.activeIndex = -1;
  }
  const query = uiState.filters[side];
  if (search.query !== query) {
    search.query = query;
    search.generation += 1;
    const generation = search.generation;
    search.topResults = query.trim() ? searchIndex(search.index, query, SEARCH_RESULT_LIMIT) : [];
    search.results = search.index.records.length <= 2_000 && query.trim()
      ? searchIndex(search.index, query)
      : search.topResults;
    if (!search.indexing && query.trim() && search.index.records.length > 2_000) {
      const source = search.source;
      void searchIndexAsync(search.index, query, {
        shouldContinue: () => (
          search.generation === generation
          && search.source === source
          && search.query === query
        ),
      }).then((results) => {
        if (
          !results
          || search.generation !== generation
          || search.source !== source
          || search.query !== query
        ) return;
        search.results = results;
        renderPane(side);
        renderActionRail();
      });
    }
  }
  return search;
}

function rankedSearchEntries(side, limit = Infinity) {
  const search = ensureSearchResults(side);
  return Number.isFinite(limit)
    ? search.topResults.slice(0, Math.max(0, limit))
    : search.results;
}

function appendHighlightedText(parent, value, query) {
  const normalizedQuery = normalizeSearch(query);
  const normalizedValue = normalizeSearch(value);
  if (!normalizedQuery) {
    parent.append(createElement("span", "", value));
    return;
  }
  const match = normalizedValue.indexOf(normalizedQuery.split(" ")[0]);
  if (match < 0) {
    parent.append(createElement("span", "", value));
    return;
  }
  parent.append(document.createTextNode(value.slice(0, match)));
  const marked = createElement("mark", "search-highlight", value.slice(match, match + normalizedQuery.split(" ")[0].length));
  parent.append(marked, document.createTextNode(value.slice(match + marked.textContent.length)));
}

function closeSearchDrawer(side) {
  const input = side === "local" ? refs.localFilter : refs.remoteFilter;
  const drawer = side === "local" ? refs.localSearchResults : refs.remoteSearchResults;
  uiState.search[side].activeIndex = -1;
  drawer.hidden = true;
  drawer.replaceChildren();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function openSearchResult(side, result) {
  closeSearchDrawer(side);
  setActiveSide(side);
  if (result.entry.kind === "directory") {
    void runAction(() => api().openPath(side, result.entry.path));
    return;
  }
  toggleSelection(side, result.entry.path);
}

function renderSearchDrawer(side) {
  const input = side === "local" ? refs.localFilter : refs.remoteFilter;
  const drawer = side === "local" ? refs.localSearchResults : refs.remoteSearchResults;
  const query = uiState.filters[side];
  const results = rankedSearchEntries(side, 10);
  drawer.replaceChildren();
  if (!query.trim()) {
    closeSearchDrawer(side);
    return;
  }
  if (!results.length) {
    drawer.append(createElement(
      "div",
      "search-empty",
      uiState.search[side].indexing ? "Preparing search…" : "No close matches found",
    ));
  } else {
    results.forEach((result, index) => {
      const option = createElement("button", "search-result", "");
      option.type = "button";
      option.id = `${side}-search-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === uiState.search[side].activeIndex));
      option.addEventListener("mouseenter", () => setSearchActive(side, index));
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => openSearchResult(side, result));
      const icon = createElement("span", `search-result-icon search-result-icon-${result.entry.kind === "directory" ? "folder" : "file"}`, result.entry.kind === "directory" ? "▰" : "▱");
      const copy = createElement("span", "search-result-copy", "");
      const name = createElement("strong", "search-result-name", "");
      appendHighlightedText(name, result.entry.name, query);
      const location = createElement("span", "search-result-path", result.entry.path);
      copy.append(name, location);
      option.append(icon, copy);
      drawer.append(option);
    });
  }
  drawer.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function setSearchActive(side, index) {
  const results = rankedSearchEntries(side, 10);
  uiState.search[side].activeIndex = results.length ? Math.max(0, Math.min(index, results.length - 1)) : -1;
  const drawer = side === "local" ? refs.localSearchResults : refs.remoteSearchResults;
  [...drawer.querySelectorAll("[role=option]")].forEach((option, optionIndex) => {
    const active = optionIndex === uiState.search[side].activeIndex;
    option.setAttribute("aria-selected", String(active));
    if (active) option.scrollIntoView?.({ block: "nearest" });
  });
  const activeOption = drawer.querySelector(`[role=option][aria-selected="true"]`);
  const input = side === "local" ? refs.localFilter : refs.remoteFilter;
  if (activeOption) input.setAttribute("aria-activedescendant", activeOption.id);
  else input.removeAttribute("aria-activedescendant");
}

function handleSearchKeydown(side, event) {
  if (event.key === "Escape") {
    closeSearchDrawer(side);
    return;
  }
  const results = rankedSearchEntries(side, 10);
  if (!results.length || !hasActiveFilter(side)) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const current = uiState.search[side].activeIndex;
    setSearchActive(side, (current + delta + results.length) % results.length);
  } else if (event.key === "Enter" && uiState.search[side].activeIndex >= 0) {
    event.preventDefault();
    openSearchResult(side, results[uiState.search[side].activeIndex]);
  }
}

function scheduleSearchRender(side) {
  const search = uiState.search[side];
  if (search.pendingRender) return;
  search.pendingRender = true;
  queueMicrotask(() => {
    search.pendingRender = false;
    renderPane(side);
    renderActionRail();
  });
}

function setSnapshot(nextSnapshot) {
  uiState.snapshot = nextSnapshot;
  recoveryUi.setState(nextSnapshot?.recovery || null);
  if (nextSnapshot?.ui) {
    refs.showHidden.checked = Boolean(nextSnapshot.ui.showHidden);
  }
  pruneSelections();
  render();
}

function mergeSnapshotPatch(current, patch) {
  const next = {
    ...(current || {}),
    ...(patch || {}),
  };
  if (patch?.panes) {
    next.panes = { ...(current?.panes || {}) };
    for (const [side, panePatch] of Object.entries(patch.panes)) {
      next.panes[side] = {
        ...(current?.panes?.[side] || {}),
        ...(panePatch || {}),
      };
    }
  }
  return next;
}

function pruneSideSelection(side) {
  if (uiState.selections[side].size === 0) return;
  const selected = uiState.selections[side];
  uiState.selections[side] = new Set(
    entriesForSide(side).filter((entry) => selected.has(entry.path)).map((entry) => entry.path),
  );
}

function applyStateEvent(event) {
  if (!event?.state) return;
  if (event.type === "recovery") {
    if (uiState.snapshot) {
      uiState.snapshot = mergeSnapshotPatch(uiState.snapshot, event.state);
    }
    recoveryUi.setState(event.state.recovery || null);
    return;
  }
  if (!event.partial || !uiState.snapshot) {
    setSnapshot(event.state);
    return;
  }

  uiState.snapshot = mergeSnapshotPatch(uiState.snapshot, event.state);
  const side = event.payload?.side;
  if (event.type === "operation") {
    renderOperation();
    renderActionRail();
    return;
  }
  if (event.type === "explorer") {
    pruneSelections();
    renderExplorer();
    return;
  }
  if (side === "local" || side === "remote") {
    pruneSideSelection(side);
    renderInsights();
    renderPane("local");
    renderPane("remote");
    renderActionRail();
    return;
  }
  render();
}

function setActiveSide(side) {
  uiState.activeSide = side;
  refs.localPane.classList.toggle("pane-active", side === "local");
  refs.remotePane.classList.toggle("pane-active", side === "remote");
  for (const row of refs.localList.querySelectorAll(".file-row")) {
    row.classList.toggle("file-row-active", side === "local");
  }
  for (const row of refs.remoteList.querySelectorAll(".file-row")) {
    row.classList.toggle("file-row-active", side === "remote");
  }
  renderActionRail();
}

function visibleEntries(side) {
  if (!hasActiveFilter(side)) return entriesForSide(side);
  return rankedSearchEntries(side).map((result) => result.entry);
}

function remoteConnected() {
  return Boolean(uiState.snapshot?.peer?.connected);
}

const DIFF_STATUS = Object.freeze({
  onlyLocal: Object.freeze({ label: "Only local", className: "status-only-local" }),
  onlyRemote: Object.freeze({ label: "Only remote", className: "status-only-remote" }),
  typeDifferent: Object.freeze({ label: "Type differs", className: "status-different" }),
  metadataDifferent: Object.freeze({ label: "Meta differs", className: "status-different" }),
  fileMatch: Object.freeze({ label: "Matches", className: "status-match" }),
  directoryMatch: Object.freeze({ label: "Shared dir", className: "status-match" }),
  pending: Object.freeze({ label: "Comparing…", className: "status-pending" }),
});

function computeDiffStatus(side, entry, otherMap) {
  const peerEntry = otherMap.get(entry.name);
  if (!peerEntry) {
    return side === "local" ? DIFF_STATUS.onlyLocal : DIFF_STATUS.onlyRemote;
  }

  if (peerEntry.kind !== entry.kind) {
    return DIFF_STATUS.typeDifferent;
  }

  if (entry.kind === "file") {
    const sameSize = Number(entry.size) === Number(peerEntry.size);
    const closeMtime = Math.abs(Number(entry.mtimeMs) - Number(peerEntry.mtimeMs)) < 1000;
    if (sameSize && closeMtime) {
      return DIFF_STATUS.fileMatch;
    }
    return DIFF_STATUS.metadataDifferent;
  }

  return DIFF_STATUS.directoryMatch;
}

function ensureComparisonCache() {
  const localEntries = entriesForSide("local");
  const remoteEntries = entriesForSide("remote");
  if (
    comparisonCache.localSource === localEntries
    && comparisonCache.remoteSource === remoteEntries
  ) {
    return comparisonCache;
  }

  comparisonCache.localSource = localEntries;
  comparisonCache.remoteSource = remoteEntries;
  comparisonCache.localMap = new Map();
  comparisonCache.remoteMap = new Map();
  comparisonCache.localStatuses = new Map();
  comparisonCache.remoteStatuses = new Map();
  comparisonCache.mapsReady = false;
  comparisonCache.ready = false;
  comparisonCache.generation += 1;
  const generation = comparisonCache.generation;
  void (async () => {
    const summary = { localOnly: 0, remoteOnly: 0, different: 0, match: 0 };
    for (let start = 0; start < localEntries.length; start += 1_000) {
      if (comparisonCache.generation !== generation) return;
      const end = Math.min(localEntries.length, start + 1_000);
      for (let index = start; index < end; index += 1) {
        const entry = localEntries[index];
        comparisonCache.localMap.set(entry.name, entry);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let start = 0; start < remoteEntries.length; start += 1_000) {
      if (comparisonCache.generation !== generation) return;
      const end = Math.min(remoteEntries.length, start + 1_000);
      for (let index = start; index < end; index += 1) {
        const entry = remoteEntries[index];
        comparisonCache.remoteMap.set(entry.name, entry);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (comparisonCache.generation !== generation) return;
    comparisonCache.mapsReady = true;
    for (let start = 0; start < localEntries.length; start += 1_000) {
      if (comparisonCache.generation !== generation) return;
      const end = Math.min(localEntries.length, start + 1_000);
      for (let index = start; index < end; index += 1) {
        const entry = localEntries[index];
        const status = computeDiffStatus("local", entry, comparisonCache.remoteMap);
        comparisonCache.localStatuses.set(entry.path, status);
        if (status.className === "status-only-local") summary.localOnly += 1;
        else if (status.className === "status-different") summary.different += 1;
        else summary.match += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let start = 0; start < remoteEntries.length; start += 1_000) {
      if (comparisonCache.generation !== generation) return;
      const end = Math.min(remoteEntries.length, start + 1_000);
      for (let index = start; index < end; index += 1) {
        const entry = remoteEntries[index];
        const status = computeDiffStatus("remote", entry, comparisonCache.localMap);
        comparisonCache.remoteStatuses.set(entry.path, status);
        if (status.className === "status-only-remote") summary.remoteOnly += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (comparisonCache.generation !== generation) return;
    comparisonCache.summary = summary;
    comparisonCache.ready = true;
    renderInsights();
    renderActionRail();
    renderPaneRows("local", visibleEntries("local"));
    renderPaneRows("remote", visibleEntries("remote"));
  })();
  return comparisonCache;
}

function diffStatus(side, entry) {
  const cache = ensureComparisonCache();
  if (!cache.mapsReady) {
    return DIFF_STATUS.pending;
  }
  const statuses = side === "local" ? cache.localStatuses : cache.remoteStatuses;
  let status = statuses.get(entry.path);
  if (!status) {
    status = computeDiffStatus(side, entry, side === "local" ? cache.remoteMap : cache.localMap);
    statuses.set(entry.path, status);
  }
  return status;
}

function compareStats() {
  return ensureComparisonCache().summary;
}

function selectedEntryStats(side) {
  const selection = currentSelection(side);
  if (selection.size === 0) {
    return { count: 0, files: 0, directories: 0, bytes: 0 };
  }
  const byPath = ensureSearchResults(side).index.byPath;
  const entries = byPath.size > 0
    ? [...selection].map((targetPath) => byPath.get(targetPath)).filter(Boolean)
    : entriesForSide(side).filter((entry) => selection.has(entry.path));
  let count = 0;
  let files = 0;
  let directories = 0;
  let bytes = 0;
  for (const entry of entries) {
    count += 1;
    if (entry.kind === "file") {
      files += 1;
      bytes += Number(entry.size) || 0;
    } else if (entry.kind === "directory") {
      directories += 1;
    }
  }
  return {
    count,
    files,
    directories,
    bytes,
  };
}

function setSelection(side, paths = []) {
  uiState.selections[side] = new Set(paths);
  renderPane(side);
  renderActionRail();
}

function toggleSelection(side, targetPath) {
  const selection = currentSelection(side);
  if (selection.has(targetPath)) {
    selection.delete(targetPath);
  } else {
    selection.add(targetPath);
  }
  renderPane(side);
  renderActionRail();
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

function remoteStateLabel() {
  return remoteConnected() ? "Connected" : "Waiting";
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
    return "No close matches found";
  }

  return side === "local"
    ? "Drop files into this WorkWire folder to see them here."
    : "The other WorkWire folder is empty.";
}

function virtualRange(element, itemCount) {
  const viewportHeight = Math.max(VIRTUAL_ROW_HEIGHT, element.clientHeight || 660);
  const firstVisible = Math.floor(element.scrollTop / VIRTUAL_ROW_HEIGHT);
  const start = Math.max(0, firstVisible - VIRTUAL_ROW_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT) + (VIRTUAL_ROW_OVERSCAN * 2);
  return {
    start,
    end: Math.min(itemCount, start + visibleCount),
  };
}

function createVirtualSpacer(rowCount) {
  const spacer = createElement("div", "virtual-list-spacer");
  spacer.style.height = `${Math.max(0, rowCount) * VIRTUAL_ROW_HEIGHT}px`;
  spacer.setAttribute("aria-hidden", "true");
  return spacer;
}

function createPaneRow(side, entry, position, totalEntries) {
  const row = createElement("div", "file-row");
  row.dataset.path = entry.path;
  row.dataset.side = side;
  row.setAttribute("aria-posinset", String(position + 1));
  row.setAttribute("aria-setsize", String(totalEntries));
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
    if (checkbox.checked) currentSelection(side).add(entry.path);
    else currentSelection(side).delete(entry.path);
    renderPane(side);
    renderActionRail();
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
  return row;
}

function renderPaneRows(side, entries) {
  const listElement = side === "local" ? refs.localList : refs.remoteList;
  const { start, end } = virtualRange(listElement, entries.length);
  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.append(createVirtualSpacer(start));
  for (let index = start; index < end; index += 1) {
    fragment.append(createPaneRow(side, entries[index], index, entries.length));
  }
  if (end < entries.length) fragment.append(createVirtualSpacer(entries.length - end));
  listElement.replaceChildren(fragment);
}

function schedulePaneViewportRender(side) {
  const viewport = uiState.viewport[side];
  if (viewport.frame) return;
  viewport.frame = window.requestAnimationFrame(() => {
    viewport.frame = 0;
    renderPaneRows(side, visibleEntries(side));
  });
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
  pathElement.title = pane?.path || "";
  if (pane?.loading) {
    metaElement.textContent = "Loading…";
  } else if (side === "remote" && !pane?.listing) {
    metaElement.textContent = remoteStateLabel();
  } else {
    metaElement.textContent = pane?.error
      ? pane.error
      : `${totalEntries} item${totalEntries === 1 ? "" : "s"}${pane?.listing?.parentPath ? "" : " · root"}`;
  }
  selectionMetaElement.textContent = selection.count > 0
    ? `${selection.count} selected · ${entries.length}/${totalEntries} shown · ${formatBytes(selection.bytes)}`
    : `${entries.length}/${totalEntries} shown`;

  renderSearchDrawer(side);
  const emptyMessage = emptyPaneMessage(side, pane, entries);
  if (emptyMessage) {
    listElement.replaceChildren(createElement("div", "empty-state", emptyMessage));
    return;
  }
  renderPaneRows(side, entries);
}

function renderControls() {
}

function clearTransferHideTimer() {
  if (!uiState.transferHideTimer) return;
  clearTimeout(uiState.transferHideTimer);
  uiState.transferHideTimer = null;
}

function transferOperationId(operation = {}) {
  return String(operation.id || operation.startedAt || operation.stage || "idle");
}

function setTransferPanelVisible(visible) {
  const nextVisible = Boolean(visible);
  refs.transferPanel.classList.toggle("transfer-panel-visible", nextVisible);
  refs.transferPanel.setAttribute("aria-hidden", String(!nextVisible));
}

function dismissTransferPanel() {
  const operation = uiState.snapshot?.operation || {};
  clearTransferHideTimer();
  uiState.transferDismissedId = transferOperationId(operation);
  setTransferPanelVisible(false);
}

function renderTransferPanelVisibility(operation) {
  const operationId = transferOperationId(operation);
  if (operation.active || operation.stage === "error") {
    clearTransferHideTimer();
    if (operation.active) {
      uiState.transferDismissedId = null;
    }
    setTransferPanelVisible(uiState.transferDismissedId !== operationId);
    return;
  }

  if (operation.stage === "complete" && uiState.transferDismissedId !== operationId) {
    setTransferPanelVisible(true);
    if (!uiState.transferHideTimer) {
      uiState.transferHideTimer = setTimeout(() => {
        uiState.transferHideTimer = null;
        const latestOperation = uiState.snapshot?.operation || {};
        if (
          transferOperationId(latestOperation) === operationId
          && latestOperation.stage === "complete"
        ) {
          uiState.transferDismissedId = operationId;
          setTransferPanelVisible(false);
        }
      }, 5000);
    }
    return;
  }

  clearTransferHideTimer();
  setTransferPanelVisible(false);
}

function transferSideLabel(side = "") {
  if (side === "machine") return "This PC files";
  if (side === "local") return "This PC";
  if (side === "remote") return "Other PC";
  return "";
}

function transferDirectionLabel(operation = {}) {
  const source = transferSideLabel(operation.fromSide);
  const destination = transferSideLabel(operation.toSide);
  return source && destination ? `${source} → ${destination}` : "";
}

function transferPanelState(operation = {}) {
  if (operation.stage === "error") return "error";
  if (operation.stage === "complete") return "complete";
  if (operation.active && (operation.stage === "starting" || operation.stage === "planning")) {
    return "planning";
  }
  return operation.active ? "active" : "idle";
}

function transferTitle(operation = {}) {
  if (operation.stage === "error") return "Transfer failed";
  if (operation.stage === "complete") {
    return operation.kind === "move" ? "Move complete" : "All done";
  }
  if (operation.stage === "starting" || operation.stage === "planning") {
    return "Getting ready";
  }
  if (operation.stage === "skip" || operation.stage === "skip-file") {
    return "Checking files";
  }
  if (operation.kind === "move") return "Moving";
  if (operation.kind === "copy") return "Copying";
  return operation.label || "Working";
}

function transferCurrentText(operation, progress) {
  if (operation.stage === "error") {
    return formatUserFacingError(new Error(operation.error || "Transfer failed."));
  }
  if (operation.stage === "complete") {
    if (progress.skippedFiles > 0 && progress.transferredFiles === 0) {
      return "Everything selected was already there.";
    }
    if (progress.skippedFiles > 0) {
      return "Everything new arrived safely.";
    }
    return "Everything arrived safely.";
  }

  const direction = transferDirectionLabel(operation);
  if (operation.stage === "starting" || operation.stage === "planning") {
    return direction ? `${direction} · Sizing up your selection…` : "Sizing up your selection…";
  }

  const currentName = String(operation.currentName || "").trim();
  if (!currentName) return direction || "Preparing the next file…";

  const currentAlreadyProcessed = operation.stage === "file-complete"
    || operation.stage === "skip"
    || operation.stage === "skip-file";
  const currentNumber = Math.min(
    progress.totalFiles,
    progress.processedFiles + (currentAlreadyProcessed ? 0 : 1),
  );
  return progress.totalFiles > 0
    ? `${Math.max(1, currentNumber)} of ${progress.totalFiles} · ${currentName}`
    : currentName;
}

function renderOperation() {
  const operation = uiState.snapshot?.operation || {};
  const progress = getTransferProgress(operation);
  const panelState = transferPanelState(operation);
  const percentLabel = formatTransferPercent(progress.percent, progress.determinate);
  const direction = transferDirectionLabel(operation);
  const currentText = transferCurrentText(operation, progress);
  const hasSkippedFiles = progress.skippedFiles > 0;

  refs.transferPanel.dataset.state = panelState;
  refs.transferPanel.dataset.direction = operation.fromSide === "remote"
    ? "reverse"
    : operation.fromSide === "machine" ? "import" : "forward";
  refs.transferPanel.setAttribute("aria-busy", String(Boolean(operation.active)));
  refs.operationArrow.textContent = operation.fromSide === "remote"
    ? "←"
    : operation.fromSide === "machine" ? "↓" : "→";
  refs.operationLabel.textContent = panelState === "idle" ? "Idle" : transferTitle(operation);
  refs.operationPercent.textContent = percentLabel;
  refs.operationCurrent.textContent = currentText;
  refs.operationCurrent.title = direction && operation.currentName
    ? `${direction} · ${operation.currentName}`
    : currentText;

  if (panelState === "idle") {
    refs.operationMeta.textContent = "No active file transfers.";
  } else if (hasSkippedFiles) {
    refs.operationMeta.textContent = `${formatBytes(progress.transferredBytes)} sent`;
  } else if (progress.totalBytes > 0) {
    refs.operationMeta.textContent = `${formatBytes(progress.transferredBytes)} of ${formatBytes(progress.totalBytes)}`;
  } else {
    refs.operationMeta.textContent = progress.totalFiles > 0
      ? `${progress.processedFiles} of ${progress.totalFiles} files handled`
      : "Calculating total size…";
  }

  const bytesPerSecond = Number(operation.bytesPerSecond) || 0;
  refs.operationSpeed.textContent = operation.active
    ? bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "Measuring…"
    : operation.stage === "complete" && bytesPerSecond > 0
      ? `${formatBytes(bytesPerSecond)}/s avg`
      : operation.stage === "error" ? "Stopped" : "—";

  if (progress.totalFiles > 0) {
    refs.operationFiles.textContent = operation.stage === "complete" || operation.stage === "error"
      ? `${progress.transferredFiles} sent${progress.skippedFiles > 0 ? ` · ${progress.skippedFiles} skipped` : ""}`
      : `${Math.min(progress.processedFiles, progress.totalFiles)} of ${progress.totalFiles} files`;
  } else {
    refs.operationFiles.textContent = operation.active ? "Preparing files…" : "No files";
  }

  if (operation.active) {
    const remaining = formatSecondsRemaining(operation.estimatedSecondsRemaining);
    refs.operationEta.textContent = remaining
      || (progress.determinate && progress.percent >= 100 ? "Finishing…" : "Calculating…");
  } else if (operation.stage === "complete") {
    refs.operationEta.textContent = formatTransferDuration(operation.durationMs) || "Done";
  } else if (operation.stage === "error") {
    refs.operationEta.textContent = progress.determinate ? `${percentLabel} complete` : "Needs attention";
  } else {
    refs.operationEta.textContent = "Preparing…";
  }

  refs.operationDismiss.hidden = operation.active
    || (operation.stage !== "complete" && operation.stage !== "error");
  refs.operationBar.style.width = `${progress.percent}%`;
  refs.operationBar.classList.toggle("progress-has-value", progress.percent > 0);
  refs.operationProgress.classList.toggle(
    "progress-indeterminate",
    Boolean(operation.active && !progress.determinate),
  );
  if (progress.determinate) {
    refs.operationProgress.setAttribute("aria-valuenow", progress.percent.toFixed(1));
    refs.operationProgress.setAttribute(
      "aria-valuetext",
      `${percentLabel} · ${refs.operationMeta.textContent} · ${refs.operationFiles.textContent}`,
    );
  } else {
    refs.operationProgress.removeAttribute("aria-valuenow");
    refs.operationProgress.setAttribute("aria-valuetext", "Preparing file transfer");
  }
  renderTransferPanelVisibility(operation);
}

function renderInsights() {
  const cache = ensureComparisonCache();
  const summary = cache.summary;
  refs.compareLocalOnly.textContent = cache.ready ? String(summary.localOnly) : "…";
  refs.compareRemoteOnly.textContent = cache.ready ? String(summary.remoteOnly) : "…";
  refs.compareDifferent.textContent = cache.ready ? String(summary.different) : "…";
  refs.compareMatch.textContent = cache.ready ? String(summary.match) : "…";
}

function disarmDeleteButton() {
  if (uiState.deleteDisarmTimer) {
    clearTimeout(uiState.deleteDisarmTimer);
    uiState.deleteDisarmTimer = null;
  }
  uiState.deleteArmed = false;
  refs.deleteSelection.textContent = "Delete";
  refs.deleteSelection.classList.remove("button-danger");
}

function armDeleteButton() {
  uiState.deleteArmed = true;
  refs.deleteSelection.textContent = "Sure?";
  refs.deleteSelection.classList.add("button-danger");
  if (uiState.deleteDisarmTimer) {
    clearTimeout(uiState.deleteDisarmTimer);
  }
  uiState.deleteDisarmTimer = setTimeout(() => {
    uiState.deleteDisarmTimer = null;
    disarmDeleteButton();
  }, 3000);
}

function explorerEmptyMessage(snapshot, filteredEntries) {
  if (snapshot?.error) {
    return snapshot.error;
  }
  if (!snapshot?.listing) {
    return "Loading the other PC...";
  }
  if (filteredEntries.length > 0) {
    return "";
  }
  if (uiState.explorer.filter.trim()) {
    return "No files match this filter.";
  }
  return "This folder is empty.";
}

function selectedExplorerStats() {
  visibleExplorerEntries();
  const byPath = uiState.explorer.index?.byPath || new Map();
  let count = 0;
  let bytes = 0;
  for (const targetPath of uiState.explorer.selection) {
    const entry = byPath.get(targetPath);
    if (!entry) continue;
    count += 1;
    if (entry.kind === "file") bytes += Number(entry.size) || 0;
  }
  return {
    count,
    bytes,
  };
}

function createExplorerRow(entry, position, totalEntries) {
  const row = createElement("div", "file-row explorer-row");
  row.dataset.path = entry.path;
  row.setAttribute("aria-posinset", String(position + 1));
  row.setAttribute("aria-setsize", String(totalEntries));
  row.classList.toggle("file-row-selected", uiState.explorer.selection.has(entry.path));
  row.addEventListener("click", () => toggleExplorerSelection(entry.path));

  const nameCell = createElement("div", "file-cell-name");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = uiState.explorer.selection.has(entry.path);
  checkbox.ariaLabel = `Select ${entry.name}`;
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) uiState.explorer.selection.add(entry.path);
    else uiState.explorer.selection.delete(entry.path);
    renderExplorer();
  });

  const labelWrap = createElement("button", "file-name-button");
  labelWrap.type = "button";
  labelWrap.title = entry.path;
  labelWrap.addEventListener("click", (event) => {
    event.stopPropagation();
    if (entry.kind === "directory") void runAction(() => api().explorerOpen(entry.path));
    else toggleExplorerSelection(entry.path);
  });
  labelWrap.append(createElement(
    "span",
    `file-name-main file-name-${entry.kind === "directory" ? "directory" : entry.kind === "file" ? "file" : "other"}`,
    entry.kind === "directory" ? `${entry.name}/` : entry.name,
  ));
  nameCell.append(checkbox, labelWrap);

  const sizeCell = createElement("span", "", entry.kind === "file" ? formatBytes(entry.size) : "--");
  const modifiedCell = createElement("span", "", formatDate(entry.mtimeMs));
  row.append(nameCell, sizeCell, modifiedCell);
  return row;
}

function renderExplorerRows(entries) {
  const { start, end } = virtualRange(refs.explorerList, entries.length);
  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.append(createVirtualSpacer(start));
  for (let index = start; index < end; index += 1) {
    fragment.append(createExplorerRow(entries[index], index, entries.length));
  }
  if (end < entries.length) fragment.append(createVirtualSpacer(entries.length - end));
  refs.explorerList.replaceChildren(fragment);
}

function scheduleExplorerViewportRender() {
  const viewport = uiState.viewport.explorer;
  if (viewport.frame) return;
  viewport.frame = window.requestAnimationFrame(() => {
    viewport.frame = 0;
    renderExplorerRows(visibleExplorerEntries());
  });
}

function renderExplorer() {
  const snapshot = explorerSnapshot();
  const open = explorerOpenState();
  refs.explorerLayer.hidden = !open;
  if (!open) {
    return;
  }

  const entries = visibleExplorerEntries();
  const totalEntries = explorerEntries().length;
  const selection = selectedExplorerStats();

  refs.explorerPathValue.textContent = snapshot?.path || "";
  refs.explorerMeta.textContent = snapshot?.error
    ? formatUserFacingError(new Error(snapshot.error))
    : `${totalEntries} item${totalEntries === 1 ? "" : "s"}`;
  refs.explorerSelectionMeta.textContent = selection.count > 0
    ? `${selection.count} selected · ${formatBytes(selection.bytes)}`
    : `${entries.length}/${totalEntries} shown`;
  refs.explorerFetch.disabled = selection.count === 0 || Boolean(uiState.snapshot?.operation?.active);
  refs.explorerUp.disabled = !snapshot?.listing?.parentPath;

  const emptyMessage = explorerEmptyMessage(snapshot, entries);
  if (emptyMessage) {
    refs.explorerList.replaceChildren(createElement("div", "empty-state", emptyMessage));
    return;
  }
  renderExplorerRows(entries);
}

function visibleDeletedItems() {
  const filter = uiState.restore.filter.trim().toLowerCase();
  if (!filter) return uiState.restore.items;
  return uiState.restore.items.filter((item) => String(item.name || "").toLowerCase().includes(filter));
}

function renderRestoreDrawer() {
  const restore = uiState.restore;
  refs.restoreLayer.hidden = !restore.open;
  if (!restore.open) return;

  const sideLabel = restore.side === "local" ? "This PC" : "Other PC";
  refs.restoreMeta.textContent = `${sideLabel} · Items are permanently deleted after 5 days.`;
  refs.restoreMessage.hidden = !restore.error;
  refs.restoreMessage.textContent = restore.error;
  refs.restoreList.replaceChildren();

  if (restore.loading) {
    refs.restoreList.append(createElement("div", "empty-state", "Loading recently deleted items..."));
    return;
  }

  const items = visibleDeletedItems();
  if (items.length === 0) {
    refs.restoreList.append(createElement(
      "div",
      "empty-state",
      restore.filter.trim() ? "No deleted items match this name." : "There are no recently deleted items.",
    ));
    return;
  }

  for (const item of items) {
    const row = createElement("div", "restore-row");
    const nameCell = createElement("div", "restore-name");
    const name = createElement(
      "strong",
      `file-name-main file-name-${item.kind === "directory" ? "directory" : "file"}`,
      item.kind === "directory" ? `${item.name}/` : item.name,
    );
    name.title = item.originalPath || item.name;
    const location = createElement("span", "restore-location", item.originalPath || "");
    nameCell.append(name, location);

    const deleted = createElement("span", "restore-date", formatDate(item.deletedAt));
    const remaining = createElement("span", "restore-remaining", formatTimeRemaining(item.expiresAt));
    const restoreButton = createElement("button", "button button-small button-copy", "Restore");
    restoreButton.type = "button";
    restoreButton.disabled = Boolean(restore.restoringId);
    if (restore.restoringId === item.id) restoreButton.textContent = "Restoring...";
    restoreButton.addEventListener("click", () => void restoreDeletedItem(item.id));
    row.append(nameCell, deleted, remaining, restoreButton);
    refs.restoreList.append(row);
  }
}

async function openRestoreDrawer() {
  uiState.restore.open = true;
  uiState.restore.side = uiState.activeSide;
  uiState.restore.items = [];
  uiState.restore.filter = "";
  uiState.restore.loading = true;
  uiState.restore.error = "";
  refs.restoreFilter.value = "";
  renderRestoreDrawer();
  try {
    uiState.restore.items = await api().listDeletedItems(uiState.restore.side);
  } catch (error) {
    uiState.restore.error = formatUserFacingError(error);
  } finally {
    uiState.restore.loading = false;
    renderRestoreDrawer();
    refs.restoreFilter.focus();
  }
}

function closeRestoreDrawer() {
  uiState.restore.open = false;
  uiState.restore.error = "";
  renderRestoreDrawer();
  refs.restoreDeleted.focus();
}

async function restoreDeletedItem(id) {
  if (uiState.restore.restoringId) return;
  uiState.restore.restoringId = id;
  uiState.restore.error = "";
  renderRestoreDrawer();
  try {
    const result = await api().restoreDeletedItem(uiState.restore.side, { id });
    uiState.restore.items = Array.isArray(result?.items) ? result.items : [];
    if (result?.state) setSnapshot(result.state);
  } catch (error) {
    uiState.restore.error = formatUserFacingError(error);
  } finally {
    uiState.restore.restoringId = "";
    renderRestoreDrawer();
  }
}

function toggleExplorerSelection(targetPath) {
  if (uiState.explorer.selection.has(targetPath)) {
    uiState.explorer.selection.delete(targetPath);
  } else {
    uiState.explorer.selection.add(targetPath);
  }
  renderExplorer();
}

async function fetchExplorerSelection() {
  const targetPaths = [...uiState.explorer.selection];
  if (targetPaths.length === 0) {
    return;
  }

  await runAction(async () => {
    const result = await api().explorerFetch({
      targetPaths,
    });
    uiState.explorer.selection.clear();
    await api().explorerClose();
    return result;
  });
}

function renderActionRail() {
  const remoteConnected = Boolean(uiState.snapshot?.peer?.connected);
  const transferActive = Boolean(uiState.snapshot?.operation?.active);
  const activeSelectionSize = currentSelection(uiState.activeSide).size;
  const destinationLabel = uiState.activeSide === "local" ? "Other PC" : "This PC";
  const summary = compareStats();
  const comparisonsReady = comparisonCache.ready;

  refs.copyToOther.disabled = transferActive || !remoteConnected || activeSelectionSize === 0;
  refs.moveToOther.disabled = transferActive || !remoteConnected || activeSelectionSize === 0;
  refs.explorerFetch.disabled = transferActive || selectedExplorerStats().count === 0;
  refs.selectLocalOnly.disabled = !comparisonsReady || summary.localOnly === 0;
  refs.selectRemoteOnly.disabled = !comparisonsReady || summary.remoteOnly === 0 || !remoteConnected;
  refs.selectDifferent.disabled = !comparisonsReady || summary.different === 0;
  refs.selectVisible.disabled = visibleEntries(uiState.activeSide).length === 0;
  refs.clearSelection.disabled = activeSelectionSize === 0;
  refs.deleteSelection.disabled = activeSelectionSize === 0;
  refs.restoreDeleted.disabled = uiState.activeSide === "remote" && !remoteConnected;
  if (activeSelectionSize === 0 && uiState.deleteArmed) {
    disarmDeleteButton();
  }

  refs.copyToOther.textContent = `Copy to ${destinationLabel}`;
  refs.moveToOther.textContent = `Move to ${destinationLabel}`;
  refs.exploreMachine.disabled = false;
}

function render() {
  if (!uiState.snapshot) {
    return;
  }
  renderControls();
  renderOperation();
  renderInsights();
  renderPane("local");
  renderPane("remote");
  renderActionRail();
  renderExplorer();
  renderRestoreDrawer();
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

  if (uiState.snapshot?.operation?.active) {
    setInlineMessage("Another file transfer is already in progress.", "info");
    return;
  }

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

  for (const side of ["local", "remote"]) {
    const input = side === "local" ? refs.localFilter : refs.remoteFilter;
    const list = side === "local" ? refs.localList : refs.remoteList;
    input.addEventListener("input", () => {
      uiState.filters[side] = input.value;
      uiState.search[side].activeIndex = -1;
      list.scrollTop = 0;
      scheduleSearchRender(side);
    });
    input.addEventListener("keydown", (event) => handleSearchKeydown(side, event));
    input.addEventListener("focusout", (event) => {
      if (!event.relatedTarget || !input.parentElement?.contains(event.relatedTarget)) {
        closeSearchDrawer(side);
      }
    });
    list.addEventListener("scroll", () => schedulePaneViewportRender(side), { passive: true });
  }

  refs.copyToOther.addEventListener("click", () => void transferActiveSelection(false));
  refs.moveToOther.addEventListener("click", () => void transferActiveSelection(true));
  refs.operationDismiss.addEventListener("click", dismissTransferPanel);

  refs.deleteSelection.addEventListener("click", () => void deleteActiveSelection());
  refs.windowClose.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void api().closeWindow();
  }, { capture: true });
  refs.windowClose.addEventListener("click", (event) => {
    if (event.detail === 0) void api().closeWindow();
  });
  refs.windowClose.addEventListener("pointerenter", () => refs.windowClose.classList.add("is-hovered"));
  refs.windowClose.addEventListener("pointerleave", () => refs.windowClose.classList.remove("is-hovered"));

  refs.exploreMachine.addEventListener("click", () => void runAction(() => api().explorerOpen()));
  refs.explorerClose.addEventListener("click", () => void runAction(() => api().explorerClose()));
  refs.explorerRefresh.addEventListener("click", () => {
    const currentPath = explorerSnapshot()?.path || "";
    void runAction(() => api().explorerOpen(currentPath));
  });
  refs.explorerUp.addEventListener("click", () => {
    const parent = explorerSnapshot()?.listing?.parentPath;
    if (parent) {
      void runAction(() => api().explorerOpen(parent));
    }
  });
  refs.explorerHome.addEventListener("click", () => {
    const homeDir = explorerSnapshot()?.homePath || "";
    if (homeDir) {
      void runAction(() => api().explorerOpen(homeDir));
    }
  });
  refs.explorerLayer.addEventListener("click", (event) => {
    if (event.target === refs.explorerLayer) {
      void runAction(() => api().explorerClose());
    }
  });
  refs.explorerFilter.addEventListener("input", () => {
    uiState.explorer.filter = refs.explorerFilter.value;
    refs.explorerList.scrollTop = 0;
    renderExplorer();
  });
  refs.explorerList.addEventListener("scroll", scheduleExplorerViewportRender, { passive: true });
  refs.explorerFetch.addEventListener("click", () => void fetchExplorerSelection());
  refs.restoreDeleted.addEventListener("click", () => void openRestoreDrawer());
  refs.restoreClose.addEventListener("click", closeRestoreDrawer);
  refs.restoreLayer.addEventListener("click", (event) => {
    if (event.target === refs.restoreLayer) closeRestoreDrawer();
  });
  refs.restoreFilter.addEventListener("input", () => {
    uiState.restore.filter = refs.restoreFilter.value;
    renderRestoreDrawer();
  });
}

async function deleteActiveSelection() {
  const side = uiState.activeSide;
  const paths = selectedPaths(side);
  if (paths.length === 0) {
    disarmDeleteButton();
    return;
  }

  if (!uiState.deleteArmed) {
    armDeleteButton();
    return;
  }

  disarmDeleteButton();
  await runAction(() => api().deleteItems(side, {
    targetPaths: paths,
  }));
  currentSelection(side).clear();
  render();
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    if (recoveryUi.handleKeydown(event)) {
      return;
    }
    const target = event.target;
    const isTypingTarget = target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey;

    if (event.key === "Escape") {
      if (uiState.restore.open) {
        event.preventDefault();
        closeRestoreDrawer();
        return;
      }
      if (explorerOpenState()) {
        event.preventDefault();
        if (uiState.explorer.selection.size > 0) {
          uiState.explorer.selection.clear();
          renderExplorer();
          return;
        }
        void runAction(() => api().explorerClose());
        return;
      }
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
  recoveryUi.bind();
  bindPaneActions();
  bindKeyboardShortcuts();
  const initialState = await api().getState();
  setSnapshot(initialState);

  const unsubscribe = api().onEvent((event) => applyStateEvent(event));
  window.addEventListener("beforeunload", unsubscribe, { once: true });
}

if (api()?.diagnosticsEnabled) {
  Object.defineProperty(window, "__wwPerformance", {
    configurable: true,
    value: Object.freeze({
      createSearchIndex(entries) {
        return buildSearchIndex(Array.isArray(entries) ? entries : []);
      },
      rankSearchIndex(index, query, limit = Infinity) {
        return searchIndex(index, query, limit);
      },
      rankSearchEntries(entries, query, limit = Infinity) {
        return searchIndex(buildSearchIndex(Array.isArray(entries) ? entries : []), query, limit);
      },
      replaceSnapshot(snapshot) {
        setSnapshot(snapshot);
      },
      replaceSyntheticSnapshot(entryCount, generation = 0) {
        const size = Math.max(0, Math.floor(Number(entryCount) || 0));
        uiState.filters.local = "";
        uiState.filters.remote = "";
        refs.localFilter.value = "";
        refs.remoteFilter.value = "";
        const makeEntry = (index, side) => {
          const directory = index % 9 === 0;
          const category = index % 5 === 0 ? "Project Alpha" : "Quarterly Report";
          const special = index % 97 === 0 ? "résumé" : "records";
          const rare = index === size - 1 ? " needle-exact-final" : "";
          const longName = index % 113 === 0 ? " — 長い Unicode filename with spaces" : "";
          const name = `${directory ? "Folder" : "File"} ${category} ${special} ${String(index).padStart(6, "0")}${rare}${longName}${directory ? "" : ".txt"}`;
          return {
            path: `/portal/${side}/deep/${generation}/${Math.floor(index / 1_000)}/${name}`,
            name,
            kind: directory ? "directory" : "file",
            size: directory ? 0 : (index * 7_919) % 50_000_000,
            mtimeMs: 1_700_000_000_000 + index,
          };
        };
        const listing = (side) => ({
          path: `/portal/${side}/deep/${generation}`,
          parentPath: `/portal/${side}`,
          rootPath: `/portal/${side}`,
          items: Array.from({ length: size }, (_, index) => makeEntry(index, side)),
        });
        const constructionStartedAt = performance.now();
        const localListing = listing("local");
        const remoteListing = listing("remote");
        const constructionDurationMs = performance.now() - constructionStartedAt;
        const startedAt = performance.now();
        setSnapshot({
          ...uiState.snapshot,
          panes: {
            local: { path: `/portal/local/deep/${generation}`, listing: localListing, error: null, loading: false },
            remote: { path: `/portal/remote/deep/${generation}`, listing: remoteListing, error: null, loading: false },
          },
        });
        return {
          constructionDurationMs,
          renderDurationMs: performance.now() - startedAt,
          localRows: refs.localList.querySelectorAll(".file-row").length,
          remoteRows: refs.remoteList.querySelectorAll(".file-row").length,
        };
      },
      applyEvent(event) {
        applyStateEvent(event);
      },
      searchStatus(side = "local") {
        const search = uiState.search[side];
        return {
          query: search.query,
          indexing: search.indexing,
          resultCount: search.results.length,
          topResultCount: search.topResults.length,
          generation: search.generation,
        };
      },
      comparisonStatus() {
        return {
          ready: comparisonCache.ready,
          generation: comparisonCache.generation,
          localStatuses: comparisonCache.localStatuses.size,
          remoteStatuses: comparisonCache.remoteStatuses.size,
        };
      },
      snapshot() {
        return uiState.snapshot;
      },
    }),
  });
}

await init();
