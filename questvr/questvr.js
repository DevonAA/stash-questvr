// questvr - immersive WebXR player for Stash scenes on Meta Quest.
// Bootstrap: detects scene pages, reads tags/markers/settings (read-only GraphQL),
// adds "Enter VR" buttons and lazily loads the player module from the plugin assets.
(function () {
  'use strict';
  const VERSION = '1.2.2';
  const ASSETS = '/plugin/questvr/assets/';
  const DEFAULT_FORMAT = { projection: '180', stereo: 'sbs' };
  const BASE_SETTINGS = { distance: 50, depth: 0, zoom: 1, tilt: 0, roll: 0, yaw: 0, swap: false, follow: true };

  // tag names -> projection/stereo (case-insensitive); 180 list taken from the autovr plugin
  const TAGS_180 = ['180°', '180', '180 fov', '180 vr', '180vr', '180° fov', '180° vr', 'fov: 180', 'fov: 180°',
    'fov:180', 'fov:180°', 'vr 180', 'vr180', '190°', '190', 'rf52', '200', '200°', '220', '220°'];
  const TAGS_360 = ['360°', '360', '360 vr', 'vr 360', 'vr360'];
  const TAGS_TB = ['tb', 'top-bottom', 'top bottom', 'topbottom', 'ou', 'over-under', 'over under', '3dv'];
  const TAGS_MONO = ['mono', '2d vr', 'vr mono'];

  let xrSupported = null;     // cached immersive-vr support
  let modulePromise = null;
  let ctx = null;             // state for the current scene page

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const RENDER_SCALE_KEY = 'questvr:renderScale';   // chosen in the VR menu, per device

  async function gql(query, variables) {
    const res = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function checkXR() {
    if (xrSupported !== null) return xrSupported;
    try {
      xrSupported = !!(window.isSecureContext && navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'));
    } catch { xrSupported = false; }
    return xrSupported;
  }

  function notice(text) {
    const id = 'questvr-notice';
    document.getElementById(id)?.remove();
    const box = document.createElement('div');
    box.id = id;
    box.innerHTML = '<button title="close">×</button><b>questvr</b><br><span></span>';
    box.querySelector('span').textContent = text;
    box.querySelector('button').onclick = () => box.remove();
    document.body.appendChild(box);
  }

  function waitFor(fn, timeoutMs) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function poll() {
        const v = fn();
        if (v || Date.now() - t0 > timeoutMs) return resolve(v || null);
        setTimeout(poll, 200);
      })();
    });
  }

  function parseFormat(str) {
    const m = /^(180|360)_(SBS|LR|TB|MONO)$/i.exec(String(str || '').trim());
    if (!m) return { ...DEFAULT_FORMAT };
    const s = m[2].toLowerCase();
    return { projection: m[1], stereo: s === 'lr' ? 'sbs' : s };
  }

  function formatFromTags(tags, fallback) {
    const names = new Set(tags.map(t => t.name.trim().toLowerCase()));
    const has = list => list.some(n => names.has(n));
    const f = { ...fallback };
    if (has(TAGS_360)) f.projection = '360';
    else if (has(TAGS_180)) f.projection = '180';
    if (has(TAGS_TB)) f.stereo = 'tb';
    else if (has(TAGS_MONO)) f.stereo = 'mono';
    return f;
  }

  function cleanupScene() {
    if (!ctx) return;
    ctx.dead = true;
    ctx.vr?.end();
    ctx.elements.forEach(el => el.remove());
    ctx.cleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } });
    ctx = null;
  }

  /* ---------- desktop: drive Stash's own videojs-vr (one eye, drag to look) ---------- */
  // our format -> videojs-vr projection (no 180 top-bottom mode exists there)
  const DESKTOP_PROJECTION = {
    '180/sbs': '180_LR', '180/mono': '180', '360/sbs': '360_LR', '360/tb': '360_TB', '360/mono': '360',
  };
  // Stash's VR menu labels, so its menu shows the right selection
  const STASH_MENU_LABEL = { '180_LR': '180 LR', '360_TB': '360 TB', '360': '360 Mono', NONE: 'Off' };

  function setupDesktop(my, player, isVR, initial) {
    const menu = typeof player.vrMenu === 'function' ? player.vrMenu() : null;
    const vr = menu && menu.vr;
    if (!vr || typeof vr.setProjection !== 'function' || typeof vr.init !== 'function') {
      notice('Desktop VR inactive: Stash\'s VR player looks different than expected (Stash update?). questvr ' + VERSION + ' was tested with Stash v0.32.');
      return;
    }
    let active = false;
    let btn = null;

    function syncStashMenu(projection) {
      const label = STASH_MENU_LABEL[projection];
      if (!menu.menu || !label) return;
      menu.menu.selectedType = label;
      (menu.menu.items || []).forEach(i => i.selected?.(i.type === label));
    }
    function setActive(on) {
      const s = initial();
      const projection = on ? DESKTOP_PROJECTION[s.projection + '/' + s.stereo] : 'NONE';
      if (!projection) { notice('180° top-bottom is not supported by Stash\'s desktop VR view (it works on the Quest).'); return; }
      const apply = () => {
        if (my.dead) return;
        if (on) menu.setShowButton?.(true);   // show Stash's VR menu for forced scenes too
        vr.setProjection(projection);
        vr.init();
        syncStashMenu(projection);
        active = on;
        btn?.classList.toggle('questvr-on', on);
      };
      if (player.readyState() >= 1) apply(); else player.one('loadedmetadata', apply);
    }

    // scroll wheel zooms (camera field of view) while the VR view is active
    const onWheel = e => {
      if (!active || !vr.camera) return;
      e.preventDefault();
      e.stopPropagation();
      vr.camera.fov = Math.min(120, Math.max(30, vr.camera.fov + (e.deltaY > 0 ? 5 : -5)));
      vr.camera.updateProjectionMatrix();
    };
    // keep our button in sync when the projection is changed through Stash's own VR menu
    const onStashMenu = (e, type) => {
      active = !!type && type !== 'Off';
      btn?.classList.toggle('questvr-on', active);
    };
    if (typeof menu.menu?.on === 'function') {
      menu.menu.on('typeselected', onStashMenu);
      my.cleanups.push(() => menu.menu.off('typeselected', onStashMenu));
    }

    const root = player.el();
    root.addEventListener('wheel', onWheel, { passive: false });
    my.cleanups.push(() => root.removeEventListener('wheel', onWheel));

    const bar = root.querySelector('.vjs-control-bar');
    if (bar) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vjs-control vjs-button questvr-bar-btn';
      btn.title = 'Toggle VR view (questvr)';
      btn.textContent = 'VR';
      btn.addEventListener('click', e => { e.stopPropagation(); setActive(!active); });
      bar.insertBefore(btn, bar.querySelector('.vjs-fullscreen-control') || null);
      my.elements.push(btn);
    }
    if (isVR) setActive(true);
  }

  async function setupScene(sceneId) {
    const my = { sceneId, elements: [], cleanups: [], vr: null, dead: false, entering: false };
    ctx = my;
    const immersive = await checkXR();          // Quest/headset: own WebXR player; else desktop mode
    if (my.dead) return;
    if (immersive) modulePromise ??= import(ASSETS + 'player.js');

    const el = await waitFor(() => document.querySelector('.video-js'), 20000);
    if (my.dead || !el) return;
    const player = await waitFor(() => el.player, 5000);
    if (my.dead) return;
    if (!player || typeof player.el !== 'function' || !player.el().querySelector('video')) {
      notice('Inactive: the Stash video player looks different than expected (Stash update?). questvr ' + VERSION + ' was tested with Stash v0.32.');
      return;
    }

    let data;
    try {
      data = await gql(`query($id: ID!) {
        findScene(id: $id) { id title files { basename } tags { name } scene_markers { seconds title } }
        configuration { plugins(include: ["questvr"]) ui }
      }`, { id: sceneId });
    } catch (e) {
      notice('Could not read scene info: ' + e.message);
      return;
    }
    if (my.dead || !data.findScene) return;
    const scene = data.findScene;
    const cfg = data.configuration.plugins?.questvr || {};
    const vrTag = (data.configuration.ui?.vrTag || 'VR').toLowerCase();
    const isVR = scene.tags.some(t => t.name.toLowerCase() === vrTag);
    if (!isVR && cfg.hideForceButton) return;

    // Stash stores NUMBER plugin settings as integers, so zoom and render scale are in percent
    const pct = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(max, Math.max(min, Number(v))) / 100 : null);
    const zoomDefault = pct(cfg.defaultZoomPercent, 60, 160);
    // render quality: the choice made in the VR menu (this device) wins over the plugin setting
    const renderScale = () => Number(store.get(RENDER_SCALE_KEY)) || pct(cfg.renderScalePercent, 50, 150) || 1;
    const defaults = {
      ...BASE_SETTINGS,
      ...(zoomDefault ? { zoom: zoomDefault } : {}),
      ...(Number(cfg.defaultDistance) > 0 ? { distance: Number(cfg.defaultDistance) } : {}),
    };
    const storageKey = 'questvr:s:' + sceneId;
    // baseline = defaults + format from tags/setting; saved per-scene changes are stored as a diff on top
    const baseline = { ...defaults, ...formatFromTags(scene.tags, parseFormat(cfg.defaultProjection)) };
    const initial = () => ({ ...baseline, ...(store.get(storageKey) || {}) });

    if (!immersive) { setupDesktop(my, player, isVR, initial); return; }

    async function enterVR() {
      if (my.vr || my.entering || my.dead) return;
      my.entering = true;
      let session;
      const wasPaused = player.paused();
      try {
        player.play()?.catch?.(() => {});   // must start inside the click gesture
        session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking'] });
      } catch (e) {
        my.entering = false;
        if (wasPaused) player.pause();      // VR was cancelled: don't leave the video playing
        notice('Could not start VR: ' + e.message);
        return;
      }
      try {
        const mod = await modulePromise;
        my.vr = await mod.startVR({
          session, player, sceneId,
          title: scene.title || scene.files?.[0]?.basename || '',
          markers: scene.scene_markers || [],
          settings: initial(),
          defaults,
          baseline,
          storageKey,
          renderScale: renderScale(),
          // quality changed in the VR menu (the player switches it in the running session)
          onRenderScaleChange: scale => store.set(RENDER_SCALE_KEY, scale),
          onEnd: () => { my.vr = null; },
        });
      } catch (e) {
        session.end().catch(() => {});
        notice('VR player failed: ' + e.message);
      } finally {
        my.entering = false;
      }
    }

    // control-bar button (all scenes unless hidden by setting)
    const bar = player.el().querySelector('.vjs-control-bar');
    if (bar) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vjs-control vjs-button questvr-bar-btn';
      btn.title = 'Watch in VR (questvr)';
      btn.textContent = 'VR';
      btn.addEventListener('click', e => { e.stopPropagation(); enterVR(); });
      const fs = bar.querySelector('.vjs-fullscreen-control');
      bar.insertBefore(btn, fs || null);
      my.elements.push(btn);
    }
    // big overlay button for VR-tagged scenes
    if (isVR) {
      const big = document.createElement('button');
      big.type = 'button';
      big.className = 'questvr-enter';
      big.textContent = 'Enter VR';
      big.addEventListener('click', e => { e.stopPropagation(); enterVR(); });
      player.el().appendChild(big);
      my.elements.push(big);
    }
  }

  // Stash is a single-page app: watch the route
  let lastPath = '';
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    cleanupScene();
    const m = /^\/scenes\/(\d+)/.exec(location.pathname);
    if (m) setupScene(m[1]);
  }, 400);
})();
