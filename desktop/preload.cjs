const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("peergrading", Object.freeze({
  theme: ipcRenderer.sendSync("peergrading:initial-theme"),
  getTheme: () => ipcRenderer.invoke("peergrading:get-theme"),
  setTheme: (theme) => ipcRenderer.invoke("peergrading:set-theme", theme),
  chooseRepository: () => ipcRenderer.invoke("peergrading:choose-repository"),
  openExternal: (url) => ipcRenderer.invoke("peergrading:open-external", url),
}));
