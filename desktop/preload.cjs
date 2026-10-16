const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("peergrading", Object.freeze({
  chooseRepository: () => ipcRenderer.invoke("peergrading:choose-repository"),
}));
