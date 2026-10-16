const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("peergrading", Object.freeze({
  chooseRepository: () => ipcRenderer.invoke("peergrading:choose-repository"),
  openAccount: (section) => ipcRenderer.invoke("peergrading:open-account", section),
  enterWorkspace: () => ipcRenderer.invoke("peergrading:enter-workspace"),
  openExternal: (url) => ipcRenderer.invoke("peergrading:open-external", url),
}));
