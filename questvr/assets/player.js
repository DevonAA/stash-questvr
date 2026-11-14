// questvr immersive player (shared with ../vr_video via scripts/sync-vr-video.sh).
// Renders Stash's own <video> element in an immersive WebXR session.
import * as THREE from './three.module.js';

export const RANGES = {
  distance: { min: 1, max: 300 },     // log scale
  depth: { min: -3, max: 3 },
  zoom: { min: 0.6, max: 1.6 },
  tilt: { min: -45, max: 45 },        // up/down correction (deg)
  roll: { min: -30, max: 30 },        // horizon correction (deg)
  yaw: { min: -180, max: 180 },       // left/right turn (deg), wraps
};
const FORMATS = [
  ['180', 'sbs', '180 SBS'], ['180', 'tb', '180 TB'], ['180', 'mono', '180 Mono'],
  ['360', 'sbs', '360 SBS'], ['360', 'tb', '360 TB'], ['360', 'mono', '360 Mono'],
];
const VOL_STEP = 0.05, VOL_SPEED = 0.4, VOL_HOLD_DELAY = 400;
// main control bar: 20° below straight ahead, wide for precise seeking
const PANEL_DIST = 1.1, PANEL_ELEV = THREE.MathUtils.degToRad(-20), PANEL_WIDTH = 1.3;
const PANEL_KEY = 'questvr:panel2';
// auto-hide: fade out after this long without interaction while the video plays
const FADE_DELAY = 4000, FADE_DELAY_SUB = 12000, FADE_TIME = 250;   // ms
const CW = 2048;                      // canvas width of all panels (px)
const UP = new THREE.Vector3(0, 1, 0);
const DEG = THREE.MathUtils.RAD2DEG, RAD = THREE.MathUtils.DEG2RAD;

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
// only values that differ from the baseline are saved, so later default changes still apply
export function settingsDiff(s, baseline) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    const b = baseline[k];
    const same = typeof v === 'number' && typeof b === 'number' ? Math.abs(v - b) < 1e-6 : v === b;
    if (!same) out[k] = v;
  }
  return out;
}
const RENDER_SCALE = { min: 0.5, max: 1.5 };     // 1.5 = Quest 3 browser maximum (measured)
// framebuffer scale factors; the Quest 3 browser caps at 1.5 (measured: 175/200 % give the 150 % size)
const QUALITY_LEVELS = [0.5, 0.75, 1, 1.25, 1.5];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapDeg = d => ((d + 180) % 360 + 360) % 360 - 180;
const wrapRad = r => Math.atan2(Math.sin(r), Math.cos(r));
const distToNorm = d => Math.log(d / RANGES.distance.min) / Math.log(RANGES.distance.max / RANGES.distance.min);
const normToDist = n => RANGES.distance.min * Math.pow(RANGES.distance.max / RANGES.distance.min, n);
const fmtTime = t => {
  if (!isFinite(t)) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* simple vector icons drawn on the canvas (no font glyph dependencies) */
function drawIcon(ctx, kind, cx, cy, s) {
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = s * 0.12;
  const tri = (x, y, w, h, dir) => {
    ctx.beginPath();
    if (dir > 0) { ctx.moveTo(x, y - h / 2); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h / 2); }
    else { ctx.moveTo(x + w, y - h / 2); ctx.lineTo(x, y); ctx.lineTo(x + w, y + h / 2); }
    ctx.closePath(); ctx.fill();
  };
  switch (kind) {
    case 'play': tri(cx - s * 0.35, cy, s * 0.8, s * 0.9, 1); break;
    case 'pause': ctx.fillRect(cx - s * 0.35, cy - s * 0.42, s * 0.24, s * 0.84); ctx.fillRect(cx + s * 0.11, cy - s * 0.42, s * 0.24, s * 0.84); break;
    case 'prevMark': ctx.fillRect(cx - s * 0.45, cy - s * 0.4, s * 0.14, s * 0.8); tri(cx - s * 0.25, cy, s * 0.65, s * 0.8, -1); break;
    case 'nextMark': ctx.fillRect(cx + s * 0.31, cy - s * 0.4, s * 0.14, s * 0.8); tri(cx - s * 0.4, cy, s * 0.65, s * 0.8, 1); break;
    case 'speaker': case 'muted': {
      ctx.fillRect(cx - s * 0.5, cy - s * 0.18, s * 0.22, s * 0.36);
      ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy - s * 0.18); ctx.lineTo(cx, cy - s * 0.45);
      ctx.lineTo(cx, cy + s * 0.45); ctx.lineTo(cx - s * 0.3, cy + s * 0.18); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      if (kind === 'muted') {
        ctx.moveTo(cx + s * 0.15, cy - s * 0.2); ctx.lineTo(cx + s * 0.5, cy + s * 0.2);
        ctx.moveTo(cx + s * 0.5, cy - s * 0.2); ctx.lineTo(cx + s * 0.15, cy + s * 0.2);
      } else {
        ctx.arc(cx + s * 0.05, cy, s * 0.25, -0.9, 0.9);
        ctx.moveTo(cx + s * 0.05 + s * 0.42 * Math.cos(-0.9), cy + s * 0.42 * Math.sin(-0.9));
        ctx.arc(cx + s * 0.05, cy, s * 0.42, -0.9, 0.9);
      }
      ctx.stroke();
      break;
    }
  }
}

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `
uniform sampler2D map;
uniform vec4 rect;
uniform float shift;
uniform float zoom;
uniform float wrapX;
varying vec2 vUv;
void main() {
  vec2 uv = (vUv - 0.5) * zoom + 0.5;
  uv.x += shift;
  if (wrapX > 0.5) uv.x = fract(uv.x);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    // Three.js uploads video frames without sRGB decoding (unlike its built-in
    // materials, a custom shader must decode itself), otherwise the output is
    // sRGB-encoded twice and looks too bright / washed out.
    gl_FragColor = sRGBTransferEOTF(texture2D(map, rect.xy + uv * rect.zw));
  }
  #include <colorspace_fragment>
}`;

/**
 * Start the immersive player on an already requested XR session.
 * opts: { session, player (videojs-like), sceneId, title, markers: [{seconds,title}],
 *         settings (initial S), defaults (for Reset), baseline (S without saved values),
 *         storageKey, renderScale (framebuffer scale, 1 = default),
 *         onRenderScaleChange(scale) (optional: host remembers the choice; enables the quality menu),
 *         viewYaw, takeover (internal: used when the quality is switched in a running session), onEnd }
 */
export async function startVR(opts) {
  const { session, player } = opts;
  const video = player.el().querySelector('video');
  const S = { ...opts.settings };
  const markers = (opts.markers || []).map(m => m.seconds).filter(s => isFinite(s)).sort((a, b) => a - b);
  const disposables = [];
  const keep = o => { disposables.push(o); return o; };

  /* ---------- renderer / scene ---------- */
  const canvas = document.createElement('canvas');
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  renderer.xr.setFoveation(0);
  // render quality: >1 renders above the headset's default resolution (sharper, more GPU)
  const renderScale = clamp(Number(opts.renderScale) || 1, RENDER_SCALE.min, RENDER_SCALE.max);
  if (renderScale !== 1) renderer.xr.setFramebufferScaleFactor(renderScale);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.05, 2000);
  scene.add(camera);

  const texture = keep(new THREE.VideoTexture(video));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  /* ---------- dome ---------- */
  let viewYaw = Number(opts.viewYaw) || 0;   // "Recenter" (session only)
  const viewQuat = new THREE.Quaternion();
  const corrEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const corrQuat = new THREE.Quaternion();
  const dome = new THREE.Group();
  scene.add(dome);
  let domeProjection = null;
  const eyeMeshes = [0, 1].map(eye => {
    const mat = keep(new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture }, rect: { value: new THREE.Vector4(0, 0, 0.5, 1) },
        shift: { value: 0 }, zoom: { value: 1 }, wrapX: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, depthWrite: false,
    }));
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.layers.set(eye + 1);         // layer 1 = left eye, layer 2 = right eye
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    dome.add(mesh);
    return mesh;
  });

  function buildGeometry(projection) {
    const g = projection === '360'
      ? new THREE.SphereGeometry(1, 128, 64, Math.PI / 2, Math.PI * 2)
      : new THREE.SphereGeometry(1, 96, 64, Math.PI, Math.PI);
    g.scale(-1, 1, 1);
    return g;
  }
  function updateDomeRotation() {
    // view recenter, then the per-scene correction: turn (yaw) -> tilt (pitch) -> roll
    viewQuat.setFromAxisAngle(UP, viewYaw);
    corrEuler.set(S.tilt * RAD, S.yaw * RAD, S.roll * RAD, 'YXZ');
    corrQuat.setFromEuler(corrEuler);
    dome.quaternion.copy(viewQuat).multiply(corrQuat);
  }
  function applySettings() {
    if (domeProjection !== S.projection) {
      const g = buildGeometry(S.projection);
      eyeMeshes.forEach(m => { m.geometry.dispose(); m.geometry = g; });
      domeProjection = S.projection;
    }
    dome.scale.setScalar(S.distance);
    updateDomeRotation();
    eyeMeshes.forEach((m, eye) => {
      const src = S.swap ? 1 - eye : eye;
      const u = m.material.uniforms;
      if (S.stereo === 'sbs') u.rect.value.set(src * 0.5, 0, 0.5, 1);
      else if (S.stereo === 'tb') u.rect.value.set(0, src === 0 ? 0.5 : 0, 1, 0.5);
      else u.rect.value.set(0, 0, 1, 1);
      u.shift.value = (eye === 0 ? 1 : -1) * S.depth / 100;   // + = farther
      u.zoom.value = S.zoom;
      u.wrapX.value = S.projection === '360' ? 1 : 0;
    });
    markDirty();
  }
  function changeSettings(patch) {
    Object.assign(S, patch);
    S.yaw = wrapDeg(S.yaw);
    for (const k of Object.keys(RANGES)) S[k] = clamp(S[k], RANGES[k].min, RANGES[k].max);
    applySettings();
    const diff = settingsDiff(S, opts.baseline || opts.defaults || {});
    if (Object.keys(diff).length) store.set(opts.storageKey, diff); else store.del(opts.storageKey);
  }
  const formatLabel = () => (FORMATS.find(f => f[0] === S.projection && f[1] === S.stereo) || FORMATS[0])[2];

  /* ---------- playback (through videojs so Stash stays in sync) ---------- */
  const dur = () => player.duration() || 0;
  const togglePlay = () => { if (player.paused()) player.play()?.catch?.(() => {}); else player.pause(); };
  const seekTo = t => player.currentTime(clamp(t, 0, Math.max(0, dur() - 0.1)));
  const seekBy = s => seekTo(player.currentTime() + s);
  const nextMarker = () => { const t = player.currentTime(); const m = markers.find(x => x > t + 1); if (m !== undefined) seekTo(m); };
  const prevMarker = () => { const t = player.currentTime(); const m = [...markers].reverse().find(x => x < t - 3); if (m !== undefined) seekTo(m); };
  function recenter() {
    const dir = new THREE.Vector3(); renderer.xr.getCamera().getWorldDirection(dir);
    viewYaw = Math.atan2(-dir.x, -dir.z);
    updateDomeRotation();
  }
  function resetSettings() {
    changeSettings({ ...opts.defaults, projection: S.projection, stereo: S.stereo });
  }

  /* ---------- volume HUD ---------- */
  const hud = (() => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 112;
    const tex = keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(0.32, 0.07)),
      keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })),
    );
    mesh.position.set(0, -0.28, -1.1);
    mesh.renderOrder = 12;
    mesh.visible = false;
    camera.add(mesh);
    return { ctx: c.getContext('2d'), tex, mesh, until: 0 };
  })();
  function showHud() {
    const { ctx } = hud;
    const level = player.volume(), muted = player.muted();
    ctx.clearRect(0, 0, 512, 112);
    roundRect(ctx, 0, 0, 512, 112, 28);
    ctx.fillStyle = 'rgba(18,18,22,0.85)'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '600 34px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(muted ? 'Muted' : 'Volume ' + Math.round(level * 100) + ' %', 32, 40);
    roundRect(ctx, 32, 74, 448, 14, 7); ctx.fillStyle = '#34343c'; ctx.fill();
    if (level > 0) {
      roundRect(ctx, 32, 74, Math.max(14, 448 * level), 14, 7);
      ctx.fillStyle = muted ? '#777' : '#3f7cf0'; ctx.fill();
    }
    hud.tex.needsUpdate = true;
    hud.until = performance.now() + 1200;
  }
  function setVolume(v) { player.volume(clamp(v, 0, 1)); if (v > 0) player.muted(false); markDirty(); showHud(); }
  const changeVolume = d => setVolume(player.volume() + d);
  function toggleMute() { player.muted(!player.muted()); markDirty(); showHud(); }

  /* ---------- panels: main control bar + advanced + format popup ---------- */
  function makePanel(name, heightPx, drawExtra) {
    const c = document.createElement('canvas');
    c.width = CW; c.height = heightPx;
    const tex = keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const h = PANEL_WIDTH * heightPx / CW;
    const mesh = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(PANEL_WIDTH, h)),
      keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })),
    );
    mesh.renderOrder = 10;
    const p = { name, ctx: c.getContext('2d'), tex, mesh, h, H: heightPx, widgets: [], dirty: true, lastDraw: 0, drawExtra };
    mesh.userData.panel = p;
    return p;
  }
  const main = makePanel('main', 416, drawMainExtra);
  const adv = makePanel('adv', 500, p => {
    p.ctx.fillStyle = '#fff'; p.ctx.font = '600 34px system-ui, sans-serif'; p.ctx.textAlign = 'left';
    p.ctx.fillText('Advanced', 48, 50);
  });
  const fmt = makePanel('fmt', 150, null);
  const qual = makePanel('qual', 250, p => {
    const { ctx } = p;
    ctx.fillStyle = '#fff'; ctx.font = '600 32px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Render quality', 48, 44);
    ctx.fillStyle = '#aab'; ctx.font = '28px system-ui, sans-serif';
    ctx.fillText('Higher = sharper video, more GPU load. If two levels show the same size, the browser maximum is reached.', 48, 90);
    ctx.textAlign = 'right';
    ctx.fillText(renderInfo(), CW - 48, 44);
  });
  // actual render target size (the browser clamps the requested scale to its own maximum)
  function renderInfo() {
    const layer = renderer.xr.getBaseLayer?.();
    const w = layer?.textureWidth || layer?.framebufferWidth, h = layer?.textureHeight || layer?.framebufferHeight;
    let native = null;
    try { native = window.XRWebGLLayer?.getNativeFramebufferScaleFactor?.(session); } catch { /* unsupported */ }
    return (w ? 'now ' + w + ' × ' + h + ' px' : '') + (native ? '  ·  headset native ≈ ' + native.toFixed(2) + '×' : '');
  }
  const subs = [adv, fmt, qual];
  const panels = [main, ...subs];
  scene.add(main.mesh);
  main.mesh.visible = false;
  // sub-panels hang above the main bar and move with it
  for (const p of subs) {
    main.mesh.add(p.mesh);
    p.mesh.position.set(0, main.h / 2 + 0.02 + p.h / 2, 0.005);
    p.mesh.renderOrder = 10;
    p.mesh.visible = false;
  }
  function markDirty() { panels.forEach(p => { p.dirty = true; }); }
  function showSub(p) {
    for (const q of subs) q.mesh.visible = q === p ? !q.mesh.visible : false;
    markDirty();
  }

  // --- widgets ---
  const button = (p, x, y, w, h, opts2) => p.widgets.push({ type: 'button', x, y, w, h, ...opts2 });
  function slider(p, o) {
    // o: { x, y, w, h, label?, labelX?, valueX?, get, set, text?, live?, seek? }
    p.widgets.push({ type: 'slider', live: true, ...o });
  }
  function settingSlider(p, x0, y, key, label, fmt2) {
    const r = RANGES[key], isLog = key === 'distance';
    slider(p, {
      x: x0 + 210, y, w: 590, h: 70, label, labelX: x0, valueX: x0 + 940,
      get: () => isLog ? distToNorm(S[key]) : (S[key] - r.min) / (r.max - r.min),
      set: n => changeSettings({ [key]: isLog ? normToDist(n) : r.min + n * (r.max - r.min) }),
      text: () => fmt2(S[key]),
    });
  }

  // main bar: title/time, wide seek bar, media controls
  slider(main, {
    x: 48, y: 92, w: CW - 96, h: 70, live: false, seek: true,
    get: () => dur() ? player.currentTime() / dur() : 0,
    set: n => { if (dur()) seekTo(n * dur()); },
  });
  // row 1: transport (left) + format / advanced / exit (right)
  const ROW = 192, BH = 92;
  // full-width row: big transport buttons left, format / ••• / Exit right (Exit is the widest target)
  const G = 16;
  let x = 48;
  const place = (w, o) => { button(main, x, ROW, w, BH, o); x += w + G; };
  place(180, { icon: 'prevMark', onClick: prevMarker });
  place(180, { label: '−10', onClick: () => seekBy(-10) });
  place(230, { icon: () => player.paused() ? 'play' : 'pause', onClick: togglePlay, primary: true });
  place(180, { label: '+10', onClick: () => seekBy(10) });
  place(180, { icon: 'nextMark', onClick: nextMarker });
  x = CW - 48 - (240 + G + 170 + G + 300);   // right-aligned group; the gap between the groups stays
  place(240, { label: formatLabel, small: true, onClick: () => showSub(fmt), active: () => fmt.mesh.visible });
  place(170, { label: '•••', onClick: () => showSub(adv), active: () => adv.mesh.visible });
  place(300, { label: 'Exit VR', onClick: () => session.end().catch(() => {}), danger: true });
  // row 2: long volume and zoom sliders (zoom with −/+ in 0.05 steps)
  const ROW2 = ROW + BH + 16, SH = 84;
  button(main, 48, ROW2, 100, SH, { icon: () => player.muted() ? 'muted' : 'speaker', onClick: toggleMute });
  slider(main, {
    x: 178, y: ROW2 + 7, w: 700, h: 70, valueX: 975,
    get: () => player.volume(), set: n => setVolume(n),
    text: () => player.muted() ? 'muted' : Math.round(player.volume() * 100) + '%',
  });
  const zoomStep = d => changeSettings({ zoom: Math.round((S.zoom + d) * 100) / 100 });
  button(main, 1110, ROW2, 90, SH, { label: '−', onClick: () => zoomStep(-0.05) });
  slider(main, {
    x: 1225, y: ROW2 + 7, w: 575, h: 70, label: 'Zoom', labelX: 1015, valueX: CW - 48,
    get: () => (S.zoom - RANGES.zoom.min) / (RANGES.zoom.max - RANGES.zoom.min),
    set: n => changeSettings({ zoom: RANGES.zoom.min + n * (RANGES.zoom.max - RANGES.zoom.min) }),
    text: () => S.zoom.toFixed(2),
  });
  button(main, 1825, ROW2, 90, SH, { label: '+', onClick: () => zoomStep(0.05) });

  // advanced panel
  button(adv, CW - 48 - 150, 18, 150, 64, { label: 'Close', small: true, onClick: () => showSub(adv) });
  settingSlider(adv, 48, 100, 'distance', 'Distance', v => v.toFixed(v < 10 ? 1 : 0) + ' m');
  settingSlider(adv, 1060, 100, 'depth', 'Depth', v => (v > 0 ? '+' : '') + v.toFixed(2));
  settingSlider(adv, 48, 190, 'yaw', 'Turn', v => Math.round(v) + '°');
  settingSlider(adv, 1060, 190, 'tilt', 'Tilt', v => Math.round(v) + '°');
  settingSlider(adv, 48, 280, 'roll', 'Roll', v => Math.round(v) + '°');
  const aW = (CW - 96 - 5 * 16) / 6;
  [
    ['Swap eyes', () => changeSettings({ swap: !S.swap }), () => S.swap],
    ['Follow head', () => changeSettings({ follow: !S.follow }), () => S.follow],
    ['Loop', () => { player.loop(!player.loop()); markDirty(); }, () => player.loop()],
    ['Recenter view', recenter, null],
    ['Reset bar', resetPanelPlacement, null],
    ['Reset scene', resetSettings, null],
  ].forEach(([label, onClick, active], i) => button(adv, 48 + i * (aW + 16), 390, aW, 84, { label, onClick, active, small: true }));
  if (typeof opts.onRenderScaleChange === 'function') {
    button(adv, 1060, 280, 940, 70, {
      label: () => 'Render quality: ' + Math.round(renderScale * 100) + ' %  ▸', small: true,
      onClick: () => showSub(qual),
    });
  }

  // render quality popup
  const qW = (CW - 96 - (QUALITY_LEVELS.length - 1) * 16) / QUALITY_LEVELS.length;
  QUALITY_LEVELS.forEach((scale, i) => button(qual, 48 + i * (qW + 16), 130, qW, 92, {
    label: Math.round(scale * 100) + ' %', active: () => Math.abs(scale - renderScale) < 0.01,
    onClick: () => {
      if (Math.abs(scale - renderScale) < 0.01) { showSub(qual); return; }
      switchRenderScale(scale);
    },
  }));

  /* A new framebuffer size needs a new XR layer, which Three.js only creates in setSession().
     Instead of leaving VR (slow OS transition), this instance lets go of the session and a new
     instance with the new size takes over the SAME session. If that fails, VR is ended. */
  let swapping = false;
  async function switchRenderScale(scale) {
    if (swapping) return;
    swapping = true;
    opts.onRenderScaleChange?.(scale);           // the host remembers the choice
    session.removeEventListener('end', cleanup);
    renderer.setAnimationLoop(null);
    try {
      // synthetic event: only makes this instance's Three.js XR manager detach (the session keeps running)
      session.dispatchEvent(new Event('end'));
      const next = await startVR({ ...opts, settings: { ...S }, renderScale: scale, viewYaw, takeover: true });
      handle.end = next.end;                     // the host's handle now ends the new instance
      teardown();
    } catch (e) {
      console.warn('questvr: render quality switch failed, leaving VR', e);
      cleanup();
      session.end().catch(() => {});
    }
  }

  // format popup
  const fW = (CW - 96 - 5 * 16) / 6;
  FORMATS.forEach(([proj, stereo, label], i) => button(fmt, 48 + i * (fW + 16), 30, fW, 90, {
    label, active: () => S.projection === proj && S.stereo === stereo,
    onClick: () => { changeSettings({ projection: proj, stereo }); showSub(fmt); },
  }));

  function drawMainExtra(p) {
    const { ctx } = p;
    ctx.fillStyle = '#fff'; ctx.font = '600 34px system-ui, sans-serif'; ctx.textAlign = 'left';
    const full = opts.title || 'Scene ' + opts.sceneId;
    let title = full;
    while (ctx.measureText(title).width > 1500 && title.length > 4) title = title.slice(0, -2);
    if (title !== full) title += '…';
    ctx.fillText(title, 48, 50);
    ctx.fillStyle = '#aab'; ctx.font = '32px system-ui, sans-serif'; ctx.textAlign = 'right';
    const t = drag?.widget.seek ? drag.value * dur() : player.currentTime();
    ctx.fillText(fmtTime(t) + ' / ' + fmtTime(dur()), CW - 48, 50);
  }

  function drawPanel(p) {
    const { ctx } = p;
    const hovered = new Set(controllers.map(c => c.userData.hover).filter(Boolean));
    ctx.clearRect(0, 0, CW, p.H);
    roundRect(ctx, 0, 0, CW, p.H, 36);
    ctx.fillStyle = 'rgba(18,18,22,0.92)'; ctx.fill();
    ctx.textBaseline = 'middle';
    p.drawExtra?.(p);
    for (const w of p.widgets) {
      const hot = hovered.has(w);
      if (w.type === 'button') {
        roundRect(ctx, w.x, w.y, w.w, w.h, 16);
        ctx.fillStyle = w.active?.() ? '#3f7cf0' : w.danger ? (hot ? '#a8424a' : '#7a2f36') : hot ? '#3a3a44' : w.primary ? '#30303a' : '#26262e';
        ctx.fill();
        const icon = typeof w.icon === 'function' ? w.icon() : w.icon;
        if (icon) drawIcon(ctx, icon, w.x + w.w / 2, w.y + w.h / 2, Math.min(w.w, w.h) * 0.5);
        else {
          ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
          ctx.font = (w.small ? '28px' : '34px') + ' system-ui, sans-serif';
          ctx.fillText(typeof w.label === 'function' ? w.label() : w.label, w.x + w.w / 2, w.y + w.h / 2);
        }
        continue;
      }
      const n = drag?.widget === w ? drag.value : clamp(w.get(), 0, 1);
      const ty = w.y + w.h / 2;
      ctx.font = '30px system-ui, sans-serif';
      if (w.label) { ctx.fillStyle = '#dde'; ctx.textAlign = 'left'; ctx.fillText(w.label, w.labelX, ty); }
      if (w.text) { ctx.fillStyle = '#aab'; ctx.textAlign = 'right'; ctx.fillText(w.text(), w.valueX, ty); }
      const th = w.seek ? 22 : 14;
      roundRect(ctx, w.x, ty - th / 2, w.w, th, th / 2); ctx.fillStyle = '#34343c'; ctx.fill();
      roundRect(ctx, w.x, ty - th / 2, Math.max(th, w.w * n), th, th / 2); ctx.fillStyle = '#3f7cf0'; ctx.fill();
      if (w.seek && dur()) {             // Stash scene markers as ticks
        ctx.fillStyle = '#ffcc33';
        for (const m of markers) ctx.fillRect(w.x + w.w * (m / dur()) - 3, ty - 26, 6, 52);
      }
      ctx.beginPath(); ctx.arc(w.x + w.w * n, ty, (hot ? 1.3 : 1) * (w.seek ? 22 : 18), 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    p.tex.needsUpdate = true;
    p.dirty = false;
    p.lastDraw = performance.now();
  }
  const widgetAt = (p, px, py) => p.widgets.find(w => px >= w.x - 8 && px <= w.x + w.w + 8 && py >= w.y - 8 && py <= w.y + w.h + 8);

  /* main bar placement relative to the head; default 20° below straight ahead */
  const panelRef = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  let grabbedBy = null;
  function headFrame() {
    const xrCam = renderer.xr.getCamera();
    const pos = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
    const dir = new THREE.Vector3(); xrCam.getWorldDirection(dir);
    return { pos, quat: new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-dir.x, -dir.z)) };
  }
  function placePanel() {
    const { pos, quat } = headFrame();
    panelRef.pos.copy(pos); panelRef.quat.copy(quat);
    const saved = store.get(PANEL_KEY);
    const m = main.mesh;
    if (saved) {
      m.position.fromArray(saved.p).applyQuaternion(quat).add(pos);
      m.quaternion.copy(quat).multiply(new THREE.Quaternion().fromArray(saved.q));
    } else {
      m.position.set(0, Math.sin(PANEL_ELEV) * PANEL_DIST, -Math.cos(PANEL_ELEV) * PANEL_DIST).applyQuaternion(quat).add(pos);
      m.lookAt(pos);
    }
  }
  function resetPanelPlacement() {
    store.del(PANEL_KEY);
    placePanel();
    markDirty();
  }
  function savePanelPlacement() {
    const inv = panelRef.quat.clone().invert();
    const p = main.mesh.position.clone().sub(panelRef.pos).applyQuaternion(inv);
    store.set(PANEL_KEY, { p: p.toArray(), q: inv.multiply(main.mesh.quaternion).toArray() });
  }
  /* menu visibility: shown on any input, fades fully out after FADE_DELAY of
     inactivity while playing; never while paused, pointed at, dragged or grabbed */
  let menuTarget = 0, menuOpacity = 0, lastActivity = 0;
  function showMenu() {
    lastActivity = performance.now();
    if (menuTarget === 1) return;
    if (!main.mesh.visible && !grabbedBy) { placePanel(); markDirty(); }
    main.mesh.visible = true;
    controllers.forEach(c => { c.userData.line.visible = true; });
    menuTarget = 1;
  }
  // auto-hide fades out (and can be "caught" by pointing at it); manual hide is instant
  function hideMenu(instant = false) {
    menuTarget = 0;
    if (instant) { menuOpacity = 0; drag = null; finishHide(); }
  }
  function finishHide() {
    main.mesh.visible = false;
    subs.forEach(q => { q.mesh.visible = false; });
    controllers.forEach(c => {
      c.userData.line.visible = false;
      c.userData.cursor.visible = false;
      c.userData.hit = null;
      c.userData.hover = null;
    });
  }
  const menuShown = () => menuTarget === 1;
  const toggleMenu = () => { if (menuShown()) hideMenu(true); else showMenu(); };
  function setPanelVisible(v) { if (v) showMenu(); else hideMenu(true); }
  function updateMenuFade(now, dt) {
    // a ray resting on the bar (e.g. hand in the lap) is not activity; a moving one is
    const pointing = controllers.some(c => c.userData.hit && c.userData.hitMoved);
    if (drag || grabbedBy || pointing) lastActivity = now;
    const delay = subs.some(q => q.mesh.visible) ? FADE_DELAY_SUB : FADE_DELAY;
    if (menuTarget === 1 && !player.paused() && now - lastActivity > delay) hideMenu();
    const step = dt * 1000 / FADE_TIME;
    menuOpacity = menuTarget ? Math.min(1, menuOpacity + step) : Math.max(0, menuOpacity - step);
    for (const p of panels) p.mesh.material.opacity = menuOpacity;
    controllers.forEach(c => {
      c.userData.line.material.opacity = 0.7 * menuOpacity;
      c.userData.cursor.material.opacity = menuOpacity;
    });
    if (menuOpacity === 0 && menuTarget === 0 && main.mesh.visible) finishHide();
  }

  /* ---------- controllers ---------- */
  const raycaster = new THREE.Raycaster();
  const tmpMat = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  let drag = null;                    // slider drag
  let domeGrab = null;                // grip-drag of the video
  const cursorTex = keep(new THREE.CanvasTexture((() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.72, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.82, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.92, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return cv;
  })()));
  cursorTex.colorSpace = THREE.SRGBColorSpace;
  const CURSOR_SIZE = 0.022;          // metres (on a bar ~1.1 m away)
  const cursorGeo = keep(new THREE.PlaneGeometry(CURSOR_SIZE, CURSOR_SIZE));
  const _n = new THREE.Vector3();

  const controllers = [0, 1].map(i => {
    const c = renderer.xr.getController(i);
    const line = new THREE.Line(
      keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)])),
      keep(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false })),
    );
    line.renderOrder = 11;
    line.visible = false;
    c.add(line);
    const cursor = new THREE.Mesh(cursorGeo, keep(new THREE.MeshBasicMaterial({
      map: cursorTex, transparent: true, depthTest: false, depthWrite: false,
    })));
    cursor.renderOrder = 13;          // above the bar and the rays
    cursor.visible = false;
    scene.add(cursor);
    c.userData = { line, cursor, pressed: false, hover: null, hit: null, source: null, prevButtons: [], stick: { x: 0, y: 0, volHold: 0 } };
    c.addEventListener('connected', e => { c.userData.source = e.data; });
    c.addEventListener('disconnected', () => { c.userData.source = null; c.userData.hover = null; });
    c.addEventListener('selectstart', () => { c.userData.pressed = true; onSelectStart(c); });
    c.addEventListener('selectend', () => { c.userData.pressed = false; onSelectEnd(c); });
    c.addEventListener('squeezestart', () => onSqueezeStart(c));
    c.addEventListener('squeezeend', () => onSqueezeEnd(c));
    scene.add(c);
    return c;
  });

  function updatePointer(c) {
    const prevHover = c.userData.hover;
    pointerHit(c);
    if (c.userData.hover !== prevHover) markDirty();   // hover highlight follows the ray
  }
  function pointerHit(c) {
    c.userData.hover = null; c.userData.hit = null;
    if (!main.mesh.visible) return;
    tmpMat.identity().extractRotation(c.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat);
    const targets = panels.filter(p => p.mesh.visible).map(p => p.mesh);
    const hit = raycaster.intersectObjects(targets, false)[0];
    c.userData.line.scale.z = hit ? hit.distance : 3;
    const cur = c.userData.cursor;
    cur.visible = !!hit;
    if (hit) {
      hit.object.getWorldQuaternion(cur.quaternion);
      _n.set(0, 0, 1).applyQuaternion(cur.quaternion);
      cur.position.copy(hit.point).addScaledVector(_n, 0.003);
      cur.scale.setScalar(c.userData.pressed ? 0.75 : 1);
    }
    if (!hit) { c.userData.lastPx = null; return; }
    const p = hit.object.userData.panel;
    const px = hit.uv.x * CW, py = (1 - hit.uv.y) * p.H;
    // did the ray move noticeably on the bar since the last frame? (hand jitter < ~12 px)
    const lp = c.userData.lastPx;
    c.userData.hitMoved = !lp || Math.hypot(px - lp.px, py - lp.py) > 12;
    if (c.userData.hitMoved) c.userData.lastPx = { px, py };
    if (!menuShown() && c.userData.hitMoved) showMenu();   // caught it while auto-fading
    c.userData.hit = { panel: p, px, py };
    c.userData.hover = widgetAt(p, px, py) || null;
  }
  function onSelectStart(c) {
    updatePointer(c);
    const w = c.userData.hover;
    if (!main.mesh.visible || !c.userData.hit) { toggleMenu(); return; }
    showMenu();
    if (!w) return;
    if (w.type === 'button') { w.onClick(); markDirty(); return; }
    drag = { controller: c, widget: w, panel: c.userData.hit.panel, value: w.get() };
    dragTo(c);
  }
  function dragTo(c) {
    if (!drag || drag.controller !== c || !c.userData.hit || c.userData.hit.panel !== drag.panel) return;
    drag.value = clamp((c.userData.hit.px - drag.widget.x) / drag.widget.w, 0, 1);
    if (drag.widget.live) drag.widget.set(drag.value);
    drag.panel.dirty = true;
  }
  function onSelectEnd(c) {
    if (drag && drag.controller === c) { drag.widget.set(drag.value); drag = null; markDirty(); }
  }
  function pointerAngles(c) {
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(_q)).normalize();
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(clamp(d.y, -1, 1)) };
  }
  function onSqueezeStart(c) {
    if (main.mesh.visible && !grabbedBy) {
      updatePointer(c);
      const handPos = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
      if (c.userData.hit || handPos.distanceTo(main.mesh.position) <= 0.35) {
        showMenu();
        c.attach(main.mesh);
        grabbedBy = c;
        return;
      }
    }
    // grab the video: left/right = turn, up/down = tilt (never roll)
    if (!domeGrab) domeGrab = { c, a0: pointerAngles(c), yaw0: S.yaw, tilt0: S.tilt };
  }
  function onSqueezeEnd(c) {
    if (domeGrab && domeGrab.c === c) {
      domeGrab = null;
      changeSettings({});             // clamp + save the new turn/tilt for this scene
    }
    if (grabbedBy !== c) return;
    scene.attach(main.mesh);
    grabbedBy = null;
    savePanelPlacement();
  }
  function updateDomeGrab() {
    if (!domeGrab) return;
    const a = pointerAngles(domeGrab.c);
    S.yaw = wrapDeg(domeGrab.yaw0 + wrapRad(a.yaw - domeGrab.a0.yaw) * DEG);
    S.tilt = clamp(domeGrab.tilt0 + (a.pitch - domeGrab.a0.pitch) * DEG, RANGES.tilt.min, RANGES.tilt.max);
    updateDomeRotation();
    adv.dirty = true;
  }

  function pollGamepad(c, dt) {
    const src = c.userData.source;
    const gp = src?.gamepad;
    if (!gp) return;
    const right = src.handedness === 'right';
    const ax = gp.axes[2] ?? 0, ay = gp.axes[3] ?? 0;
    const st = c.userData.stick;
    // right stick ← → seeks; left stick ← → is intentionally unused (avoids accidental changes)
    if (right && Math.abs(ax) > 0.7 && st.x === 0) {
      st.x = Math.sign(ax);
      seekBy(st.x * 10);
      showMenu();
    } else if (Math.abs(ax) < 0.3) st.x = 0;
    if (right) {
      if (Math.abs(ay) > 0.6) {
        const up = ay < 0 ? 1 : -1, now = performance.now();
        if (!st.volHold) { st.volHold = now; changeVolume(up * VOL_STEP); }
        else if (now - st.volHold > VOL_HOLD_DELAY) changeVolume(up * VOL_SPEED * dt * Math.abs(ay));
      } else if (Math.abs(ay) < 0.3) st.volHold = 0;
    } else if (Math.abs(ay) > 0.7 && st.y === 0) {
      // left stick ↑ ↓ = zoom in 0.05 steps (up = higher value = smaller / farther)
      st.y = Math.sign(ay);
      zoomStep(st.y < 0 ? 0.05 : -0.05);
      showMenu();
    } else if (Math.abs(ay) < 0.3) st.y = 0;
    const pressed = gp.buttons.map(b => b.pressed);
    const prev = c.userData.prevButtons;
    if (pressed[4] && !prev[4]) { togglePlay(); showMenu(); }
    if (pressed[5] && !prev[5]) toggleMenu();
    if (right && pressed[3] && !prev[3]) toggleMute();
    c.userData.prevButtons = pressed;
  }

  /* ---------- loop + lifecycle ---------- */
  const PLAYER_EVENTS = ['play', 'pause', 'seeked', 'volumechange'];
  player.on(PLAYER_EVENTS, markDirty);
  player.on('pause', showMenu);

  applySettings();
  await renderer.xr.setSession(session);
  if (opts.takeover) {
    // Three.js only learns about controllers from 'inputsourceschange' events, which the browser
    // sends when a session starts. When taking over a RUNNING session the controllers already
    // exist, so replay that event for them (otherwise sticks, buttons and rays stay dead).
    const ev = new Event('inputsourceschange');
    Object.defineProperties(ev, { added: { value: Array.from(session.inputSources || []) }, removed: { value: [] } });
    session.dispatchEvent(ev);
  }

  let firstFrame = true, lastT = performance.now();
  const camPos = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const xrCam = renderer.xr.getCamera();
    if (firstFrame) { firstFrame = false; setPanelVisible(true); }
    if (S.follow) dome.position.copy(camPos.setFromMatrixPosition(xrCam.matrixWorld));
    else dome.position.set(0, 0, 0);
    for (const c of controllers) { updatePointer(c); dragTo(c); pollGamepad(c, dt); }
    updateDomeGrab();
    updateMenuFade(now, dt);
    for (const p of panels) {
      const visible = p.mesh.visible && (p === main || main.mesh.visible);
      // redraw at most ~30x per second (dragging a slider would otherwise redraw every frame)
      const due = now - p.lastDraw > 33;
      if (visible && due && (p.dirty || (p === main && now - p.lastDraw > 500))) drawPanel(p);
    }
    const a = clamp((hud.until - now) / 300, 0, 1);
    hud.mesh.visible = a > 0;
    hud.mesh.material.opacity = a;
    renderer.render(scene, camera);
  });

  let ended = false;
  function cleanup() {
    if (ended) return;
    teardown();
    opts.onEnd?.();
  }
  function teardown() {
    if (ended) return;
    ended = true;
    // the player may already be disposed (e.g. Stash navigated to another scene)
    try { player.off(PLAYER_EVENTS, markDirty); player.off('pause', showMenu); } catch { /* ignore */ }
    renderer.setAnimationLoop(null);
    eyeMeshes.forEach(m => m.geometry.dispose());
    disposables.forEach(d => { try { d.dispose?.(); } catch { /* ignore */ } });
    renderer.dispose();
    renderer.forceContextLoss();      // free the GPU context now; browsers allow only ~16
    canvas.remove();
  }
  session.addEventListener('end', cleanup);

  const handle = { end: () => session.end().catch(cleanup) };
  return handle;
}
