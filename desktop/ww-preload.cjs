const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wwApi", {
  // This exposes only an opt-in boolean. Diagnostic samples never include the
  // environment or any transfer paths/tokens.
  diagnosticsEnabled: process.env.WW_PERF_DIAGNOSTICS === "1",
  getState: () => ipcRenderer.invoke("ww:get-state"),
  closeWindow: () => ipcRenderer.invoke("ww:close-window"),
  autoLink: () => ipcRenderer.invoke("ww:auto-link"),
  focusWindow: (target) => ipcRenderer.invoke("ww:focus-window", target),
  openPath: (side, targetPath) => ipcRenderer.invoke("ww:open-path", side, targetPath),
  refresh: (side = null) => ipcRenderer.invoke("ww:refresh", side),
  setHidden: (value) => ipcRenderer.invoke("ww:set-hidden", value),
  connect: (peer) => ipcRenderer.invoke("ww:connect", peer),
  disconnect: () => ipcRenderer.invoke("ww:disconnect"),
  createItem: (side, payload) => ipcRenderer.invoke("ww:create-item", side, payload),
  renameItem: (side, payload) => ipcRenderer.invoke("ww:rename-item", side, payload),
  deleteItems: (side, payload) => ipcRenderer.invoke("ww:delete-items", side, payload),
  listDeletedItems: (side) => ipcRenderer.invoke("ww:list-deleted-items", side),
  restoreDeletedItem: (side, payload) => ipcRenderer.invoke("ww:restore-deleted-item", side, payload),
  transfer: (payload) => ipcRenderer.invoke("ww:transfer", payload),
  explorerOpen: (targetPath = "") => ipcRenderer.invoke("ww:explorer-open", targetPath),
  explorerClose: () => ipcRenderer.invoke("ww:explorer-close"),
  explorerFetch: (payload) => ipcRenderer.invoke("ww:explorer-fetch", payload),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("ww:event", listener);
    return () => ipcRenderer.removeListener("ww:event", listener);
  },
});
