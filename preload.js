const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

// Implements the subset of window.BSPDesktop that js/panel/output-and-streaming.js
// already knows how to call (it feature-detects every method before using it, so
// leaving the rest — NDI, streaming, recording, plugins — unimplemented for now is
// safe; those calls simply fall back to their existing browser-only behavior).
contextBridge.exposeInMainWorld('BSPDesktop', {
  getDisplays: () => ipcRenderer.invoke('bsp:getDisplays'),
  openOutput: (params) => ipcRenderer.invoke('bsp:openOutput', params),
  closeOutput: () => ipcRenderer.invoke('bsp:closeOutput'),
  isOutputOpen: () => ipcRenderer.invoke('bsp:isOutputOpen'),
  requestOutputFullscreen: () => ipcRenderer.invoke('bsp:requestOutputFullscreen'),
  onOutputClosed: (callback) => {
    ipcRenderer.on('bsp:outputClosed', () => callback());
  },
  // Guaranteed-delivery path for content sync, used alongside (not instead of)
  // the app's existing BroadcastChannel sync — see broadcastMessage() in
  // js/panel/sync-and-output.js. BroadcastChannel across two separate Electron
  // BrowserWindows proved unreliable, so this relays the same message straight
  // through the main process into the projection window's page context.
  relayToOutput: (msg) => ipcRenderer.send('bsp:relay-to-output', msg),
  // Reverse direction: lets the projection window (BSP_display.html) reach
  // the control panel reliably too — used for its HELLO/PONG "I'm alive,
  // please resend current state" messages, which otherwise only have the
  // same unreliable cross-window BroadcastChannel to travel over.
  relayToControl: (msg) => ipcRenderer.send('bsp:relay-to-control', msg),
  // Real filesystem path for a File the user picked via <input type="file">.
  // Used so background images/videos are referenced by a lightweight file://
  // URL instead of being read into memory as a base64 data URL — a large
  // video encoded to base64 (and then synced to the projection window and
  // persisted to IndexedDB) is what was crashing the app on "heavy" video
  // backgrounds. Requires Electron's webUtils (added in Electron 32).
  getFileUrlForFile: (file) => {
    try {
      const realPath = webUtils.getPathForFile(file);
      if (!realPath) {
        console.error('[BSPDesktop] getPathForFile returned empty for', file && file.name);
        return null;
      }
      return pathToFileURL(realPath).href;
    } catch (e) {
      console.error('[BSPDesktop] getFileUrlForFile failed for', file && file.name, e);
      return null;
    }
  },
  // Native OS file picker for background image/video, entirely over IPC —
  // returns { path, url } or null if the user cancelled. Preferred over
  // getFileUrlForFile()/<input type="file"> for this: no File object has to
  // cross the context bridge at all, which is the one part of that approach
  // that isn't fully verifiable without a live Electron window to test in.
  pickMediaFile: (opts) => ipcRenderer.invoke('bsp:pickMediaFile', opts),
  // Manual, button-driven auto-update via electron-updater / GitHub Releases
  // (see main.js) — checkForUpdates/downloadUpdate/installUpdateNow never run
  // on their own; the panel's Settings > À propos update controls call these.
  checkForUpdates: () => ipcRenderer.invoke('bsp:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('bsp:downloadUpdate'),
  installUpdateNow: () => ipcRenderer.invoke('bsp:installUpdateNow'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('bsp:updateStatus', (event, payload) => callback(payload));
  }
});
