    // Preacher/sermon title-card overlays — a broadcast-style banner (church
    // logo + series name + theme + speaker photo/name) shown OVER whatever
    // else is currently projected, and dismissed independently of it. See
    // panel-app-core.js for the overlayCards/overlayChurchLogoDataUrl/
    // overlayLiveActive/activeOverlayCardId globals, and BSP_display.html's
    // showOverlayBanner()/hideOverlayBanner() for how the HTML built here
    // actually gets animated in on the projection side.

    const OVERLAY_TEMPLATES = [
      { id: 'gold', label: 'Or / Rouge', swatch: 'linear-gradient(100deg,#2a0a0a,#6e1414 32%,#b9862b 68%,#6e1414)' },
      { id: 'white', label: 'Blanc / Rose', swatch: 'linear-gradient(100deg,#ffffff,#ffe3ec 55%,#ffc9dc)' },
      { id: 'blackred', label: 'Noir / Rouge', swatch: 'linear-gradient(100deg,#0a0a0a,#2a0a0a 60%,#b30f1f)' },
      { id: 'custom', label: 'Personnalisé', swatch: 'repeating-linear-gradient(45deg,#333,#333 6px,#444 6px,#444 12px)' }
    ];

    const OVERLAY_ANIMATIONS = [
      { id: 'slide-up', label: 'Glisser (bas → haut)' },
      { id: 'slide-down', label: 'Glisser (haut → bas)' },
      { id: 'slide-left', label: 'Glisser (venant de gauche)' },
      { id: 'slide-right', label: 'Glisser (venant de droite)' },
      { id: 'fade', label: 'Fondu' },
      { id: 'zoom-in', label: 'Zoom avant' },
      { id: 'zoom-out', label: 'Zoom arrière' },
      { id: 'flip', label: 'Bascule' },
      { id: 'bounce', label: 'Rebond' },
      { id: 'wipe', label: 'Balayage' },
      { id: 'none', label: 'Aucune' }
    ];

    const OVERLAY_FONT_OPTIONS = [
      { label: '(Modèle par défaut)', value: '' },
      { label: 'Montserrat', value: "'Montserrat',sans-serif" },
      { label: 'Segoe UI', value: "'Segoe UI',sans-serif" },
      { label: 'Georgia (serif)', value: "Georgia,serif" },
      { label: 'Impact', value: "Impact,'Arial Narrow',sans-serif" },
      { label: 'Courier New', value: "'Courier New',monospace" }
    ];

    function defaultOverlayStyle() {
      return {
        banner: { bgMode: 'template', bgColor1: '#1c1c1c', bgColor2: '#3a3a3a', bgAngle: 100, anim: 'slide-up' },
        title: { fontFamily: '', fontSize: null, color: '', anim: 'slide-left' },
        churchName: { fontFamily: '', fontSize: null, color: '', anim: 'slide-right' },
        logo: { anim: 'slide-right' },
        photo: { anim: 'slide-right' },
        speakerName: { fontFamily: '', fontSize: null, color: '', anim: 'slide-right' }
      };
    }

    function defaultOverlayPosition() {
      return { vertical: 'bottom', offset: 8, width: 'full', align: 'center' };
    }

    // Merges a possibly-partial/older card.style with the defaults above, so
    // cards saved before a given control existed still render correctly.
    function getOverlayCardStyle(card) {
      const d = defaultOverlayStyle();
      const s = (card && card.style) || {};
      return {
        banner: { ...d.banner, ...(s.banner || {}) },
        title: { ...d.title, ...(s.title || {}) },
        churchName: { ...d.churchName, ...(s.churchName || {}) },
        logo: { ...d.logo, ...(s.logo || {}) },
        photo: { ...d.photo, ...(s.photo || {}) },
        speakerName: { ...d.speakerName, ...(s.speakerName || {}) }
      };
    }

    function getOverlayCardPosition(card) {
      return { ...defaultOverlayPosition(), ...((card && card.position) || {}) };
    }

    function escapeOverlayHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // Escapes text then converts explicit newlines (Enter in the textarea)
    // into <br> — the CSS line-clamp on .ov-title/.ov-church-name also wraps
    // long text automatically, but a manual break lets the user control
    // exactly where a two-line title splits for better balance.
    function multilineHtml(value) {
      return String(value == null ? '' : value)
        .split(/\r\n|\r|\n/)
        .map((line) => escapeOverlayHtml(line))
        .join('<br>');
    }

    // Same rock-solid approach as background image/video uploads: a native
    // OS file dialog over IPC (see bsp:pickMediaFile in main.js) instead of
    // <input type="file"> + FileReader, so a photo never has to be read into
    // memory as base64. Falls back to the hidden file input for environments
    // without window.BSPDesktop.
    async function pickOverlayImage(onPicked) {
      if (window.BSPDesktop && typeof window.BSPDesktop.pickMediaFile === 'function') {
        let result;
        try {
          result = await window.BSPDesktop.pickMediaFile({ kind: 'image' });
        } catch (e) {
          console.error('pickMediaFile(image) failed for overlay', e);
          showToast('Impossible d\'ouvrir le sélecteur de fichiers.');
          return;
        }
        if (!result || !result.url) return; // cancelled
        onPicked(result.url);
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => onPicked(reader.result);
        reader.onerror = () => showToast('Échec de la lecture de l\'image.');
        reader.readAsDataURL(file);
      };
      input.click();
    }

    function pickOverlaySpeakerPhoto() {
      pickOverlayImage((url) => {
        overlaySpeakerPhotoDraft = url;
        const hint = document.getElementById('overlay-speaker-photo-hint');
        if (hint) hint.textContent = 'Photo sélectionnée ✓';
        scheduleOverlayPreviewUpdate();
      });
    }

    function pickOverlayChurchLogo() {
      pickOverlayImage((url) => {
        overlayChurchLogoDataUrl = url;
        const hint = document.getElementById('overlay-logo-hint');
        if (hint) hint.textContent = 'Logo sélectionné ✓';
        scheduleOverlayPreviewUpdate();
        saveOverlayGlobalsDebounced();
      });
    }

    let overlayGlobalsSaveTimer = null;
    function saveOverlayGlobalsDebounced() {
      overlayChurchName = (document.getElementById('overlay-church-name')?.value || '').trim();
      clearTimeout(overlayGlobalsSaveTimer);
      overlayGlobalsSaveTimer = setTimeout(() => {
        saveToStorageDebounced();
      }, 400);
    }

    // Draft state for whichever card is currently being edited — only
    // committed into overlayCards on "Enregistrer", matching how the rest of
    // the editor form works (nothing else auto-saves per keystroke either).
    let overlaySpeakerPhotoDraft = null;
    let overlaySelectedTemplate = 'gold';
    let overlayDraftStyle = defaultOverlayStyle();
    let overlayDraftPosition = defaultOverlayPosition();
    let overlayActiveStyleTab = 'banner';

    function renderOverlayTemplatePicker() {
      const wrap = document.getElementById('overlay-template-picker');
      if (!wrap) return;
      wrap.innerHTML = '';
      OVERLAY_TEMPLATES.forEach((tpl) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = tpl.label;
        const active = tpl.id === overlaySelectedTemplate;
        btn.style.cssText = `width:64px;height:40px;border-radius:8px;border:2px solid ${active ? 'var(--accent)' : 'var(--border)'};background:${tpl.swatch};cursor:pointer;padding:0`;
        btn.onclick = () => { overlaySelectedTemplate = tpl.id; renderOverlayTemplatePicker(); scheduleOverlayPreviewUpdate(); };
        wrap.appendChild(btn);
      });
    }

    // ---- Position / alignment ----
    function renderOverlayPositionControls() {
      const wrap = document.getElementById('overlay-position-controls');
      if (!wrap) return;
      const p = overlayDraftPosition;
      wrap.innerHTML = `
        <select id="ov-pos-vertical" style="${OV_SELECT_CSS}">
          <option value="bottom"${p.vertical === 'bottom' ? ' selected' : ''}>Bas de l'écran</option>
          <option value="top"${p.vertical === 'top' ? ' selected' : ''}>Haut de l'écran</option>
        </select>
        <select id="ov-pos-width" style="${OV_SELECT_CSS}">
          <option value="full"${p.width === 'full' ? ' selected' : ''}>Pleine largeur</option>
          <option value="auto"${p.width === 'auto' ? ' selected' : ''}>Largeur au contenu</option>
        </select>
        <select id="ov-pos-align" style="${OV_SELECT_CSS}"${p.width === 'full' ? ' disabled' : ''}>
          <option value="left"${p.align === 'left' ? ' selected' : ''}>Aligné à gauche</option>
          <option value="center"${p.align === 'center' ? ' selected' : ''}>Centré</option>
          <option value="right"${p.align === 'right' ? ' selected' : ''}>Aligné à droite</option>
        </select>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text-secondary)">Décalage bord</span>
          <input type="number" id="ov-pos-offset" min="0" max="45" value="${p.offset}" style="width:56px;box-sizing:border-box;padding:6px 8px;background:#0a0d14;color:var(--text);border:1px solid var(--border);border-radius:6px">
          <span style="font-size:11px;color:var(--text-secondary)">%</span>
        </div>`;
      document.getElementById('ov-pos-vertical').onchange = (e) => { overlayDraftPosition.vertical = e.target.value; scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-pos-width').onchange = (e) => { overlayDraftPosition.width = e.target.value; renderOverlayPositionControls(); scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-pos-align').onchange = (e) => { overlayDraftPosition.align = e.target.value; scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-pos-offset').oninput = (e) => { overlayDraftPosition.offset = Math.max(0, Math.min(45, Number(e.target.value) || 0)); scheduleOverlayPreviewUpdate(); };
    }

    const OV_SELECT_CSS = 'box-sizing:border-box;padding:8px 10px;background:#0a0d14;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:12px';
    const OV_STYLE_TABS = [
      { id: 'banner', label: 'Bandeau' },
      { id: 'title', label: 'Titre' },
      { id: 'churchName', label: 'Église / Logo' },
      { id: 'photo', label: 'Photo' },
      { id: 'speakerName', label: 'Prédicateur' }
    ];

    function animSelectHtml(id, value) {
      return `<select id="${id}" style="${OV_SELECT_CSS}">` +
        OVERLAY_ANIMATIONS.map((a) => `<option value="${a.id}"${a.id === value ? ' selected' : ''}>${escapeOverlayHtml(a.label)}</option>`).join('') +
        `</select>`;
    }
    function fontSelectHtml(id, value) {
      return `<select id="${id}" style="${OV_SELECT_CSS}">` +
        OVERLAY_FONT_OPTIONS.map((f) => `<option value="${escapeOverlayHtml(f.value)}"${f.value === value ? ' selected' : ''}>${escapeOverlayHtml(f.label)}</option>`).join('') +
        `</select>`;
    }

    function renderOverlayStyleTabs() {
      const tabsWrap = document.getElementById('overlay-style-tabs');
      if (!tabsWrap) return;
      tabsWrap.innerHTML = '';
      OV_STYLE_TABS.forEach((tab) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = tab.label;
        const active = tab.id === overlayActiveStyleTab;
        btn.style.cssText = `padding:7px 12px;border-radius:7px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};background:${active ? 'var(--accent)' : 'var(--bg-dark)'};color:${active ? '#fff' : 'var(--text)'};font-size:12px;cursor:pointer`;
        btn.onclick = () => { overlayActiveStyleTab = tab.id; renderOverlayStyleTabs(); renderOverlayStylePanel(); };
        tabsWrap.appendChild(btn);
      });
    }

    function renderOverlayStylePanel() {
      const panel = document.getElementById('overlay-style-panel');
      if (!panel) return;
      const s = overlayDraftStyle;
      const tab = overlayActiveStyleTab;

      if (tab === 'banner') {
        const b = s.banner;
        panel.innerHTML = `
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <select id="ov-bg-mode" style="${OV_SELECT_CSS}">
              <option value="template"${b.bgMode === 'template' ? ' selected' : ''}>Couleurs du modèle</option>
              <option value="solid"${b.bgMode === 'solid' ? ' selected' : ''}>Couleur unie</option>
              <option value="gradient"${b.bgMode === 'gradient' ? ' selected' : ''}>Dégradé</option>
            </select>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary)">Couleur 1 <input type="color" id="ov-bg-color1" value="${b.bgColor1}"></label>
            <label id="ov-bg-color2-wrap" style="display:${b.bgMode === 'gradient' ? 'flex' : 'none'};align-items:center;gap:6px;font-size:11px;color:var(--text-secondary)">Couleur 2 <input type="color" id="ov-bg-color2" value="${b.bgColor2}"></label>
            <label id="ov-bg-angle-wrap" style="display:${b.bgMode === 'gradient' ? 'flex' : 'none'};align-items:center;gap:6px;font-size:11px;color:var(--text-secondary)">Angle <input type="number" id="ov-bg-angle" min="0" max="360" value="${b.bgAngle}" style="width:56px;box-sizing:border-box;padding:6px 8px;background:#0a0d14;color:var(--text);border:1px solid var(--border);border-radius:6px"></label>
          </div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--text-secondary)">Animation du bandeau entier</span>
            ${animSelectHtml('ov-banner-anim', b.anim)}
          </div>`;
        document.getElementById('ov-bg-mode').onchange = (e) => {
          b.bgMode = e.target.value;
          renderOverlayStylePanel();
          scheduleOverlayPreviewUpdate();
        };
        document.getElementById('ov-bg-color1').oninput = (e) => { b.bgColor1 = e.target.value; scheduleOverlayPreviewUpdate(); };
        const c2 = document.getElementById('ov-bg-color2');
        if (c2) c2.oninput = (e) => { b.bgColor2 = e.target.value; scheduleOverlayPreviewUpdate(); };
        const ang = document.getElementById('ov-bg-angle');
        if (ang) ang.oninput = (e) => { b.bgAngle = Number(e.target.value) || 0; scheduleOverlayPreviewUpdate(); };
        document.getElementById('ov-banner-anim').onchange = (e) => { b.anim = e.target.value; scheduleOverlayPreviewUpdate(); };
        return;
      }

      if (tab === 'photo') {
        panel.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--text-secondary)">Animation de la photo du prédicateur</span>
            ${animSelectHtml('ov-photo-anim', s.photo.anim)}
          </div>`;
        document.getElementById('ov-photo-anim').onchange = (e) => { s.photo.anim = e.target.value; scheduleOverlayPreviewUpdate(); };
        return;
      }

      if (tab === 'churchName') {
        const cn = s.churchName;
        panel.innerHTML = `
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            ${fontSelectHtml('ov-cn-font', cn.fontFamily)}
            <input type="number" id="ov-cn-size" placeholder="Taille (pt)" min="6" max="60" value="${cn.fontSize || ''}" style="width:110px;box-sizing:border-box;padding:8px 10px;background:#0a0d14;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:12px">
            <input type="color" id="ov-cn-color" value="${cn.color || '#ffffff'}">
            <button type="button" id="ov-cn-color-reset" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text-secondary);font-size:11px;cursor:pointer">Couleur du modèle</button>
          </div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:11px;color:var(--text-secondary)">Animation nom d'église</span>
            ${animSelectHtml('ov-cn-anim', cn.anim)}
          </div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:11px;color:var(--text-secondary)">Animation logo</span>
            ${animSelectHtml('ov-logo-anim', s.logo.anim)}
          </div>`;
        document.getElementById('ov-cn-font').onchange = (e) => { cn.fontFamily = e.target.value; scheduleOverlayPreviewUpdate(); };
        document.getElementById('ov-cn-size').oninput = (e) => { cn.fontSize = e.target.value ? Number(e.target.value) : null; scheduleOverlayPreviewUpdate(); };
        document.getElementById('ov-cn-color').oninput = (e) => { cn.color = e.target.value; scheduleOverlayPreviewUpdate(); };
        document.getElementById('ov-cn-color-reset').onclick = () => { cn.color = ''; renderOverlayStylePanel(); scheduleOverlayPreviewUpdate(); };
        document.getElementById('ov-cn-anim').onchange = (e) => { cn.anim = e.target.value; scheduleOverlayPreviewUpdate(); };
        document.getElementById('ov-logo-anim').onchange = (e) => { s.logo.anim = e.target.value; scheduleOverlayPreviewUpdate(); };
        return;
      }

      // 'title' and 'speakerName' share the same font+size+color+animation shape.
      const key = tab === 'title' ? 'title' : 'speakerName';
      const el = s[key];
      panel.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${fontSelectHtml('ov-el-font', el.fontFamily)}
          <input type="number" id="ov-el-size" placeholder="Taille (pt)" min="6" max="120" value="${el.fontSize || ''}" style="width:110px;box-sizing:border-box;padding:8px 10px;background:#0a0d14;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:12px">
          <input type="color" id="ov-el-color" value="${el.color || '#ffffff'}">
          <button type="button" id="ov-el-color-reset" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text-secondary);font-size:11px;cursor:pointer">Couleur du modèle</button>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:var(--text-secondary)">Animation</span>
          ${animSelectHtml('ov-el-anim', el.anim)}
        </div>`;
      document.getElementById('ov-el-font').onchange = (e) => { el.fontFamily = e.target.value; scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-el-size').oninput = (e) => { el.fontSize = e.target.value ? Number(e.target.value) : null; scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-el-color').oninput = (e) => { el.color = e.target.value; scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-el-color-reset').onclick = () => { el.color = ''; renderOverlayStylePanel(); scheduleOverlayPreviewUpdate(); };
      document.getElementById('ov-el-anim').onchange = (e) => { el.anim = e.target.value; scheduleOverlayPreviewUpdate(); };
    }

    // ---- HTML builder (shared by the panel preview and the live payload) ----
    function textStyleAttr(elStyle) {
      const parts = [];
      if (elStyle.fontFamily) parts.push(`font-family:${elStyle.fontFamily}`);
      if (elStyle.fontSize) parts.push(`font-size:${elStyle.fontSize}pt`);
      if (elStyle.color) parts.push(`color:${elStyle.color}`);
      return parts.length ? ` style="${parts.join(';')}"` : '';
    }

    function bannerBgStyle(style) {
      const b = style.banner;
      if (b.bgMode === 'solid') return ` style="background:${b.bgColor1} !important"`;
      if (b.bgMode === 'gradient') return ` style="background:linear-gradient(${b.bgAngle}deg, ${b.bgColor1}, ${b.bgColor2}) !important"`;
      return '';
    }

    function slotPositionStyle(position) {
      return position.vertical === 'top' ? `top:${position.offset}%` : `bottom:${position.offset}%`;
    }

    function slotJustifyClass(position) {
      if (position.width !== 'auto') return '';
      const map = { left: 'flex-start', center: 'center', right: 'flex-end' };
      return ' ov-slot-justify-' + (map[position.align] || 'center');
    }

    // The outer .ov-banner-slot handles top/bottom + left/center/right via
    // plain box positioning and flexbox justify-content — never `transform`
    // — so it can never collide with the entrance/exit animation's own
    // transform on .ov-banner (that collision, on the template-3 ribbon
    // specifically, is what made its shape render wrong before).
    function buildOverlayBannerHtml(card, opts = {}) {
      const animate = opts.animate !== false;
      const phase = animate ? 'in' : null;
      const style = getOverlayCardStyle(card);
      const position = getOverlayCardPosition(card);
      const fx = (anim) => phase ? ` ov-fx-${anim}-${phase}` : '';

      const logoUrl = overlayChurchLogoDataUrl || '';
      const churchNameRaw = (overlayChurchName || '').trim();
      const churchNameHtml = churchNameRaw
        ? churchNameRaw.split('\n').map((line, i) => i === 0
            ? escapeOverlayHtml(line)
            : `<span class="ov-church-city">${escapeOverlayHtml(line)}</span>`).join('')
        : '';
      const photoUrl = card.speakerPhotoUrl || '';
      const widthClass = position.width === 'auto' ? ' ov-width-auto' : '';

      return `<div class="ov-banner-slot${slotJustifyClass(position)}" style="${slotPositionStyle(position)}">` +
        `<div class="ov-banner ov-tpl-${escapeOverlayHtml(card.template || 'gold')}${widthClass}${fx(style.banner.anim)}">` +
          `<div class="ov-bar-bg"${bannerBgStyle(style)}></div>` +
          `<div class="ov-logo-wrap${fx(style.logo.anim)}">` +
            `<img class="ov-logo" data-empty="${logoUrl ? '0' : '1'}" src="${escapeOverlayHtml(logoUrl)}" alt="">` +
            `<div class="ov-church-name${fx(style.churchName.anim)}"${textStyleAttr(style.churchName)}>${churchNameHtml}</div>` +
          `</div>` +
          `<div class="ov-text-wrap">` +
            `<div class="ov-series${fx(style.title.anim)}"><span>${escapeOverlayHtml(card.seriesName || '')}</span></div>` +
            `<div class="ov-title${fx(style.title.anim)}"${textStyleAttr(style.title)}>${multilineHtml(card.title || '')}</div>` +
          `</div>` +
          `<div class="ov-speaker-wrap">` +
            `<div class="ov-speaker-photo-wrap${fx(style.photo.anim)}">` +
              `<img class="ov-speaker-photo" data-empty="${photoUrl ? '0' : '1'}" src="${escapeOverlayHtml(photoUrl)}" alt="">` +
            `</div>` +
            `<div class="ov-speaker-text${fx(style.speakerName.anim)}"${textStyleAttr(style.speakerName)}>` +
              (card.speakerLabel ? `<span class="ov-speaker-label">${escapeOverlayHtml(card.speakerLabel)}</span>` : '') +
              `<span class="ov-speaker-name">${escapeOverlayHtml(card.speakerName || '')}</span>` +
            `</div>` +
          `</div>` +
        `</div>` +
      `</div>`;
    }

    function getOverlayFormData() {
      return {
        template: overlaySelectedTemplate,
        seriesName: document.getElementById('overlay-series-name')?.value || '',
        title: document.getElementById('overlay-title')?.value || '',
        speakerLabel: document.getElementById('overlay-speaker-label')?.value || '',
        speakerName: document.getElementById('overlay-speaker-name')?.value || '',
        speakerPhotoUrl: overlaySpeakerPhotoDraft || '',
        style: overlayDraftStyle,
        position: overlayDraftPosition
      };
    }

    let overlayPreviewTimer = null;
    function scheduleOverlayPreviewUpdate() {
      clearTimeout(overlayPreviewTimer);
      overlayPreviewTimer = setTimeout(updateOverlayPreview, 120);
    }

    function updateOverlayPreview() {
      const box = document.getElementById('overlay-preview');
      if (!box) return;
      const card = getOverlayFormData();
      box.innerHTML = buildOverlayBannerHtml(card, { animate: false });
    }

    function renderOverlayCardList() {
      const list = document.getElementById('overlay-card-list');
      if (!list) return;
      list.innerHTML = '';
      if (!overlayCards.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:14px;font-size:12px;color:var(--text-secondary);text-align:center';
        empty.textContent = 'Aucun bandeau enregistré';
        list.appendChild(empty);
        return;
      }
      overlayCards.forEach((card) => {
        const row = document.createElement('div');
        row.className = 'song-item' + (card.id === editingOverlayCardId ? ' active' : '');
        const label = document.createElement('span');
        label.textContent = card.title || card.seriesName || '(Sans titre)';
        row.appendChild(label);
        if (card.id === activeOverlayCardId && overlayLiveActive) {
          const badge = document.createElement('span');
          badge.className = 'live-indicator';
          badge.innerText = '[LIVE]';
          row.appendChild(badge);
        }
        row.onclick = () => loadOverlayCardIntoEditor(card.id);
        list.appendChild(row);
      });
    }

    function loadOverlayCardIntoEditor(cardId) {
      const card = overlayCards.find((c) => c.id === cardId);
      editingOverlayCardId = card ? card.id : null;
      overlaySelectedTemplate = card ? (card.template || 'gold') : 'gold';
      overlaySpeakerPhotoDraft = card ? (card.speakerPhotoUrl || null) : null;
      overlayDraftStyle = card ? getOverlayCardStyle(card) : defaultOverlayStyle();
      overlayDraftPosition = card ? getOverlayCardPosition(card) : defaultOverlayPosition();
      overlayActiveStyleTab = 'banner';
      document.getElementById('overlay-series-name').value = card ? (card.seriesName || '') : '';
      document.getElementById('overlay-title').value = card ? (card.title || '') : '';
      document.getElementById('overlay-speaker-label').value = card ? (card.speakerLabel || '') : '';
      document.getElementById('overlay-speaker-name').value = card ? (card.speakerName || '') : '';
      const photoHint = document.getElementById('overlay-speaker-photo-hint');
      if (photoHint) photoHint.textContent = overlaySpeakerPhotoDraft ? 'Photo sélectionnée ✓' : 'Aucune photo';
      renderOverlayTemplatePicker();
      renderOverlayPositionControls();
      renderOverlayStyleTabs();
      renderOverlayStylePanel();
      renderOverlayCardList();
      updateOverlayPreview();
      updateOverlayToggleButton();
    }

    function createNewOverlayCard() {
      loadOverlayCardIntoEditor(null);
    }

    function saveCurrentOverlayCard() {
      const data = getOverlayFormData();
      if (!data.title.trim() && !data.seriesName.trim()) {
        showToast('Ajoute au moins un thème ou un nom de série avant d\'enregistrer.');
        return;
      }
      const now = Date.now();
      if (editingOverlayCardId) {
        const existing = overlayCards.find((c) => c.id === editingOverlayCardId);
        if (existing) {
          Object.assign(existing, data, { updatedAt: now });
        }
      } else {
        const card = { id: createId('overlay', data.title || data.seriesName), ...data, createdAt: now, updatedAt: now };
        overlayCards.push(card);
        editingOverlayCardId = card.id;
      }
      saveToStorageDebounced();
      renderOverlayCardList();
      showToast('Bandeau enregistré.');
      // If this card is the one currently live, push the edit through immediately.
      if (overlayLiveActive && activeOverlayCardId === editingOverlayCardId) {
        pushOverlayLiveUpdate();
      }
    }

    function deleteCurrentOverlayCard() {
      if (!editingOverlayCardId) return;
      const wasLive = overlayLiveActive && activeOverlayCardId === editingOverlayCardId;
      overlayCards = overlayCards.filter((c) => c.id !== editingOverlayCardId);
      if (wasLive) hideOverlayLive();
      editingOverlayCardId = null;
      saveToStorageDebounced();
      loadOverlayCardIntoEditor(null);
    }

    function updateOverlayToggleButton() {
      const btn = document.getElementById('btn-overlay-toggle');
      if (!btn) return;
      const isThisCardLive = overlayLiveActive && activeOverlayCardId === editingOverlayCardId;
      btn.textContent = isThisCardLive ? 'Masquer' : 'Afficher en direct';
      btn.classList.toggle('btn-live', !isThisCardLive);
    }

    function pushOverlayLiveUpdate() {
      const card = overlayCards.find((c) => c.id === activeOverlayCardId);
      if (!card) return;
      const html = buildOverlayBannerHtml(card, { animate: true });
      broadcastMessage({ type: 'OVERLAY_SHOW', html });
    }

    function showOverlayLive() {
      if (!editingOverlayCardId) {
        showToast('Enregistre d\'abord ce bandeau.');
        return;
      }
      // Make sure unsaved edits in the form are actually the ones shown live.
      saveCurrentOverlayCard();
      activeOverlayCardId = editingOverlayCardId;
      overlayLiveActive = true;
      pushOverlayLiveUpdate();
      saveToStorageDebounced();
      updateOverlayToggleButton();
      renderOverlayCardList();
    }

    function hideOverlayLive() {
      overlayLiveActive = false;
      activeOverlayCardId = null;
      broadcastMessage({ type: 'OVERLAY_HIDE' });
      saveToStorageDebounced();
      updateOverlayToggleButton();
      renderOverlayCardList();
    }

    function toggleOverlayLive() {
      const isThisCardLive = overlayLiveActive && activeOverlayCardId === editingOverlayCardId;
      if (isThisCardLive) hideOverlayLive();
      else showOverlayLive();
    }

    function openOverlaysModal() {
      openModal('overlaysModal');
      document.getElementById('overlay-church-name').value = overlayChurchName || '';
      const logoHint = document.getElementById('overlay-logo-hint');
      if (logoHint) logoHint.textContent = overlayChurchLogoDataUrl ? 'Logo sélectionné ✓' : 'Aucun logo';
      if (editingOverlayCardId && overlayCards.some((c) => c.id === editingOverlayCardId)) {
        loadOverlayCardIntoEditor(editingOverlayCardId);
      } else if (overlayCards.length) {
        loadOverlayCardIntoEditor(overlayCards[0].id);
      } else {
        loadOverlayCardIntoEditor(null);
      }
      updateOverlayToggleButton();
    }
