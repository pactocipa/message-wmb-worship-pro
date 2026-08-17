    function getActiveBgOpacityValue() {
      return (activeRatio === 'full') ? bgOpacityFull : bgOpacityLT;
    }

    function syncBgOpacitySlider() {
      const fullSlider = document.getElementById('bg-opacity-full');
      const ltSlider = document.getElementById('bg-opacity-lt');
      if (fullSlider) {
        fullSlider.value = bgOpacityFull;
        updateSliderValue(fullSlider, '%');
        updateSliderFill(fullSlider);
      }
      if (ltSlider) {
        ltSlider.value = bgOpacityLT;
        updateSliderValue(ltSlider, '%');
        updateSliderFill(ltSlider);
      }
    }

    function applyLtBgDefaultForTab(tab) {
      if (activeRatio !== '16-9') return false;
      const bgToggle = document.getElementById('bg-toggle');
      if (!bgToggle) return false;
      let desired = !!bgToggle.checked;
      if (tab === 'bible') {
        desired = true;
      } else if (tab === 'songs') {
        desired = !!songBgUserOn;
      }
      if (bgToggle.checked === desired) return false;
      bgToggle.checked = desired;
      return true;
    }

    function getEffectiveContentTab() {
      if (isLive && livePointer && livePointer.kind) {
        return livePointer.kind === 'bible' ? 'bible' : 'songs';
      }
      if (currentItem && getIsBibleItem(currentItem)) return 'bible';
      if (sidebarTab === 'schedule') return 'schedule';
      return sidebarTab === 'bible' ? 'bible' : 'songs';
    }

    function updateBgModeUi() {
      const label = document.getElementById('bg-mode-label');
      const quick = document.getElementById('bg-color-quick');
      const split = document.getElementById('bg-color-split');
      if (label) {
        label.textContent = (bgMode === 'gradient') ? 'GB' : 'BG';
        label.classList.toggle('active', bgMode === 'gradient');
        label.title = (bgMode === 'gradient') ? 'Gradient Background' : 'Background';
      }
      if (quick) quick.style.display = (bgMode === 'gradient') ? 'none' : 'inline-block';
      if (split) split.style.display = (bgMode === 'gradient') ? 'inline-flex' : 'none';
      updateBgModePicker();
    }

    function setBgMode(mode, opts = {}) {
      bgMode = (mode === 'gradient') ? 'gradient' : 'solid';
      updateBgModeUi();
      if (!opts.silent) onAnyControlChange();
    }

    function toggleBgMode(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (bgMode !== 'gradient') {
        setBgMode('gradient');
      } else {
        setBgMode('solid');
      }
    }

    function setBgModeFromPicker(mode) {
      const bgToggle = document.getElementById('bg-toggle');
      if (bgToggle && !bgToggle.checked) {
        bgToggle.checked = true;
        if (sidebarTab === 'songs' && activeRatio === '16-9') songBgUserOn = true;
      }
      setBgMode(mode);
      updateBgModePicker();
    }

    function toggleBgOnOff(on) {
      const bgToggle = document.getElementById('bg-toggle');
      if (!bgToggle) return;
      if (on === undefined) on = !bgToggle.checked;
      bgToggle.checked = on;
      if (sidebarTab === 'songs' && activeRatio === '16-9') songBgUserOn = on;
      updateBgModePicker();
      onAnyControlChange();
    }

    function updateBgModePicker() {
      const bgToggle = document.getElementById('bg-toggle');
      const isOn = bgToggle && bgToggle.checked;
      const solidBtn = document.getElementById('bg-mode-solid');
      const gradBtn = document.getElementById('bg-mode-gradient');
      const offBtn = document.getElementById('bg-off-btn');
      if (solidBtn) solidBtn.classList.toggle('active', isOn && bgMode === 'solid');
      if (gradBtn) gradBtn.classList.toggle('active', isOn && bgMode === 'gradient');
      if (offBtn) {
        offBtn.classList.toggle('active', !isOn);
        offBtn.textContent = isOn ? 'OFF' : 'OFF ✓';
      }
    }


    function handleBgTypeChange() {
      const t = document.getElementById('bg-type').value;
      document.getElementById('bg-image-settings').style.display = (t === 'image') ? 'block' : 'none';
      document.getElementById('bg-video-settings').style.display = (t === 'video') ? 'block' : 'none';
      document.getElementById('bg-media-effects').style.display = (t === 'image' || t === 'video') ? 'block' : 'none';
      if (t === 'image') handleBgImageSourceChange();
      if (t === 'video') handleBgVideoSourceChange();
      updateBgTypePicker();
    }

    function setBgTypePicker(type) {
      const sel = document.getElementById('bg-type');
      if (sel) {
        sel.value = type;
        handleBgTypeChange();
        onAnyControlChange();
      }
    }

    function updateBgTypePicker() {
      const val = document.getElementById('bg-type').value;
      document.getElementById('bgtype-color').classList.toggle('active', val === 'color');
      document.getElementById('bgtype-image').classList.toggle('active', val === 'image');
      document.getElementById('bgtype-video').classList.toggle('active', val === 'video');
    }
    
    function handleBgImageSourceChange() {
      const src = document.getElementById('bg-image-source').value;
      document.getElementById('bg-url-row').style.display = (src === 'url') ? 'block' : 'none';
      document.getElementById('bg-upload-row').style.display = (src === 'upload') ? 'block' : 'none';
    }

    function handleBgVideoSourceChange() {
      const src = document.getElementById('bg-video-source').value;
      document.getElementById('bg-video-url-row').style.display = (src === 'url') ? 'block' : 'none';
      document.getElementById('bg-video-upload-row').style.display = (src === 'upload') ? 'block' : 'none';
    }
    
    // Native OS file dialog + a real file:// URL back for the picked file,
    // entirely over IPC (see bsp:pickMediaFile in main.js) — no File object
    // ever crosses the context bridge. Chromium streams/decodes straight from
    // disk via that URL, so memory use stays tiny no matter how large the
    // file is, and the projection window sync payload stays a short string
    // instead of a multi-hundred-MB base64 blob (which is what was
    // freezing/crashing the app on "heavy" video backgrounds). The
    // FileReader/base64 path further below only runs as a fallback when
    // window.BSPDesktop isn't present at all (e.g. a plain-browser build),
    // and is capped so it can't reproduce that crash.
    function hasDesktopMediaPicker() {
      return !!(window.BSPDesktop && typeof window.BSPDesktop.pickMediaFile === 'function');
    }

    async function pickBgImage() {
      if (!hasDesktopMediaPicker()) {
        const input = document.getElementById('bg-upload');
        if (input) input.click();
        return;
      }
      let result;
      try {
        result = await window.BSPDesktop.pickMediaFile({ kind: 'image' });
      } catch (e) {
        console.error('pickMediaFile(image) failed', e);
        showToast('Failed to open the file picker.');
        return;
      }
      if (!result || !result.url) return; // user cancelled
      bgUploadDataUrl = result.url;
      document.getElementById('bg-upload-hint').innerText = "Image selected ✓";
      saveToStorageDebounced();
      onAnyControlChange();
      persistBackgroundState();
      showToast('Background uploaded');
    }

    async function pickBgVideo() {
      if (!hasDesktopMediaPicker()) {
        const input = document.getElementById('bg-video-upload');
        if (input) input.click();
        return;
      }
      let result;
      try {
        result = await window.BSPDesktop.pickMediaFile({ kind: 'video' });
      } catch (e) {
        console.error('pickMediaFile(video) failed', e);
        showToast('Failed to open the file picker.');
        return;
      }
      if (!result || !result.url) return; // user cancelled
      bgVideoUploadDataUrl = result.url;
      document.getElementById('bg-video-upload-hint').innerText = "Video selected ✓";
      saveToStorageDebounced();
      onAnyControlChange();
      persistBackgroundState();
      showToast('Background video uploaded');
    }

    // Fallback for environments without window.BSPDesktop (e.g. a
    // plain-browser build): read the file into memory as a base64 data URL,
    // capped well below the size that used to freeze/crash the app.
    function handleBgUpload(input) {
      const file = input.files && input.files[0];
      if (!file) return;
      const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB
      if (file.size > MAX_INLINE_IMAGE_BYTES) {
        showToast('Image too large to load this way — please use a smaller file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        bgUploadDataUrl = reader.result;
        document.getElementById('bg-upload-hint').innerText = "Image selected ✓";
        saveToStorageDebounced();
        onAnyControlChange();
        persistBackgroundState();
        showToast('Background uploaded');
      };
      reader.onerror = () => {
        console.error('Reading background image failed', reader.error);
        showToast('Failed to read the image file.');
      };
      reader.readAsDataURL(file);
    }

    function handleBgVideoUpload(input) {
      const file = input.files && input.files[0];
      if (!file) return;
      const MAX_INLINE_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
      if (file.size > MAX_INLINE_VIDEO_BYTES) {
        showToast('Video too large to load this way — please use a smaller file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        bgVideoUploadDataUrl = reader.result;
        document.getElementById('bg-video-upload-hint').innerText = "Video selected ✓";
        saveToStorageDebounced();
        onAnyControlChange();
        persistBackgroundState();
        showToast('Background video uploaded');
      };
      reader.onerror = () => {
        console.error('Reading background video failed', reader.error);
        showToast('Failed to read the video file.');
      };
      reader.readAsDataURL(file);
    }

    function clearBgUrl(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = '';
      onAnyControlChange();
    }
    
    function calculateLtHeightPctFromLines(lineCount, referenceCount = 1) {
      const lines = Math.max(1, lineCount);
      const baseRefHeight = Math.max(1, referenceCount) * 46;
      const basePx = Math.max(0, baseRefHeight + 168 - 40);
      const perLinePx = 44;
      const totalPx = basePx + (perLinePx * lines);
      const pct = (totalPx / 1080) * 100;
      return Math.max(28, Math.min(100, pct));
    }

    function countLtWords(text = '') {
      const normalized = String(text || '')
        .replace(/<\/?[^>]+>/g, ' ')
        .replace(/[\n\r]+/g, ' ')
        .replace(/[\uFEFF\u00A0]+/g, ' ')
        .trim();
      if (!normalized) return 0;
      return normalized.split(/\s+/).filter(Boolean).length;
    }

    function getDualModeLineTarget(primaryRaw = '', secondaryRaw = '') {
      const totalWords = countLtWords(primaryRaw) + countLtWords(secondaryRaw);
      const wordsPerLine = 12;
      const linesNeeded = totalWords ? Math.ceil(totalWords / wordsPerLine) : 3;
      return Math.min(3, Math.max(3, linesNeeded));
    }

    function getScheduleLineHint(entry) {
      if (!entry) return null;
      const clamp = (value) => Math.max(1, Math.min(getMaxLinesForCurrentTab('bible'), value));
      if (Number.isFinite(entry.linesPerPage)) {
        return clamp(Number(entry.linesPerPage));
      }
      if (entry.pageSnapshot) {
        const snapshot = entry.pageSnapshot;
        const verseCount = Number(snapshot.verseCount);
        if (Number.isFinite(verseCount) && verseCount >= 1) {
          return clamp(verseCount);
        }
        const rawText = String(snapshot.raw || snapshot.text || '');
        const lines = rawText
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean).length;
        if (lines) return clamp(lines);
      }
      return null;
    }

    function getLtBgHeightPct(verseCount) {
      if (activeRatio === 'custom') return 220 / 1080 * 100;
      if (autoAdjustLtHeight && getEffectiveContentTab() === 'bible') {
        const lineHeight = Number(document.getElementById('line-height-lt').value || 1.1);
        const fontSize = getEffectiveLtFont();
        const baseHeight = 15;
        const heightPerVerse = 3;
        const calculatedHeight = baseHeight + (verseCount * heightPerVerse);
        return Math.max(15, Math.min(45, calculatedHeight));
      }
      return calculateLtHeightPctFromLines(linesPerPage);
    }
    
