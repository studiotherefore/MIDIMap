// The editor's way to ask the app for things a web page can't do: list the
// displays, open the full-screen output window on one, and read/set Syphon.
// The editor checks for window.midimapApp; in a plain browser it isn't there.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('midimapApp', {
  displays: () => ipcRenderer.invoke('displays'),
  openOutput: (options) => ipcRenderer.invoke('open-output', options),
  closeOutput: () => ipcRenderer.invoke('close-output'),
  toggleOutputFullscreen: () => ipcRenderer.invoke('toggle-output-fullscreen'),
  onOutputClosed: (callback) => ipcRenderer.on('output-closed', () => callback()),
  syphon: () => ipcRenderer.invoke('syphon'),
  setSyphonFps: (fps) => ipcRenderer.invoke('set-syphon-fps', fps),
});
