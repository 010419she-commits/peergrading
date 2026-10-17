const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("peergrading", Object.freeze({
  chooseRepository: () => ipcRenderer.invoke("peergrading:choose-repository"),
  openExternal: (url) => ipcRenderer.invoke("peergrading:open-external", url),
}));
