const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  login: () => ipcRenderer.invoke('ig:login'),
  request: o => ipcRenderer.invoke('ig:request', o)
});
