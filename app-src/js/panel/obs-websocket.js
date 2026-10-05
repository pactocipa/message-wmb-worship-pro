// ===== OBS WEBSOCKET (real scene control) =====
//
// Unlike vMix (js/panel/vmix-and-translation.js), OBS Studio is already used
// as a container for the display page (Browser Source) — this module adds a
// SEPARATE, independent capability on top of that: controlling OBS itself
// (switching the active scene) via the official obs-websocket plugin
// (built into OBS 28+, Tools -> WebSocket Server Settings). It is gated only
// on obsWsState.enabled, not on hostMode, so it works regardless of how the
// display page itself is embedded.
//
// Implemented with native WebSocket + Web Crypto (crypto.subtle), no npm
// dependency — same reasoning as the vMix module (plain fetch) and the
// desktop shell's relay-server.js (plain Node http/crypto): this file runs
// equally well inside the Electron panel or a plain OBS browser dock.
//
// Protocol: obs-websocket v5 (https://github.com/obsproject/obs-websocket).
// Opcodes used: 0 Hello, 1 Identify, 2 Identified, 6 Request, 7 RequestResponse.

    async function obsWsSha256Base64(str) {
      const bytes = new TextEncoder().encode(str);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const arr = new Uint8Array(digest);
      let binary = '';
      for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
      return btoa(binary);
    }

    // obs-websocket v5 auth: secret = b64(sha256(password + salt));
    // response = b64(sha256(secret + challenge)).
    async function obsWsBuildAuthResponse(password, salt, challenge) {
      const secret = await obsWsSha256Base64(String(password || '') + String(salt || ''));
      return await obsWsSha256Base64(secret + String(challenge || ''));
    }

    function getObsWsUrl() {
      const host = String(obsWsState.host || '').trim() || '127.0.0.1';
      const port = String(obsWsState.port || '').trim() || '4455';
      return `ws://${host}:${port}`;
    }

    function getObsWsSettings() {
      return { ...obsWsState };
    }

    function updateObsWsSettings(patch = {}, opts = {}) {
      obsWsState = { ...obsWsState, ...patch };
      updateObsWsStatusUi();
      if (!opts.silent) saveToStorageDebounced();
    }

    function updateObsWsStatusUi() {
      const panel = document.getElementById('obs-ws-status-panel');
      const bodyEl = document.getElementById('obs-ws-status-body');
      const toggleEl = document.getElementById('btn-obs-ws-panel-toggle');
      const connectionEl = document.getElementById('obs-ws-connection-label');
      const summaryEl = document.getElementById('obs-ws-status-summary');
      const sceneEl = document.getElementById('obs-ws-current-scene-label');
      if (panel) panel.style.display = obsWsState.enabled ? '' : 'none';
      if (bodyEl) bodyEl.style.display = panel && panel.classList.contains('is-collapsed') ? 'none' : 'flex';
      if (toggleEl) toggleEl.textContent = panel && panel.classList.contains('is-collapsed') ? '>' : 'v';
      let label = 'OBS WebSocket disabled';
      if (obsWsState.enabled) {
        if (obsWsConnectionState === 'connected') label = 'OBS connected';
        else if (obsWsConnectionState === 'connecting') label = 'Connecting to OBS...';
        else if (obsWsConnectionState === 'error') label = `OBS error: ${obsWsLastError || 'Unknown error'}`;
        else label = 'OBS disconnected';
      }
      if (connectionEl) connectionEl.textContent = label;
      if (summaryEl) summaryEl.textContent = label;
      if (sceneEl) sceneEl.textContent = obsWsCurrentScene ? `Current scene: ${obsWsCurrentScene}` : 'Current scene: -';
    }

    function toggleObsWsStatusPanel() {
      const panel = document.getElementById('obs-ws-status-panel');
      if (!panel) return;
      panel.classList.toggle('is-collapsed');
      updateObsWsStatusUi();
    }

    function setObsWsConnectionState(next, reason = '') {
      obsWsConnectionState = next;
      if (next === 'connected') obsWsLastError = '';
      else if (reason) obsWsLastError = reason;
      updateObsWsStatusUi();
    }

    function obsWsPopulateSceneSelects() {
      const selectIds = ['obs-ws-live-scene', 'obs-ws-clear-scene', 'obs-ws-manual-scene'];
      selectIds.forEach((id) => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        const options = ['<option value="">-- Select a scene --</option>']
          .concat(obsWsSceneList.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`));
        select.innerHTML = options.join('');
        if (obsWsSceneList.includes(current)) select.value = current;
      });
      const liveSelect = document.getElementById('obs-ws-live-scene');
      const clearSelect = document.getElementById('obs-ws-clear-scene');
      if (liveSelect && obsWsState.liveSceneName && obsWsSceneList.includes(obsWsState.liveSceneName)) {
        liveSelect.value = obsWsState.liveSceneName;
      }
      if (clearSelect && obsWsState.clearSceneName && obsWsSceneList.includes(obsWsState.clearSceneName)) {
        clearSelect.value = obsWsState.clearSceneName;
      }
    }

    function obsWsSendRaw(obj) {
      if (!obsWsSocket || obsWsSocket.readyState !== WebSocket.OPEN) return false;
      try {
        obsWsSocket.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        return false;
      }
    }

    function obsWsRequest(requestType, requestData) {
      return new Promise((resolve, reject) => {
        if (!obsWsSocket || obsWsSocket.readyState !== WebSocket.OPEN) {
          reject(new Error('Not connected to OBS'));
          return;
        }
        obsWsRequestSeq += 1;
        const requestId = `bsp_${Date.now()}_${obsWsRequestSeq}`;
        obsWsPendingRequests.set(requestId, { resolve, reject });
        const payload = { op: 6, d: { requestType, requestId } };
        if (requestData) payload.d.requestData = requestData;
        const sent = obsWsSendRaw(payload);
        if (!sent) {
          obsWsPendingRequests.delete(requestId);
          reject(new Error('Could not send request to OBS'));
          return;
        }
        setTimeout(() => {
          if (!obsWsPendingRequests.has(requestId)) return;
          obsWsPendingRequests.delete(requestId);
          reject(new Error(`OBS request "${requestType}" timed out`));
        }, 8000);
      });
    }

    async function obsWsRefreshSceneList() {
      try {
        const data = await obsWsRequest('GetSceneList');
        obsWsSceneList = Array.isArray(data.scenes) ? data.scenes.map((s) => s.sceneName).filter(Boolean) : [];
        obsWsCurrentScene = data.currentProgramSceneName || '';
        obsWsPopulateSceneSelects();
        updateObsWsStatusUi();
        return obsWsSceneList;
      } catch (error) {
        obsWsLastError = error && error.message ? error.message : 'Could not load scene list';
        updateObsWsStatusUi();
        return [];
      }
    }

    async function obsWsSetScene(sceneName) {
      const name = String(sceneName || '').trim();
      if (!name || !obsWsState.enabled) return false;
      if (!obsWsSocket || obsWsSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to OBS');
        return false;
      }
      try {
        await obsWsRequest('SetCurrentProgramScene', { sceneName: name });
        obsWsCurrentScene = name;
        updateObsWsStatusUi();
        return true;
      } catch (error) {
        showToast(error && error.message ? error.message : 'Could not switch OBS scene');
        return false;
      }
    }

    // Called unconditionally alongside the existing vMix hooks — independent of
    // host mode, gated only on obsWsState's own flags (see songs-and-bible.js).
    async function obsWsAfterProjectLive() {
      if (!obsWsState.enabled || !obsWsState.autoSwitchOnProject || !obsWsState.liveSceneName) return;
      await obsWsSetScene(obsWsState.liveSceneName);
    }

    async function obsWsAfterClear() {
      if (!obsWsState.enabled || !obsWsState.autoSwitchOnClear || !obsWsState.clearSceneName) return;
      await obsWsSetScene(obsWsState.clearSceneName);
    }

    function rejectAllPendingObsWsRequests(message) {
      obsWsPendingRequests.forEach((pending) => pending.reject(new Error(message)));
      obsWsPendingRequests.clear();
    }

    function stopObsWsHeartbeat() {
      if (obsWsHeartbeatTimer) {
        clearInterval(obsWsHeartbeatTimer);
        obsWsHeartbeatTimer = null;
      }
    }

    // obs-websocket has no app-level ping like the RemoteShow relay does — a
    // dead connection (cable pulled, Wi-Fi drop, OBS force-quit without a
    // clean close) can otherwise sit at readyState OPEN indefinitely with no
    // close/error event ever firing, leaving the Settings panel stuck
    // showing "OBS connected" long after OBS is actually unreachable. A
    // cheap periodic request stands in for a real ping: if it ever times
    // out, force a reconnect.
    function startObsWsHeartbeat() {
      stopObsWsHeartbeat();
      obsWsHeartbeatTimer = setInterval(() => {
        if (!obsWsSocket || obsWsSocket.readyState !== WebSocket.OPEN) return;
        obsWsRequest('GetVersion').catch(() => {
          if (obsWsSocket && obsWsSocket.readyState === WebSocket.OPEN) {
            scheduleObsWsReconnect('Heartbeat timeout');
          }
        });
      }, 15000);
    }

    function disconnectObsWs(opts = {}) {
      if (obsWsReconnectTimer) {
        clearTimeout(obsWsReconnectTimer);
        obsWsReconnectTimer = null;
      }
      stopObsWsHeartbeat();
      rejectAllPendingObsWsRequests('OBS disconnected');
      if (obsWsSocket) {
        try {
          obsWsSocket.onopen = null;
          obsWsSocket.onclose = null;
          obsWsSocket.onerror = null;
          obsWsSocket.onmessage = null;
          obsWsSocket.close();
        } catch (e) { /* non-fatal */ }
      }
      obsWsSocket = null;
      if (opts.markIdle) setObsWsConnectionState('disconnected', opts.reason || '');
    }

    function scheduleObsWsReconnect(reason) {
      if (obsWsReconnectTimer || !obsWsState.enabled) return;
      obsWsRetryAttempt += 1;
      const base = Math.min(1000 * Math.pow(2, Math.max(0, obsWsRetryAttempt - 1)), 30000);
      const jitter = 0.85 + (Math.random() * 0.3);
      const delay = Math.round(base * jitter);
      setObsWsConnectionState('error', reason || 'Retrying OBS connection');
      obsWsReconnectTimer = setTimeout(() => {
        obsWsReconnectTimer = null;
        obsWsConnect();
      }, delay);
    }

    async function obsWsHandleHello(data) {
      obsWsRpcVersion = Number(data.rpcVersion) || 1;
      const identify = { rpcVersion: obsWsRpcVersion, eventSubscriptions: 0 };
      if (data.authentication) {
        identify.authentication = await obsWsBuildAuthResponse(
          obsWsState.password, data.authentication.salt, data.authentication.challenge
        );
      }
      obsWsSendRaw({ op: 1, d: identify });
    }

    function obsWsHandleMessage(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      const d = msg && msg.d ? msg.d : {};
      if (msg.op === 0) {
        obsWsHandleHello(d).catch((error) => {
          // A wrong password or a momentary OBS-side hiccup during the
          // handshake must still self-heal like any other disconnect —
          // disconnectObsWs() alone detaches onclose before closing, so
          // without explicitly rescheduling here, an auth failure would
          // otherwise get stuck in "error" state forever with no retry.
          const message = error && error.message ? error.message : 'Authentication failed';
          disconnectObsWs();
          if (obsWsState.enabled) scheduleObsWsReconnect(message);
          else setObsWsConnectionState('error', message);
        });
        return;
      }
      if (msg.op === 2) {
        obsWsRetryAttempt = 0;
        setObsWsConnectionState('connected');
        obsWsRefreshSceneList().catch(() => {});
        startObsWsHeartbeat();
        return;
      }
      if (msg.op === 7) {
        const pending = obsWsPendingRequests.get(d.requestId);
        if (!pending) return;
        obsWsPendingRequests.delete(d.requestId);
        if (d.requestStatus && d.requestStatus.result) {
          pending.resolve(d.responseData || {});
        } else {
          pending.reject(new Error((d.requestStatus && d.requestStatus.comment) || 'OBS request failed'));
        }
      }
    }

    function obsWsConnect() {
      if (!obsWsState.enabled) {
        disconnectObsWs({ markIdle: true, reason: 'OBS WebSocket disabled' });
        return;
      }
      if (!String(obsWsState.host || '').trim() || !String(obsWsState.port || '').trim()) {
        setObsWsConnectionState('error', 'Host or port missing');
        return;
      }
      disconnectObsWs();
      const url = getObsWsUrl();
      setObsWsConnectionState('connecting');
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        setObsWsConnectionState('error', e && e.message ? e.message : 'Could not open socket');
        scheduleObsWsReconnect('Socket init failed');
        return;
      }
      obsWsSocket = socket;
      socket.onmessage = obsWsHandleMessage;
      socket.onclose = () => {
        rejectAllPendingObsWsRequests('OBS connection closed');
        if (obsWsState.enabled) scheduleObsWsReconnect('Connection closed');
        else setObsWsConnectionState('disconnected');
      };
      socket.onerror = () => {
        setObsWsConnectionState('error', 'WebSocket error');
      };
    }

    function obsWsReconnect() {
      obsWsRetryAttempt = 0;
      disconnectObsWs();
      obsWsConnect();
    }

    function restoreObsWsSettingsUi() {
      const enableEl = document.getElementById('obs-ws-enable');
      const hostEl = document.getElementById('obs-ws-host');
      const portEl = document.getElementById('obs-ws-port');
      const passwordEl = document.getElementById('obs-ws-password');
      const liveSceneEl = document.getElementById('obs-ws-live-scene');
      const clearSceneEl = document.getElementById('obs-ws-clear-scene');
      const autoLiveEl = document.getElementById('obs-ws-auto-live');
      const autoClearEl = document.getElementById('obs-ws-auto-clear');
      if (enableEl) enableEl.checked = !!obsWsState.enabled;
      if (hostEl) hostEl.value = obsWsState.host || '';
      if (portEl) portEl.value = obsWsState.port || '';
      if (passwordEl) passwordEl.value = obsWsState.password || '';
      if (liveSceneEl) liveSceneEl.value = obsWsState.liveSceneName || '';
      if (clearSceneEl) clearSceneEl.value = obsWsState.clearSceneName || '';
      if (autoLiveEl) autoLiveEl.checked = !!obsWsState.autoSwitchOnProject;
      if (autoClearEl) autoClearEl.checked = !!obsWsState.autoSwitchOnClear;
      updateObsWsStatusUi();
    }

    function bindObsWsSettingsInputs() {
      const bindings = [
        ['obs-ws-enable', (el) => ({ enabled: el.checked })],
        ['obs-ws-host', (el) => ({ host: el.value.trim() })],
        ['obs-ws-port', (el) => ({ port: el.value.trim() })],
        ['obs-ws-password', (el) => ({ password: el.value })],
        ['obs-ws-live-scene', (el) => ({ liveSceneName: el.value })],
        ['obs-ws-clear-scene', (el) => ({ clearSceneName: el.value })],
        ['obs-ws-auto-live', (el) => ({ autoSwitchOnProject: el.checked })],
        ['obs-ws-auto-clear', (el) => ({ autoSwitchOnClear: el.checked })]
      ];
      bindings.forEach(([id, buildPatch]) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.bound) return;
        el.dataset.bound = '1';
        const eventName = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(eventName, () => {
          updateObsWsSettings(buildPatch(el));
          // Only the enable toggle reconnects automatically. Host/port/password
          // deliberately do NOT auto-reconnect on every keystroke (that would
          // tear down and recreate the connection on each character typed) —
          // the user applies an edited host/port/password with the existing
          // "Connect" button, same convention as the vMix settings above.
          if (id === 'obs-ws-enable') {
            if (el.checked) obsWsConnect();
            else disconnectObsWs({ markIdle: true, reason: 'OBS WebSocket disabled' });
          }
        });
      });
    }

    async function handleObsWsConnectAction() {
      if (!obsWsState.enabled) {
        showToast('Enable OBS WebSocket control first');
        return;
      }
      obsWsReconnect();
    }

    async function handleObsWsRefreshScenesAction() {
      if (!obsWsSocket || obsWsSocket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to OBS');
        return;
      }
      await obsWsRefreshSceneList();
      showToast('OBS scene list refreshed');
    }

    async function handleObsWsSwitchSceneAction() {
      const select = document.getElementById('obs-ws-manual-scene');
      const name = select ? select.value : '';
      if (!name) {
        showToast('Choose a scene first');
        return;
      }
      const ok = await obsWsSetScene(name);
      if (ok) showToast(`Switched OBS to "${name}"`);
    }
