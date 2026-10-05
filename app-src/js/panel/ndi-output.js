// ===== NDI OUTPUT (alternative to OBS Browser Source / vMix Browser Input) =====
//
// Streams the display page as a standard NDI video source instead of
// requiring OBS/vMix to load a Browser Source/Input URL — OBS and vMix (which
// has native NDI support) can pick it up directly over the network, same PC
// or a different one. The actual NDI sender runs in the Electron main
// process (see main.js / node_modules/grandi) — this file only talks to it
// over IPC via window.BSPDesktop, and only shows/enables its Settings UI when
// that bridge exists, since plain OBS browser docks have no NDI capability.
//
// Video only, no audio (see main.js for why).

    function hasNdiRuntime() {
      return !!(window.BSPDesktop && typeof window.BSPDesktop.ndiStart === 'function');
    }

    let ndiStatusListenerBound = false;
    function ensureNdiStatusListener() {
      if (ndiStatusListenerBound || !hasNdiRuntime() || typeof window.BSPDesktop.onNdiStatusChanged !== 'function') return;
      ndiStatusListenerBound = true;
      // Keeps the Settings UI correct even when NDI stops on its own (e.g.
      // the offscreen window's renderer crashing) rather than only reflecting
      // whatever this tab itself last requested.
      window.BSPDesktop.onNdiStatusChanged((payload) => {
        ndiRunning = !!(payload && payload.running);
        if (ndiRunning) {
          ndiLastError = '';
        } else if (ndiState.enabled) {
          ndiLastError = ndiLastError || 'NDI output stopped unexpectedly';
        }
        updateNdiStatusUi();
      });
    }

    function getNdiSettings() {
      return { ...ndiState };
    }

    function updateNdiSettings(patch = {}, opts = {}) {
      ndiState = { ...ndiState, ...patch };
      updateNdiStatusUi();
      if (!opts.silent) saveToStorageDebounced();
    }

    function updateNdiStatusUi() {
      const panel = document.getElementById('ndi-output-panel');
      const statusEl = document.getElementById('ndi-status-label');
      const unavailableEl = document.getElementById('ndi-unavailable-note');
      const available = hasNdiRuntime();
      if (panel) panel.style.display = available ? 'flex' : 'none';
      if (unavailableEl) unavailableEl.style.display = available ? 'none' : '';
      if (!statusEl) return;
      if (!ndiState.enabled) statusEl.textContent = 'NDI output disabled';
      else if (ndiRunning) statusEl.textContent = `NDI live: "${ndiState.name}"`;
      else if (ndiLastError) statusEl.textContent = `NDI error: ${ndiLastError}`;
      else statusEl.textContent = 'NDI starting...';
    }

    async function refreshNdiStatus() {
      if (!hasNdiRuntime()) return;
      try {
        const status = await window.BSPDesktop.ndiGetStatus();
        ndiRunning = !!(status && status.running);
      } catch (e) {
        ndiRunning = false;
      }
      updateNdiStatusUi();
    }

    async function applyNdiRuntimeState() {
      if (!hasNdiRuntime()) return;
      if (!ndiState.enabled) {
        try { await window.BSPDesktop.ndiStop(); } catch (e) { /* non-fatal */ }
        ndiRunning = false;
        ndiLastError = '';
        updateNdiStatusUi();
        return;
      }
      try {
        const result = await window.BSPDesktop.ndiStart({
          name: ndiState.name,
          width: ndiState.width,
          height: ndiState.height
        });
        if (result && result.ok) {
          ndiRunning = true;
          ndiLastError = '';
        } else {
          ndiRunning = false;
          ndiLastError = (result && result.error) || 'Could not start NDI output';
        }
      } catch (error) {
        ndiRunning = false;
        ndiLastError = error && error.message ? error.message : 'Could not start NDI output';
      }
      updateNdiStatusUi();
    }

    function restoreNdiSettingsUi() {
      ensureNdiStatusListener();
      const enableEl = document.getElementById('ndi-enable');
      const nameEl = document.getElementById('ndi-name');
      const widthEl = document.getElementById('ndi-width');
      const heightEl = document.getElementById('ndi-height');
      if (enableEl) enableEl.checked = !!ndiState.enabled;
      if (nameEl) nameEl.value = ndiState.name || '';
      if (widthEl) widthEl.value = ndiState.width || 1920;
      if (heightEl) heightEl.value = ndiState.height || 1080;
      updateNdiStatusUi();
      // Pure UI sync only — safe to call this function repeatedly (it runs at
      // several points during startup/state restore, like its vMix/OBS
      // WebSocket counterparts). refreshNdiStatus() just reflects whatever
      // the main process is already doing; it never itself starts/stops NDI.
      // The one-time actual "auto-start NDI on launch" call lives next to
      // the equivalent vMix/OBS WebSocket startup reconnects — see
      // bootstrap-and-init.js.
      refreshNdiStatus();
    }

    function bindNdiSettingsInputs() {
      const bindings = [
        ['ndi-enable', (el) => ({ enabled: el.checked })],
        ['ndi-name', (el) => ({ name: el.value.trim() })],
        ['ndi-width', (el) => ({ width: Math.max(320, Number(el.value) || 1920) })],
        ['ndi-height', (el) => ({ height: Math.max(240, Number(el.value) || 1080) })]
      ];
      bindings.forEach(([id, buildPatch]) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.bound) return;
        el.dataset.bound = '1';
        const eventName = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(eventName, () => {
          updateNdiSettings(buildPatch(el));
          // Only the enable toggle restarts NDI automatically. Name/width/
          // height deliberately do NOT auto-restart on every keystroke (that
          // would tear down and recreate the offscreen window + NDI sender on
          // every character typed) — edited values apply via the explicit
          // "Apply" button below, same convention as vMix/OBS WebSocket's
          // "Connect" buttons elsewhere in Settings.
          if (id === 'ndi-enable') applyNdiRuntimeState();
        });
      });
      const applyBtn = document.getElementById('btn-ndi-apply');
      if (applyBtn && !applyBtn.dataset.bound) {
        applyBtn.dataset.bound = '1';
        applyBtn.addEventListener('click', () => {
          if (!ndiState.enabled) {
            showToast('Enable NDI output first');
            return;
          }
          applyNdiRuntimeState();
        });
      }
    }
