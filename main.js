const { app, BrowserWindow, screen, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { createRelayServer } = require('./relay-server');
const { createStaticServer } = require('./http-server');
const { autoUpdater } = require('electron-updater');

// An uncaught exception or unhandled promise rejection in the main process
// otherwise crashes the ENTIRE app (every window closes at once, not just
// one) — e.g. an unexpected error while repositioning the projection window
// in response to a display being plugged in mid-service. Log instead of
// letting Node terminate the process; the app staying up in a possibly-odd
// state is always better than it vanishing outright.
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception (kept app alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection (kept app alive):', reason);
});

// Matches RELAY_DEFAULT_PORT in app-src/js/panel/panel-app-core.js and
// BSP_display.html — both the panel and the display page already default to
// ws://127.0.0.1:<this port> on their own (see shouldKeepRelayConnected() /
// buildRelayUrl()) whenever running in this desktop shell or loaded from a
// file:// URL, so simply having a server listening here is enough; no other
// wiring is needed for panel <-> OBS-Browser-Source sync to start working.
const RELAY_PORT = 5511;
// Matches REMOTE_SHOW_DEFAULT_PORT in app-src/js/panel/panel-app-core.js —
// the renderer's getHttpPort()/buildRemoteShowUrl()/getVmixDisplayUrl() all
// already assume a plain HTTP server answers here (see http-server.js).
const HTTP_PORT = 5510;
let relayServerHandle = null;
let httpServerHandle = null;

// app-src/ is a read-only COPY of the existing Bible Song Pro OBS project
// (copied once at setup, never the original files) — this desktop shell never
// edits the original project. It loads this copy as window content and layers
// native window/display management on top via the window.BSPDesktop bridge
// that app already expects (see js/panel/output-and-streaming.js). Bundling a
// copy (rather than pointing at the external original folder) is what makes
// the packaged .exe self-contained and installable on its own.
const APP_SRC_DIR = path.join(__dirname, 'app-src');
const PANEL_HTML = path.join(APP_SRC_DIR, 'Bible Song Pro panel.html');
const DISPLAY_HTML = path.join(APP_SRC_DIR, 'BSP_display.html');

let controlWindow = null;
let controlWindowReady = false;
let outputWindow = null;
let outputWindowReady = false;
let lastTargetDisplayId = null;

// A real, browsable folder (not just data baked into the installer) holding
// the bundled sermon/song files, reachable from the native File menu — so the
// user can find and (re-)import them even after the automatic first-run
// import, e.g. if they deleted content and want it back.
const IMPORT_FOLDER = path.join(app.getPath('documents'), 'Message WMB Worship Pro', 'Fichiers a importer');
const BUNDLED_DATA_DIR = path.join(APP_SRC_DIR, 'bundled-data');

function ensureImportFolder() {
  try {
    fs.mkdirSync(IMPORT_FOLDER, { recursive: true });
    ['sermons.json', 'songs.json'].forEach((name) => {
      const src = path.join(BUNDLED_DATA_DIR, name);
      const dest = path.join(IMPORT_FOLDER, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, dest);
    });
  } catch (e) {
    console.error('Could not set up import folder', e);
  }
}

// Reuses importFileFromMenu(fileName, text) in js/panel/render-and-selection.js,
// which itself calls the same importBulkJsonText() used by drag-and-drop import.
function importFilesIntoPanel(filePaths) {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  filePaths.forEach((filePath) => {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const fileName = path.basename(filePath);
      controlWindow.webContents.executeJavaScript(
        `importFileFromMenu(${JSON.stringify(fileName)}, ${JSON.stringify(text)})`
      ).catch((e) => console.error('Menu import failed for', filePath, e));
    } catch (e) {
      console.error('Could not read file for import', filePath, e);
    }
  });
}

// Runs a snippet in the control panel's page context, wrapped so a missing
// function (a feature not currently active, e.g. vMix mode off or the Pro
// Mixer window not open) fails silently instead of showing an error — the
// same guard pattern already used by the "Ouvrir les paramètres" item.
function runInPanel(js) {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.webContents.executeJavaScript(js).catch(() => {});
}

function openSettingsTab(tabId) {
  runInPanel(`openModal('settingsModal'); if (typeof switchSettingsTab === 'function') switchSettingsTab('${tabId}');`);
}

function buildAppMenu() {
  const template = [
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Nouveau chant…',
          click: () => runInPanel("if (typeof openModal === 'function') openModal('newSongModal');")
        },
        { type: 'separator' },
        {
          label: 'Importer des fichiers…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(controlWindow, {
              title: 'Importer des sermons, chansons ou une bible',
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: 'Tous les fichiers pris en charge', extensions: ['json', 'xml', 'pdf'] },
                { name: 'Fichiers JSON', extensions: ['json'] },
                { name: 'Bible XML', extensions: ['xml'] },
                { name: 'PDF', extensions: ['pdf'] },
                { name: 'Tous les fichiers', extensions: ['*'] }
              ]
            });
            if (!result.canceled && result.filePaths.length) {
              importFilesIntoPanel(result.filePaths);
            }
          }
        },
        {
          label: 'Ouvrir le dossier des fichiers fournis',
          click: () => { shell.openPath(IMPORT_FOLDER); }
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' }
      ]
    },
    {
      label: 'Edition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        {
          label: 'Démarrer la sortie',
          click: () => runInPanel("if (typeof startOutputLive === 'function') startOutputLive();")
        },
        {
          label: 'Arrêter la sortie',
          click: () => runInPanel("if (typeof endOutputLive === 'function') endOutputLive();")
        },
        { type: 'separator' },
        {
          label: 'Grille des paragraphes (sermon)…',
          click: () => runInPanel("if (typeof openSermonParagraphGrid === 'function') openSermonParagraphGrid();")
        },
        {
          label: 'Récupération automatique des paroles…',
          click: () => runInPanel("if (typeof openModal === 'function') openModal('autoLyricsModal');")
        },
        { type: 'separator' },
        {
          label: 'vMix',
          submenu: [
            { label: 'Connexion', click: () => runInPanel("if (typeof vmixConnect === 'function') vmixConnect();") },
            { label: 'Rafraîchir', click: () => runInPanel("if (typeof vmixReconnect === 'function') vmixReconnect();") },
            { label: 'Afficher', click: () => runInPanel("if (typeof handleVmixShowAction === 'function') handleVmixShowAction();") },
            { label: 'Masquer', click: () => runInPanel("if (typeof handleVmixHideAction === 'function') handleVmixHideAction();") },
            { label: "Copier l'URL", click: () => runInPanel("if (typeof copyVmixDisplayUrl === 'function') copyVmixDisplayUrl();") }
          ]
        },
        {
          label: 'Pro Mixer',
          submenu: [
            { label: 'Ajouter un bus', click: () => runInPanel("if (typeof _promixMenuAddBus === 'function') _promixMenuAddBus();") },
            { label: 'FX Master…', click: () => runInPanel("if (typeof _promixMenuOpenMasterFx === 'function') _promixMenuOpenMasterFx();") },
            { label: 'Configuration audio…', click: () => runInPanel("if (typeof _promixMenuOpenSettings === 'function') _promixMenuOpenSettings();") },
            { type: 'separator' },
            { label: 'Réinitialiser Solo', click: () => runInPanel("if (typeof _promixMenuResetSolo === 'function') _promixMenuResetSolo();") },
            { label: 'Tout couper', click: () => runInPanel("if (typeof _promixMenuMuteAll === 'function') _promixMenuMuteAll();") },
            { label: 'Tout réactiver', click: () => runInPanel("if (typeof _promixMenuUnmuteAll === 'function') _promixMenuUnmuteAll();") },
            { label: 'Gain unitaire', click: () => runInPanel("if (typeof _promixMenuUnityGain === 'function') _promixMenuUnityGain();") }
          ]
        },
        {
          label: 'Streaming (Démarrer/Arrêter)',
          click: () => runInPanel("if (typeof pgmStreamToggle === 'function') pgmStreamToggle();")
        },
        { type: 'separator' },
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    },
    {
      label: 'Paramètres',
      submenu: [
        {
          label: 'Ouvrir les paramètres…',
          accelerator: 'CmdOrCtrl+,',
          click: () => runInPanel("openModal('settingsModal');")
        },
        { type: 'separator' },
        { label: 'Arrière-plan', click: () => openSettingsTab('background') },
        { label: "Écran d'accueil", click: () => openSettingsTab('idlescreen') },
        { label: 'Thèmes', click: () => openSettingsTab('themes') },
        { label: 'À propos', click: () => openSettingsTab('about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Relay queue (guaranteed-delivery IPC path for content sync) ---
// Strictly sequential and awaited (never fire-and-forget in parallel) — the
// earlier version fired one executeJavaScript per message without waiting for
// the previous one to finish, which could let messages resolve out of order in
// the renderer and get silently rejected by the display's own seq guard
// (acceptSeq). That looked like "some changes just don't show up" (background,
// font size) even though messages were being sent correctly.
let relayQueue = [];
let relaying = false;

function processRelayQueue() {
  if (relaying) return;
  if (!outputWindow || outputWindow.isDestroyed() || !outputWindowReady) return;
  const next = relayQueue.shift();
  if (!next) return;
  relaying = true;
  const payload = JSON.stringify(next);
  outputWindow.webContents.executeJavaScript(
    `window.handleInboundMessage(${payload}, 'ipc')`
  ).catch(() => {}).finally(() => {
    relaying = false;
    processRelayQueue();
  });
}

// Reverse direction of the queue above: the display window has no reliable
// way to tell the panel "I just (re)loaded, please resend the current state"
// — BroadcastChannel is the only other transport it has, and that's the same
// mechanism already proven unreliable between two separate Electron windows
// (see the comment on relayToOutput in preload.js). Without this, a display
// window that reloads for any reason (e.g. the render-process-gone recovery
// below, triggered by a GPU crash from a heavy video background) comes back
// blank and stays that way until the user happens to touch a control that
// re-triggers a push — which reads as "background stopped working".
let controlRelayQueue = [];
let controlRelaying = false;

function processControlRelayQueue() {
  if (controlRelaying) return;
  if (!controlWindow || controlWindow.isDestroyed() || !controlWindowReady) return;
  const next = controlRelayQueue.shift();
  if (!next) return;
  controlRelaying = true;
  const payload = JSON.stringify(next);
  controlWindow.webContents.executeJavaScript(
    `window.handleSyncMessage(${payload})`
  ).catch(() => {}).finally(() => {
    controlRelaying = false;
    processControlRelayQueue();
  });
}

// Reachable LAN addresses for this PC, used by the renderer (getVmixDisplayUrl(),
// updateRemoteShowDetails()) to build a working OBS Browser Source / vMix Input
// URL for a device on a DIFFERENT computer instead of leaving the user to find
// their own IP. IPv4 only; loopback is always appended last as the same-PC
// fallback, so a genuine LAN address is preferred whenever one exists.
function getLocalServerInfo() {
  const hosts = [];
  try {
    const interfaces = os.networkInterfaces();
    Object.values(interfaces).forEach((entries) => {
      (entries || []).forEach((entry) => {
        if (entry.family === 'IPv4' && !entry.internal && !hosts.includes(entry.address)) {
          hosts.push(entry.address);
        }
      });
    });
  } catch (err) {
    console.error('[main] getLocalServerInfo: could not read network interfaces', err);
  }
  hosts.push('127.0.0.1');
  return {
    httpPort: HTTP_PORT,
    relayPort: RELAY_PORT,
    preferredHost: hosts[0],
    availableHosts: hosts
  };
}

function describeDisplay(d, idx, primaryId) {
  return {
    id: String(d.id),
    label: d.id === primaryId ? 'Primary Display' : `Display ${idx + 1}`,
    left: d.bounds.x,
    top: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    isPrimary: d.id === primaryId,
    isInternal: d.id === primaryId
  };
}

function getDisplaysInfo() {
  const all = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  console.log(`[BSP] Displays detected: ${all.length} (mode: ${describeDisplayMode(all)})`);
  return all.map((d, idx) => describeDisplay(d, idx, primaryId));
}

// Windows reports the current multi-monitor arrangement (Extend / Duplicate /
// Second screen only / PC screen only) through the same screen.getAllDisplays()
// list Electron already exposes — there's no separate API to read the mode
// itself, but the practical effect ("where do the bounds put the projection
// window") is fully captured by comparing display bounds:
//   - Extend: 2+ displays with distinct, non-overlapping bounds.
//   - Duplicate: 2+ displays reported with identical/overlapping bounds.
//   - Second/PC screen only: exactly 1 display reported.
// pickTargetDisplay works correctly in all three cases without special-casing:
// picking "a" non-primary display places the window correctly whether that
// display is a distinct extended monitor or a duplicated/mirrored one.
function describeDisplayMode(all) {
  if (all.length <= 1) return 'single';
  const [a, b] = all;
  const sameBounds = a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
  return sameBounds ? 'duplicate' : 'extend';
}

function pickTargetDisplay(displayId) {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (displayId && displayId !== 'auto') {
    const match = all.find(d => String(d.id) === String(displayId));
    if (match) return match;
  }
  // "auto" (or no match found): prefer a non-primary display if one exists —
  // that's the physical projector/second monitor in a normal church setup.
  const nonPrimary = all.find(d => d.id !== primary.id);
  return nonPrimary || primary;
}

function repositionOutputWindowIfNeeded() {
  // Runs from a screen event (display plugged/unplugged/reconfigured mid-
  // service) — an exception here must never be allowed to escape and take
  // the uncaughtException path down with the whole app, so it's wrapped
  // locally in addition to that global safety net.
  try {
    if (!outputWindow || outputWindow.isDestroyed()) return;
    const target = pickTargetDisplay(lastTargetDisplayId || 'auto');
    const current = outputWindow.getBounds();
    const changed = current.x !== target.bounds.x || current.y !== target.bounds.y ||
      current.width !== target.bounds.width || current.height !== target.bounds.height;
    if (!changed) return;
    const wasFullScreen = outputWindow.isFullScreen();
    if (wasFullScreen) outputWindow.setFullScreen(false);
    outputWindow.setBounds(target.bounds);
    if (wasFullScreen) outputWindow.setFullScreen(true);
  } catch (err) {
    console.error('[main] repositionOutputWindowIfNeeded failed (display change while live):', err);
  }
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Message WMB Worship Pro - Panneau de contrôle',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Same reasoning as the output window: onAnyControlChange()'s live
      // push is scheduled via requestAnimationFrame (scheduleLiveUpdate),
      // which Chromium can throttle heavily in an unfocused/occluded
      // window — e.g. the operator alt-tabbing away, or the panel sitting
      // on a non-active monitor. Without this, a background/content change
      // made while the panel isn't focused can sit unsent for a long time.
      backgroundThrottling: false
    }
  });
  controlWindow.loadFile(PANEL_HTML);
  controlWindow.webContents.once('did-finish-load', () => {
    controlWindowReady = true;
    processControlRelayQueue();
  });
  controlWindow.on('closed', () => {
    controlWindow = null;
    controlWindowReady = false;
    if (outputWindow && !outputWindow.isDestroyed()) outputWindow.close();
    app.quit();
  });
  // A renderer crash (OOM, or a GPU crash from a display being plugged/
  // unplugged mid-service) used to leave the window permanently blank —
  // "Render process gone" in DevTools, with no way back short of manually
  // relaunching the whole app. Reload automatically instead so the app
  // recovers on its own; the panel's own state lives in IndexedDB, so a
  // reload restores it exactly like the existing "Recharger" menu item does.
  controlWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[main] Control window renderer gone:', details && details.reason);
    controlWindowReady = false;
    controlRelayQueue = [];
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.loadFile(PANEL_HTML);
    }
  });
}

function createOutputWindow(targetDisplay, opts = {}) {
  if (outputWindow && !outputWindow.isDestroyed()) return outputWindow;
  outputWindowReady = false;
  relayQueue = [];
  outputWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    title: 'Message WMB Worship Pro - Projection',
    // Same (default) session/partition as the control window, deliberately —
    // this app's existing BroadcastChannel-based sync between panel and
    // display only works when both windows share the same origin/partition.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // This window normally sits on a second monitor/projector and never
      // has OS focus (the operator works in the control window) — Chromium
      // treats an unfocused/occluded window's page as "hidden" and throttles
      // it, which was silently stalling background video playback at its
      // first frame (loaded fine, just never advanced). This is the
      // standard Electron fix for windows that must keep rendering/playing
      // regardless of focus.
      backgroundThrottling: false
    }
  });
  outputWindow.loadFile(DISPLAY_HTML);
  // Same recovery as the control window: a display being plugged/unplugged
  // mid-service is a plausible trigger for a GPU/renderer crash on this
  // window specifically (it's the one actually compositing video/animated
  // backgrounds) — reload it automatically instead of leaving the
  // projection permanently blank.
  outputWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[main] Output window renderer gone:', details && details.reason);
    if (!outputWindow || outputWindow.isDestroyed()) return;
    outputWindowReady = false;
    relayQueue = [];
    outputWindow.loadFile(DISPLAY_HTML);
  });
  outputWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape') {
      event.preventDefault();
      outputWindow.close();
      return;
    }
    // Advance/go back through content from the projection window itself —
    // same nextSlide()/prevSlide() already bound to these arrow keys in the
    // control window (see app-commands-and-shortcuts.js), just triggered here
    // via executeJavaScript so a presenter doesn't have to click back into the
    // control window to move forward/backward while presenting.
    if (!controlWindow || controlWindow.isDestroyed()) return;
    if (input.key === 'ArrowRight' || input.key === 'ArrowDown') {
      event.preventDefault();
      controlWindow.webContents.executeJavaScript('nextSlide()').catch(() => {});
    } else if (input.key === 'ArrowLeft' || input.key === 'ArrowUp') {
      event.preventDefault();
      controlWindow.webContents.executeJavaScript('prevSlide()').catch(() => {});
    }
  });
  // Don't relay/replay anything until the page has actually finished loading —
  // sending a message before handleInboundMessage exists yet silently drops it
  // (that looked like "content takes a few seconds to show up", since it really
  // only appeared once the NEXT unrelated update happened to fire afterwards).
  outputWindow.webContents.once('did-finish-load', () => {
    outputWindowReady = true;
    outputWindow.show();
    if (opts.requestFullscreen) outputWindow.setFullScreen(true);
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('bsp:outputReady');
    }
    processRelayQueue();
  });
  outputWindow.on('closed', () => {
    outputWindow = null;
    outputWindowReady = false;
    relayQueue = [];
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('bsp:outputClosed');
    }
  });
  return outputWindow;
}

// --- NDI output (optional alternative to an OBS Browser Source / vMix
// Browser Input) ---
// Runs an offscreen copy of the display page and streams its rendered
// frames as a standard NDI video source on the network — OBS and vMix
// (which has native NDI support) can pick it up directly, same PC or a
// different one, with no Browser Source/Input URL to configure. Video
// only, no audio: Electron has no simple API to capture audio from an
// offscreen window, and the service's program audio normally comes from
// the audio desk, not from this app.
//
// Must run in THIS main process, never the renderer — grandi is a native
// Node-API addon (see node_modules/grandi's "Electron and bundlers" guide:
// "Do not import Grandi into a renderer or browser bundle").
let grandiModule = null;
let grandiInitialized = false;
let ndiWindow = null;
let ndiSender = null;
let ndiPaintHandler = null;
let ndiHeartbeatTimer = null;
let ndiLastFrame = null;

// Serializes start/stop (and the cleanup from an unexpected window close) so
// two overlapping requests — e.g. the enable checkbox toggled twice in quick
// succession before the first IPC round-trip resolves — can never interleave
// and leak a duplicate offscreen window/NDI sender. Each queued op still
// returns its own settled result to its caller; ndiOpChain only tracks
// ordering and is never allowed to stay rejected (that would permanently
// wedge every later queued op behind it).
let ndiOpChain = Promise.resolve();
function queueNdiOp(fn) {
  const run = ndiOpChain.then(fn, fn);
  ndiOpChain = run.then(() => {}, () => {});
  return run;
}

function notifyNdiStatusChanged() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('bsp:ndiStatusChanged', { running: !!ndiSender });
  }
}

// grandi is ESM-only ("type": "module"); this file is CommonJS, so it's
// loaded via dynamic import() rather than require().
async function getGrandi() {
  if (!grandiModule) {
    grandiModule = (await import('grandi')).default;
  }
  return grandiModule;
}

function sendNdiFrame(frame) {
  if (!ndiSender || !frame) return;
  ndiSender.video(frame).catch((err) => {
    console.error('[ndi] video frame send failed:', err && err.message);
  });
}

async function startNdiOutput(opts = {}) {
  const grandi = await getGrandi();
  if (!grandi.isSupportedCPU()) {
    return { ok: false, error: 'NDI is not supported on this CPU/platform' };
  }
  if (!grandiInitialized) {
    if (!grandi.initialize()) {
      return { ok: false, error: 'NDI initialization failed' };
    }
    grandiInitialized = true;
  }

  // Changing name/resolution while already running: tear down and recreate
  // cleanly rather than trying to resize a live sender in place.
  if (ndiWindow || ndiSender) {
    await stopNdiOutput();
  }

  const width = Math.max(320, Math.round(Number(opts.width) || 1920));
  const height = Math.max(240, Math.round(Number(opts.height) || 1080));
  const fps = Math.max(1, Math.min(60, Math.round(Number(opts.fps) || 30)));
  const name = String(opts.name || '').trim() || 'Message WMB Worship Pro';

  try {
    ndiSender = await grandi.send({ name, clockVideo: true });
  } catch (err) {
    ndiSender = null;
    return { ok: false, error: err && err.message ? err.message : 'Could not create NDI sender' };
  }

  ndiWindow = new BrowserWindow({
    width,
    height,
    show: false,
    // frame:false + useContentSize avoids a native title bar/border eating
    // into width/height, same as the real projection window (outputWindow)
    // already does — otherwise the captured frame would end up slightly
    // smaller than the resolution requested in Settings.
    frame: false,
    useContentSize: true,
    // NDI must carry real per-pixel alpha, not a flat backgroundColor like
    // outputWindow's '#000000' — Lower Third mode is specifically meant to
    // be laid over a live camera source in OBS/vMix, so BSP_display.html's
    // own CSS (transparent everywhere except the lower-third banner itself)
    // has to reach the NDI frame as actual transparency, the same way OBS's
    // own Browser Source already renders it today. In Full Screen mode (or
    // any mode with a configured background) the PAGE's own CSS paints an
    // opaque color/image/video, so the visible result still matches the
    // projection window exactly — transparent:true only matters for the
    // pixels the page itself leaves transparent. A fresh window is always
    // created here (never reused across starts — see startNdiOutput()'s
    // teardown-then-recreate above), which avoids a known Electron
    // regression where a REUSED transparent offscreen window loses
    // transparency after its first capture.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Same reasoning as outputWindow: this window never has OS focus (it's
      // never even shown) — without this, Chromium's background-tab/hidden-
      // page throttling could stall video/animated backgrounds exactly like
      // it used to for the projection window before that fix was added.
      backgroundThrottling: false
    }
  });
  // Same display page as the real projection window, loaded the same way
  // (loadFile -> file:// protocol) — BSP_display.html already auto-connects
  // to the existing relay (relay-server.js, ws://127.0.0.1:RELAY_PORT) on
  // its own whenever it sees a file:// URL (see shouldKeepRelayConnected()'s
  // localFileAuto check in app-src/js/panel/remote-show-tools.js), so this
  // window receives the exact same live content with no extra sync code here.
  ndiWindow.loadFile(DISPLAY_HTML);
  ndiWindow.webContents.setFrameRate(fps);

  // image.getBitmap() returns the whole frame (not just dirtyRect) as a
  // BGRA buffer, which is exactly grandi's FourCC.BGRA layout — no color
  // conversion needed. If colors ever come out swapped on a real NDI
  // receiver, switch fourCC to grandi.FourCC.RGBA below as the fix.
  ndiPaintHandler = (event, dirtyRect, image) => {
    const size = image.getSize();
    if (!size || !size.width || !size.height) return;
    const frame = {
      xres: size.width,
      yres: size.height,
      frameRateN: fps * 1000,
      frameRateD: 1000,
      pictureAspectRatio: size.width / size.height,
      fourCC: grandi.FourCC.BGRA,
      frameFormatType: grandi.FrameType.Progressive,
      lineStrideBytes: size.width * 4,
      data: image.getBitmap()
    };
    ndiLastFrame = frame;
    sendNdiFrame(frame);
  };
  ndiWindow.webContents.on('paint', ndiPaintHandler);

  // Covers both an unexpected close (GPU/renderer crash — the same category
  // of failure the other windows already guard against with their own
  // render-process-gone handlers) and the normal stopNdiOutput() path, which
  // also triggers this event once the window actually finishes closing. By
  // then stopNdiOutput() has already nulled everything itself, so running it
  // again here is always a safe, cheap no-op in that case — but it's the
  // ONLY cleanup that runs for a crash, which otherwise would leave the
  // heartbeat timer re-sending a last frame that's now permanently frozen,
  // with the Settings UI still reporting NDI as live.
  ndiWindow.on('closed', () => {
    queueNdiOp(() => stopNdiOutput()).then(() => notifyNdiStatusChanged());
  });

  // Re-sends the last captured frame on a steady beat so an NDI receiver
  // never sees the source "stall" during a long static (no repaint) screen —
  // a lyrics slide with no motion can go a long time between real paint
  // events, which is expected, not a bug.
  ndiHeartbeatTimer = setInterval(() => {
    if (ndiLastFrame) sendNdiFrame(ndiLastFrame);
  }, 2000);

  notifyNdiStatusChanged();
  return { ok: true };
}

async function stopNdiOutput() {
  if (ndiHeartbeatTimer) {
    clearInterval(ndiHeartbeatTimer);
    ndiHeartbeatTimer = null;
  }
  if (ndiWindow && !ndiWindow.isDestroyed()) {
    if (ndiPaintHandler) {
      try { ndiWindow.webContents.removeListener('paint', ndiPaintHandler); } catch (e) { /* non-fatal */ }
    }
    try { ndiWindow.removeAllListeners('closed'); } catch (e) { /* non-fatal */ }
    try { ndiWindow.close(); } catch (e) { /* non-fatal */ }
  }
  ndiWindow = null;
  ndiPaintHandler = null;
  ndiLastFrame = null;
  if (ndiSender) {
    try { ndiSender.destroy(); } catch (e) { /* non-fatal */ }
  }
  ndiSender = null;
  notifyNdiStatusChanged();
  return { ok: true };
}

ipcMain.handle('bsp:ndiStart', async (event, opts) => {
  try {
    return await queueNdiOp(() => startNdiOutput(opts || {}));
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('bsp:ndiStop', async () => {
  try {
    return await queueNdiOp(() => stopNdiOutput());
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('bsp:ndiGetStatus', () => ({ running: !!ndiSender }));

ipcMain.handle('bsp:getDisplays', () => getDisplaysInfo());

ipcMain.handle('bsp:getLocalServerInfo', () => getLocalServerInfo());

ipcMain.handle('bsp:openOutput', (event, params = {}) => {
  try {
    lastTargetDisplayId = params.displayId || 'auto';
    const target = pickTargetDisplay(lastTargetDisplayId);
    const win = createOutputWindow(target, { requestFullscreen: !!params.requestFullscreen });
    if (params.reposition && !params.requestFullscreen) {
      win.setBounds(target.bounds);
    }
    if (params.activate) win.focus();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('bsp:closeOutput', () => {
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.close();
  return { ok: true };
});

ipcMain.handle('bsp:isOutputOpen', () => !!(outputWindow && !outputWindow.isDestroyed()));

ipcMain.handle('bsp:requestOutputFullscreen', () => {
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.setFullScreen(true);
  return { ok: true };
});

const MEDIA_FILE_FILTERS = {
  video: [{ name: 'Vidéos', extensions: ['mp4', 'mpeg', 'mpg', 'mov', 'm4v', 'avi', 'webm', 'ogv', 'mkv', 'gif'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
};

// Native OS file picker + a real file:// URL back for the picked file,
// entirely over IPC (no File object ever crosses the context bridge). Used
// for background image/video uploads instead of <input type="file"> +
// FileReader — that read the whole file into memory as a base64 string,
// which is what used to freeze/crash the app on "heavy" video backgrounds.
ipcMain.handle('bsp:pickMediaFile', async (event, opts = {}) => {
  const kind = opts && opts.kind === 'image' ? 'image' : 'video';
  const result = await dialog.showOpenDialog(controlWindow, {
    title: kind === 'image' ? 'Choisir une image' : 'Choisir une vidéo',
    properties: ['openFile'],
    filters: MEDIA_FILE_FILTERS[kind]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, url: pathToFileURL(filePath).href };
});

// Guaranteed-delivery relay: forwards every sync message straight into the
// projection window's page context via executeJavaScript, calling the exact
// same handleInboundMessage(d, source) function BSP_display.html already uses
// for BroadcastChannel messages — no duplicated logic, just a second, reliable
// transport alongside (not instead of) BroadcastChannel. Queued and processed
// one at a time (see processRelayQueue) to guarantee in-order delivery.
ipcMain.on('bsp:relay-to-output', (event, msg) => {
  relayQueue.push(msg == null ? {} : msg);
  // Cap backlog so a burst of rapid UI changes (e.g. dragging a font-size
  // slider) can't pile up a long queue of now-stale intermediate states.
  if (relayQueue.length > 5) relayQueue.splice(0, relayQueue.length - 5);
  processRelayQueue();
});

ipcMain.on('bsp:relay-to-control', (event, msg) => {
  controlRelayQueue.push(msg == null ? {} : msg);
  if (controlRelayQueue.length > 5) controlRelayQueue.splice(0, controlRelayQueue.length - 5);
  processControlRelayQueue();
});

// --- Auto-update (electron-updater, GitHub Releases) ---
// One-click flow: the panel's "Verifier les mises a jour" button only
// triggers the CHECK — everything past that (download, install, restart) then
// runs automatically with no further clicks needed, since the church's
// operators shouldn't have to understand a multi-step updater UI. Publish
// target is configured in package.json (build.publish), which points at the
// church's own GitHub repo.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

const INSTALL_COUNTDOWN_SECONDS = 5;

function sendUpdateStatus(payload) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('bsp:updateStatus', payload);
  }
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
autoUpdater.on('update-available', (info) => {
  sendUpdateStatus({ state: 'available', version: info && info.version, releaseNotes: typeof (info && info.releaseNotes) === 'string' ? info.releaseNotes : '' });
});
autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'none' }));
autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus({ state: 'downloading', percent: progress && progress.percent });
});
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus({ state: 'downloaded', version: info && info.version, countdown: INSTALL_COUNTDOWN_SECONDS });
  // Give the operator a few seconds to see what's happening (and to notice if
  // they need to abort — e.g. mid-service) before the app closes itself and
  // relaunches into the installed update.
  let remaining = INSTALL_COUNTDOWN_SECONDS;
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(tick);
      autoUpdater.quitAndInstall();
      return;
    }
    sendUpdateStatus({ state: 'downloaded', version: info && info.version, countdown: remaining });
  }, 1000);
});
autoUpdater.on('error', (err) => {
  console.error('[main] autoUpdater error:', err);
  sendUpdateStatus({ state: 'error', message: err && err.message ? err.message : String(err) });
});

ipcMain.handle('bsp:checkForUpdates', async () => {
  if (!app.isPackaged) {
    sendUpdateStatus({ state: 'dev-mode' });
    return { ok: true };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('bsp:installUpdateNow', async () => {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Diagnostics only (e.g. a GPU process crash from a display being plugged in
// mid-service) — Chromium normally restarts the GPU process on its own; the
// render-process-gone handlers on each window are what actually recover the
// visible windows if a crash reaches them.
app.on('child-process-gone', (event, details) => {
  console.error('[main] Child process gone:', details && details.type, details && details.reason);
});

app.whenReady().then(() => {
  ensureImportFolder();
  buildAppMenu();
  createControlWindow();
  createRelayServer(RELAY_PORT, { log: (m) => console.log('[relay]', m) })
    .then((handle) => { relayServerHandle = handle; })
    .catch((err) => console.error('[relay] failed to start on port', RELAY_PORT, err));
  createStaticServer(HTTP_PORT, APP_SRC_DIR, { log: (m) => console.log('[http]', m) })
    .then((handle) => { httpServerHandle = handle; })
    .catch((err) => console.error('[http] failed to start on port', HTTP_PORT, err));
  // Re-detect and reposition whenever the OS display arrangement changes while
  // the projection window is open (projector plugged in/out, switching between
  // Extend/Duplicate mid-service, resolution change, etc.). The screen module
  // can only be used after 'ready', hence registering these here.
  screen.on('display-added', repositionOutputWindowIfNeeded);
  screen.on('display-removed', repositionOutputWindowIfNeeded);
  screen.on('display-metrics-changed', repositionOutputWindowIfNeeded);
  // The projection window is opened manually via the Output button in the
  // panel (startOutputLive()/toggleOutputLive()) — not automatically at
  // startup, per explicit request, so the user stays in control of when a
  // second window/screen activates.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Destroy the NDI sender before shutting down the NDI library itself — order
// matters per grandi's own lifecycle guidance ("destroy all finders, senders,
// receivers... before you call grandi.destroy()").
app.on('before-quit', () => {
  queueNdiOp(() => stopNdiOutput()).catch(() => {}).then(() => {
    if (grandiInitialized && grandiModule) {
      try { grandiModule.destroy(); } catch (e) { /* non-fatal, app is quitting anyway */ }
    }
  });
});
