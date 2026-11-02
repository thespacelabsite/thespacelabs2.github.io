/*
 * SpaceLabs — gl.js : the single shared WebGL engine.
 * One WebGLRenderer on <canvas id="stage"> (fixed, behind a transparent <body>).
 * Scenes paint into DOM rectangles ("regions") through scissor viewports, or into the
 * whole viewport ("full" regions). Every entry point is wrapped so a failure degrades to
 * the poster / static DOM instead of a broken page.
 *
 * ES module. Expects an import map that resolves 'three' and 'three/addons/'.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ------------------------------------------------------------------ tokens */
export const COLORS = Object.freeze({
  void: 0x050507, ink: 0x0B0B10, panel: 0x12121A, panelRaised: 0x1A1A24,
  line: 0x2A2A36, lineStrong: 0x3A3A48, text: 0xF4F4F7, muted: 0xA0A0AE, dim: 0x5F5F6E,
  accent: 0xD412A1, accentHot: 0xFF3FC6, accentDeep: 0x6B0A52,
  atmos: 0x4FA8FF, atmosDeep: 0x0E2E6B, sun: 0xFFE6C2, earthNight: 0xF2B46A, plumeCore: 0xFF6A3D,
  satBus: 0xB8BCC6, satPanel: 0x0E1B3A, satDish: 0xD9D9D9,
});
export const SUN_DIR = new THREE.Vector3(5, 1.2, 2.5).normalize();
export const TEXTURE_BASE = new URL('../textures/', import.meta.url).href;
export const TEXTURE_CDN = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/';
export const TIERS = ['HIGH', 'MID', 'LOW', 'NONE'];

/* ------------------------------------------------------------------ math */
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const remap = (x, a, b, c = 0, d = 1) => lerp(c, d, clamp((x - a) / (b - a)));
/** frame-rate independent exponential approach: returns new value */
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
export const ease = Object.freeze({
  inOut1: t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  inOut2: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out2: t => 1 - Math.pow(1 - t, 3),
  out4: t => 1 - Math.pow(1 - t, 5),
  in3: t => t * t * t * t,
  reveal: t => 1 - Math.pow(1 - t, 4),
});
const DEG = Math.PI / 180;
export { DEG };

/** latitude/longitude (degrees, east positive) -> point in Earth spin-local space (three SphereGeometry UV mapping) */
export function latLonToLocal(latDeg, lonDeg, r = 1, out = new THREE.Vector3()) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return out.set(Math.cos(la) * Math.cos(lo) * r, Math.sin(la) * r, -Math.cos(la) * Math.sin(lo) * r);
}

/** dispose geometries / materials / textures under an Object3D */
export function disposeObject(root) {
  if (!root) return;
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
      if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) v.dispose(); }
      m.dispose();
    }
  });
}

/* ------------------------------------------------------------------ environment */
const GPU_BLOCKLIST = /Mali-G5\d|Mali-T\d|Adreno \(TM\) 5\d\d|Adreno \(TM\) 6[0-3]\d|Apple A1[01]\b|Intel\(R\) HD Graphics [45]\d{3}|SwiftShader|llvmpipe|Software/i;

function env() {
  const mm = q => { try { return matchMedia(q).matches; } catch { return false; } };
  const isTouch = mm('(pointer: coarse)');
  const fine = mm('(pointer: fine)');
  const reduced = mm('(prefers-reduced-motion: reduce)');
  let motionPref = null;
  try { motionPref = localStorage.getItem('sl-motion'); } catch { /* private mode */ }
  const narrow = window.innerWidth < 768;
  const portrait = window.innerHeight > window.innerWidth;
  return { isTouch, fine, reduced, motionPref, narrow, portrait };
}

// integrated / shared-memory GPUs: fine at MID, but bloom + PMREM + extra shader variants on HIGH cause
// multi-hundred-ms shader-link stalls (measured on Intel Iris Xe: 0.3–0.5 s freezes while scrolling)
const INTEGRATED_GPU = /Intel|Iris|UHD Graphics|Radeon\(TM\) (Vega |R\d )?Graphics|Radeon Graphics|Vega \d+ Graphics/i;

function tierFromContext(renderer, e, gpu) {
  const isWebGL2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
  const mem = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency || 4;
  const blocked = GPU_BLOCKLIST.test(gpu || '');
  if (!isWebGL2 || blocked || (mem !== undefined && mem <= 2) || (e.isTouch && e.narrow)) return 'LOW';
  if (e.fine && !e.isTouch && cores >= 6 && (mem === undefined || mem >= 4) && !INTEGRATED_GPU.test(gpu || '')) return 'HIGH';
  return 'MID';
}

function dprFor(tier, isTouch) {
  const cap = tier === 'HIGH' ? 1.75 : tier === 'MID' ? 1.25 : 1.0;
  return Math.min(window.devicePixelRatio || 1, cap, isTouch ? 1.25 : 1.75);
}

/* ================================================================== STAGE */
/**
 * createStage(opts) -> stage
 *  opts.tier     force a tier ('HIGH'|'MID'|'LOW'|'NONE'); also honoured from ?tier=
 *  opts.canvas   existing canvas (default: #stage, created if missing)
 *  opts.bloom    allow UnrealBloom on HIGH (default true)
 *  opts.debug    show the debug readout (default: ?debug=1)
 * Never throws. If WebGL is unavailable, returns a stage with tier 'NONE' whose methods are no-ops.
 */
export function createStage(opts = {}) {
  const e = env();
  const qs = new URLSearchParams(location.search);
  const listeners = new Map();
  const stage = {
    tier: 'NONE', renderer: null, canvas: null, dpr: 1, time: 0,
    isTouch: e.isTouch, narrow: e.narrow, portrait: e.portrait, reduced: e.reduced,
    quality: { bloom: false, stars: 1, clouds: true, step: 0 },
    pointer: { x: 0, y: 0, nx: 0, ny: 0, has: false },
    regions: [], width: 1, height: 1,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    emit(type, detail) {
      const set = listeners.get(type); if (set) for (const fn of [...set]) { try { fn(detail); } catch (err) { console.warn('[gl] listener', err); } }
      try { document.dispatchEvent(new CustomEvent('sl:gl', { detail: { type, ...detail } })); } catch { /* noop */ }
    },
    isNone() { return stage.tier === 'NONE'; },
    register() { return null; }, unregister() {}, wake() {}, markDirty() {}, getEnvironment() { return null; },
    getDebugInfo() { return { tier: stage.tier, fps: 0, dpr: 1, calls: 0, regions: 0, bloom: false }; },
    dispose() {},
    ready: null,
  };
  let readyResolve; stage.ready = new Promise(r => { readyResolve = r; });

  const setBodyTier = t => { try { document.body.dataset.tier = t; document.documentElement.dataset.tier = t; } catch { /* noop */ } };

  /* ---- tier decision that needs no context */
  const forced = (opts.tier || qs.get('tier') || '').toUpperCase();
  const motionOff = e.motionPref === 'off' || (e.reduced && e.motionPref !== 'on');
  if ((forced && forced === 'NONE') || (!forced && motionOff) || typeof WebGLRenderingContext === 'undefined') {
    setBodyTier('NONE'); stage.reason = motionOff ? 'reduced-motion' : 'no-webgl';
    queueMicrotask(() => stage.emit('tier', { tier: 'NONE', reason: stage.reason }));
    return stage;
  }

  /* ---- canvas + renderer */
  let renderer, canvas;
  try {
    canvas = opts.canvas || document.getElementById('stage');
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.id = 'stage';
      canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;display:block;';
      document.body.prepend(canvas);
    }
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.opacity = '0';
    canvas.style.transition = 'opacity 1.2s ease';
    const preLow = e.isTouch && e.narrow;
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: !preLow, alpha: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: false, stencil: false, failIfMajorPerformanceCaveat: false,
    });
  } catch (err) {
    console.warn('[gl] WebGL unavailable', err);
    if (canvas && !opts.canvas && !document.getElementById('stage')?.dataset.keep) { try { canvas.remove(); } catch { /* noop */ } }
    setBodyTier('NONE'); stage.reason = 'no-webgl';
    queueMicrotask(() => stage.emit('tier', { tier: 'NONE', reason: 'no-webgl' }));
    return stage;
  }

  let gpu = '';
  try { const gl = renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || ''); } catch { /* noop */ }
  const tier = TIERS.includes(forced) ? forced : tierFromContext(renderer, e, gpu);
  stage.tier = tier; stage.gpu = gpu; stage.renderer = renderer; stage.canvas = canvas;
  setBodyTier(tier);

  renderer.setClearColor(COLORS.void, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.autoClear = false;
  renderer.shadowMap.enabled = false;
  stage.dpr = dprFor(tier, e.isTouch);
  renderer.setPixelRatio(stage.dpr);
  stage.quality.bloom = tier === 'HIGH' && opts.bloom !== false && !e.isTouch;

  /* ---- state */
  const regions = stage.regions;
  let running = false, rafId = 0, hidden = document.hidden, disposed = false, broken = false;
  let lastTick = performance.now(), lastRender = 0, lastInput = performance.now(), rectsDirty = true, frames = 0, fpsAcc = 0, fpsT = performance.now(), fps = 0;
  let firstFrame = false, post = null, postLoading = false, envTex = null, envTried = false;
  const sampler = { acc: 0, n: 0, strikes: 0 };
  const cRect = { left: 0, top: 0, width: 1, height: 1 };

  const resize = () => {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth), h = Math.max(1, canvas.clientHeight || window.innerHeight);
    if (w === stage.width && h === stage.height && renderer.getPixelRatio() === stage.dpr) return;
    stage.width = w; stage.height = h; stage.portrait = h > w; stage.narrow = window.innerWidth < 768;
    renderer.setPixelRatio(stage.dpr);
    renderer.setSize(w, h, false);
    if (post) { try { post.composer.setPixelRatio(stage.dpr); post.composer.setSize(w, h); post.bloom.setSize(w / 2, h / 2); } catch { /* noop */ } }
    rectsDirty = true; lastInput = performance.now();
    stage.emit('resize', { width: w, height: h });
    wake();
  };
  resize();

  /* ---- intersection + rect bookkeeping */
  let io = null;
  try {
    io = new IntersectionObserver(entries => {
      for (const en of entries) {
        const r = regions.find(x => x.el === en.target); if (!r) continue;
        r.visible = en.isIntersecting; r.ratio = en.intersectionRatio;
        if (r.spec.onVisible) { try { r.spec.onVisible(r.visible, r); } catch (err) { console.warn('[gl] onVisible', err); } }
      }
      rectsDirty = true; wake();
    }, { rootMargin: '12% 0px 12% 0px', threshold: [0, 0.6] });
  } catch { io = null; }

  const sampleRects = () => {
    const c = canvas.getBoundingClientRect();
    cRect.left = c.left; cRect.top = c.top; cRect.width = c.width || stage.width; cRect.height = c.height || stage.height;
    for (const r of regions) {
      if (!r.visible || !r.enabled) continue;
      if (r.spec.full) { r.rect.x = 0; r.rect.y = 0; r.rect.w = stage.width; r.rect.h = stage.height; }
      else {
        const b = r.el.getBoundingClientRect();
        r.rect.x = b.left - cRect.left; r.rect.y = b.top - cRect.top; r.rect.w = b.width; r.rect.h = b.height;
      }
      if (r.rect.w !== r.lastW || r.rect.h !== r.lastH) {
        r.lastW = r.rect.w; r.lastH = r.rect.h;
        for (const m of r.lineMaterials) { try { m.resolution.set(Math.max(1, r.rect.w), Math.max(1, r.rect.h)); } catch { /* noop */ } }
        if (r.spec.onResize) { try { r.spec.onResize(r.rect.w, r.rect.h, r); } catch (err) { console.warn('[gl] onResize', err); } }
      }
    }
    rectsDirty = false;
  };

  /* ---- postprocessing (HIGH, desktop) */
  const setupPost = async () => {
    if (postLoading || post || !stage.quality.bloom) return; postLoading = true;
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js'),
      ]);
      if (disposed) return;
      const w = stage.width, h = stage.height;
      const rt = new THREE.WebGLRenderTarget(Math.round(w * stage.dpr), Math.round(h * stage.dpr), { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(renderer, rt);
      composer.setPixelRatio(stage.dpr); composer.setSize(w, h);
      const rp = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
      const bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.3, 0.5, 0.86);
      const out = new OutputPass();
      composer.addPass(rp); composer.addPass(bloom); composer.addPass(out);
      post = { composer, rp, bloom, out };
    } catch (err) { console.warn('[gl] bloom unavailable', err); stage.quality.bloom = false; }
  };

  /* ---- quality ladder (never steps back up) */
  const stepDown = () => {
    const q = stage.quality;
    if (q.step === 0 && stage.dpr > 1.0) { stage.dpr = Math.max(1.0, stage.dpr - 0.25); renderer.setPixelRatio(stage.dpr); stage.width = 0; resize(); }
    else if (q.step <= 1 && q.bloom) { q.bloom = false; }
    else if (q.step <= 2 && q.stars > 0.5) { q.stars = 0.5; }
    else if (q.step <= 3 && q.clouds) { q.clouds = false; }
    q.step = Math.min(4, q.step + 1);
    stage.emit('quality', { ...q, dpr: stage.dpr });
  };

  /* ---- render one frame */
  const renderRegion = (r, dt) => {
    const { scene, camera } = r;
    if (!scene || !camera) return;
    const w = Math.max(1, r.rect.w), h = Math.max(1, r.rect.h);
    if (camera.isPerspectiveCamera && Math.abs(camera.aspect - w / h) > 1e-4) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    // pointer relative to the region
    const p = stage.pointer;
    let px = 0, py = 0, inside = false;
    if (p.has) {
      const lx = p.x - cRect.left - r.rect.x, ly = p.y - cRect.top - r.rect.y;
      inside = lx >= 0 && ly >= 0 && lx <= w && ly <= h;
      px = clamp((lx / w) * 2 - 1, -1.5, 1.5); py = clamp(-((ly / h) * 2 - 1), -1.5, 1.5);
    }
    r.hover = inside && !stage.isTouch;
    r.active = r.hover || (stage.isTouch && r.ratio >= 0.6);
    const ctx = { dt, t: stage.time, w, h, rect: r.rect, pointer: { x: px, y: py, inside }, hover: r.hover, active: r.active, region: r, stage, exposure: r.exposure };
    if (r.spec.onFrame) r.spec.onFrame(ctx);
    renderer.toneMappingExposure = r.exposure;
    if (r.spec.full) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, stage.width, stage.height);
      if (r.spec.post && stage.quality.bloom && post) {
        post.rp.scene = scene; post.rp.camera = camera;
        try { post.composer.render(dt); return; } catch (err) { console.warn('[gl] composer failed, bloom off', err); stage.quality.bloom = false; }
      }
      renderer.render(scene, camera);
    } else {
      // first paint of a DOM region: data-gl="on" hides its .region__fallback (site.css contract)
      if (!r.painted) { r.painted = true; try { r.el.setAttribute('data-gl', 'on'); } catch { /* noop */ } }
      const x = r.rect.x, y = stage.height - (r.rect.y + h);
      renderer.setScissorTest(true);
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.setClearColor(r.spec.clearColor ?? COLORS.panel, r.spec.clearAlpha ?? 1);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.setScissorTest(false);
      renderer.setClearColor(COLORS.void, 1);
    }
  };

  const frame = now => {
    const dtRaw = Math.min(0.1, Math.max(0.001, (now - lastRender) / 1000));
    const active = now - lastInput < 420;
    const wantFps = active && stage.tier !== 'LOW' ? 60 : 30;
    if (now - lastRender < 1000 / wantFps - 2) return false;
    const dt = lastRender ? dtRaw : 1 / 60;
    lastRender = now; stage.time += dt;
    if (rectsDirty) sampleRects();
    const visible = regions.filter(r => r.visible && r.enabled && r.rect.w > 0 && r.rect.h > 0 && r.rect.x < stage.width && r.rect.y < stage.height && r.rect.x + r.rect.w > 0 && r.rect.y + r.rect.h > 0);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, stage.width, stage.height);
    renderer.setClearColor(COLORS.void, 1);
    renderer.clear(true, true, false);
    visible.sort((a, b) => (b.spec.full ? 1 : 0) - (a.spec.full ? 1 : 0) || a.spec.order - b.spec.order);
    for (const r of visible) renderRegion(r, dt);
    if (!firstFrame && visible.length) {
      firstFrame = true;
      requestAnimationFrame(() => { canvas.style.opacity = '1'; canvas.classList.add('is-ready'); try { document.body.dataset.gl = 'ready'; } catch { /* noop */ } stage.emit('firstframe', { tier }); readyResolve(stage); });
      if (stage.quality.bloom) setupPost();
    }
    // fps + sampler
    frames++; fpsAcc += dt; if (now - fpsT > 1000) { fps = frames / ((now - fpsT) / 1000); frames = 0; fpsT = now; }
    if (wantFps === 60 && active) {
      sampler.acc += dtRaw * 1000; sampler.n++;
      if (sampler.n >= 60) {
        const avg = sampler.acc / sampler.n; sampler.acc = 0; sampler.n = 0;
        if (avg > 22) { if (++sampler.strikes >= 2) { sampler.strikes = 0; if (stage.quality.step < 4) stepDown(); } } else sampler.strikes = 0;
      }
    }
    return true;
  };

  function anyVisible() { return regions.some(r => r.visible && r.enabled); }
  function tick(now) {
    rafId = 0;
    if (!running || disposed) return;
    try { frame(now); }
    catch (err) {
      console.warn('[gl] frame error', err);
      if (++stage.errors > 2) { broken = true; goNone('error'); return; }
    }
    if (!hidden && anyVisible()) rafId = requestAnimationFrame(tick); else running = false;
  }
  stage.errors = 0;
  function wake() { if (!running && !hidden && !disposed && !broken) { running = true; lastTick = performance.now(); rafId = requestAnimationFrame(tick); } }
  stage.wake = wake;
  stage.markDirty = () => { rectsDirty = true; lastInput = performance.now(); wake(); if (stage.warm) stage.warm(); };

  /* ---- events */
  const onScroll = () => { rectsDirty = true; lastInput = performance.now(); wake(); };
  const onPointer = ev => { const p = stage.pointer; p.x = ev.clientX; p.y = ev.clientY; p.nx = (p.x / stage.width) * 2 - 1; p.ny = -((p.y / stage.height) * 2 - 1); p.has = true; lastInput = performance.now(); wake(); };
  const onVis = () => { hidden = document.hidden; if (!hidden) { lastRender = 0; rectsDirty = true; wake(); } };
  const onLost = ev => { ev.preventDefault(); goNone('contextlost'); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  if (!e.isTouch) window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', onVis);
  canvas.addEventListener('webglcontextlost', onLost);
  let ro = null;
  try { ro = new ResizeObserver(() => resize()); ro.observe(canvas); } catch { ro = null; }
  const rectTimer = setInterval(() => { rectsDirty = true; }, 400);

  function goNone(reason) {
    if (stage.tier === 'NONE') return;
    stage.tier = 'NONE'; stage.reason = reason; running = false; if (rafId) cancelAnimationFrame(rafId);
    setBodyTier('NONE');
    for (const r of regions) { if (r.spec && !r.spec.full) { try { r.el.setAttribute('data-gl', 'off'); } catch { /* noop */ } } }
    try { document.querySelectorAll('[data-region][data-gl="on"]').forEach(el => el.setAttribute('data-gl', 'off')); } catch { /* noop */ }
    try { canvas.style.opacity = '0'; setTimeout(() => { try { canvas.remove(); } catch { /* noop */ } }, 300); } catch { /* noop */ }
    stage.emit('tier', { tier: 'NONE', reason });
  }

  /* ---- public: regions */
  stage.register = (el, specOrFactory) => {
    if (!el || disposed) return null;
    const region = {
      el, spec: null, scene: null, camera: null, visible: false, ratio: 0, enabled: true, hover: false, active: false, painted: false,
      rect: { x: 0, y: 0, w: 0, h: 0 }, lastW: -1, lastH: -1, exposure: 1.0, lineMaterials: [],
      setEnabled(v) { region.enabled = !!v; rectsDirty = true; wake(); },
      dispose() { stage.unregister(region); },
    };
    try {
      let spec = typeof specOrFactory === 'function' ? specOrFactory(stage, region) : specOrFactory;
      spec = Object.assign({ full: false, order: 0, post: false, clearColor: COLORS.panel, clearAlpha: 1 }, spec || {});
      region.spec = spec; region.scene = spec.scene; region.camera = spec.camera;
      if (spec.exposure !== undefined) region.exposure = spec.exposure;
      if (spec.lineMaterials) region.lineMaterials.push(...spec.lineMaterials);
      if (!region.scene || !region.camera) throw new Error('region needs scene and camera');
    } catch (err) { console.warn('[gl] register failed', err); return null; }
    regions.push(region);
    scheduleWarm();
    if (io) io.observe(el); else region.visible = true;
    // DOM regions start "off" (fallback visible) and flip to "on" at their first paint; full regions (the
    // viewport backdrop, usually <body>) are never tagged — the page marks its own hero stage.
    if (!region.spec.full) { try { if (el.getAttribute('data-gl') !== 'on') el.setAttribute('data-gl', 'off'); } catch { /* noop */ } }
    rectsDirty = true; wake();
    return region;
  };
  stage.unregister = region => {
    const i = regions.indexOf(region); if (i < 0) return;
    regions.splice(i, 1); if (io) { try { io.unobserve(region.el); } catch { /* noop */ } }
    if (region.spec && !region.spec.full) { try { region.el.setAttribute('data-gl', 'off'); } catch { /* noop */ } }
    if (region.spec && region.spec.dispose) { try { region.spec.dispose(); } catch { /* noop */ } }
  };
  /* ---- shader + texture warm-up.
     Without it every material links its shader program on the first frame it is visible, which blocks the main
     thread for 100–500 ms on many GPUs (the "stutter when a new section scrolls in"). compileAsync uses
     KHR_parallel_shader_compile so the driver compiles in the background; initTexture moves uploads off the
     first visible frame. Re-run (debounced, idle) after anything that adds materials/textures (markDirty). */
  let warmTimer = 0;
  const idleCb = window.requestIdleCallback ? (fn => window.requestIdleCallback(fn, { timeout: 600 })) : (fn => setTimeout(fn, 60));
  const warmed = new WeakSet();
  const warmRegion = r => {
    if (!r.scene || !r.camera || disposed || stage.tier === 'NONE') return Promise.resolve();
    try {
      r.scene.traverse(o => {
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) {
          const texs = [];
          for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.push(v); }
          if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) texs.push(v); }
          for (const t of texs) { if (!warmed.has(t) && t.image && (t.image.width || t.image.data)) { try { renderer.initTexture(t); warmed.add(t); } catch { /* noop */ } } }
        }
      });
      return renderer.compileAsync ? renderer.compileAsync(r.scene, r.camera).catch(() => {}) : Promise.resolve(renderer.compile(r.scene, r.camera));
    } catch (err) { return Promise.resolve(); }
  };
  function scheduleWarm() {
    if (warmTimer || disposed) return;
    warmTimer = setTimeout(() => idleCb(async () => {
      warmTimer = 0;
      // off-screen regions first: visible ones compile on their own frame anyway
      const order = regions.slice().sort((a, b) => (a.visible ? 1 : 0) - (b.visible ? 1 : 0));
      for (const r of order) { await warmRegion(r); }
    }), 250);
  }
  stage.warm = scheduleWarm;

  stage.getEnvironment = () => {
    // PMREM generation costs ~0.4 s of main-thread time; only HIGH (discrete GPU) gets reflections
    if (stage.tier !== 'HIGH') return null;
    if (envTried) return envTex; envTried = true;
    try { const pm = new THREE.PMREMGenerator(renderer); envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
    catch (err) { console.warn('[gl] environment failed', err); envTex = null; }
    return envTex;
  };
  stage.getDebugInfo = () => ({
    tier: stage.tier, gpu, fps: Math.round(fps), dpr: +stage.dpr.toFixed(2), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    regions: regions.filter(r => r.visible && r.enabled).length + '/' + regions.length, bloom: !!(stage.quality.bloom && post), quality: stage.quality.step,
    width: stage.width, height: stage.height, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries,
  });
  stage.dispose = () => {
    disposed = true; running = false; if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', resize); window.removeEventListener('orientationchange', resize);
    window.removeEventListener('pointermove', onPointer); document.removeEventListener('visibilitychange', onVis); canvas.removeEventListener('webglcontextlost', onLost);
    clearInterval(rectTimer); if (ro) ro.disconnect(); if (io) io.disconnect();
    for (const r of [...regions]) { try { disposeObject(r.scene); } catch { /* noop */ } stage.unregister(r); }
    if (post) { try { post.composer.dispose?.(); post.bloom.dispose?.(); } catch { /* noop */ } }
    if (envTex) envTex.dispose();
    try { renderer.dispose(); } catch { /* noop */ }
  };
  window.addEventListener('pagehide', () => { if (!disposed) { running = false; } }, { once: true });

  /* ---- debug readout: feed core.js's #debug panel (SL.debug.set) when it exists, else draw our own box */
  if (opts.debug || qs.get('debug') === '1') {
    try {
      const SLdbg = window.SL && window.SL.debug && typeof window.SL.debug.set === 'function' ? window.SL.debug : null;
      let box = null;
      if (!SLdbg) {
        box = document.createElement('pre');
        box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:1000;margin:0;padding:8px 10px;font:11px/1.5 "JetBrains Mono",ui-monospace,Menlo,monospace;color:#A0A0AE;background:rgba(11,11,16,.9);border:1px solid rgba(255,255,255,.12);border-radius:4px;pointer-events:none;white-space:pre;';
        document.body.appendChild(box);
      }
      const dbgTimer = setInterval(() => {
        if (disposed) { clearInterval(dbgTimer); return; }
        const d = stage.getDebugInfo();
        if (SLdbg) {
          SLdbg.set('tier', `${d.tier} q${d.quality}`); SLdbg.set('dpr', d.dpr); SLdbg.set('glfps', d.fps); SLdbg.set('calls', `${d.calls} / ${d.triangles} tris`);
          SLdbg.set('regions', d.regions); SLdbg.set('textures', `${d.textures} tex · ${d.geometries} geo`); SLdbg.set('bloom', d.bloom ? 'on' : 'off'); SLdbg.set('gpu', (d.gpu || '').slice(0, 32));
        } else if (box) {
          box.textContent = `TIER ${d.tier}  FPS ${d.fps}  DPR ${d.dpr}\nCALLS ${d.calls}  TRIS ${d.triangles}\nREGIONS ${d.regions}  BLOOM ${d.bloom ? 'ON' : 'OFF'}  Q${d.quality}\nTEX ${d.textures}  GEO ${d.geometries}  ${d.width}x${d.height}\n${(d.gpu || '').slice(0, 44)}`;
        }
      }, 250);
    } catch { /* noop */ }
  }

  queueMicrotask(() => stage.emit('tier', { tier, gpu, dpr: stage.dpr }));
  return stage;
}

/* ================================================================== TEXTURES */
const texCache = new Map();
/** load a planet texture: local assets/textures first, jsdelivr gh mirror as fallback (2048 names only) */
export function loadTexture(file, { cdnFile = null, srgb = true, anisotropy = 4 } = {}) {
  const key = file + (srgb ? ':s' : ':l');
  if (texCache.has(key)) return texCache.get(key);
  const p = new Promise(resolve => {
    const loader = new THREE.TextureLoader();
    const done = t => { t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = anisotropy; t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; resolve(t); };
    loader.load(TEXTURE_BASE + file, done, undefined, () => {
      if (!cdnFile) return resolve(null);
      loader.load(TEXTURE_CDN + cdnFile, done, undefined, () => resolve(null));
    });
  });
  texCache.set(key, p);
  return p;
}

export function radialTexture(size = 256, stops = [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ================================================================== EARTH */
const EARTH_VERT = /* glsl */`
varying vec3 vWorldNormal; varying vec3 vViewDir; varying vec2 vUv;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewDir = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const EARTH_FRAG = /* glsl */`
uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uSpec;
uniform vec3 uSunDir, uSunColor, uNightTint, uAtmos, uAtmosDeep, uBase, uRaised;
uniform float uHasDay, uHasNight, uHasSpec, uTime, uNightBoost;
varying vec3 vWorldNormal; varying vec3 vViewDir; varying vec2 vUv;
void main(){
  vec3 n = normalize(vWorldNormal); vec3 v = normalize(vViewDir);
  float l = dot(n, uSunDir);
  vec3 dayTex;
  if (uHasDay > 0.5) { dayTex = texture2D(uDay, vUv).rgb; }
  else {
    dayTex = mix(uBase, uRaised, 0.5 + 0.5 * n.y);
    float la = abs(fract(vUv.y * 12.0) * 2.0 - 1.0); float lo = abs(fract(vUv.x * 24.0) * 2.0 - 1.0);
    float grid = max(smoothstep(0.93, 1.0, la), smoothstep(0.93, 1.0, lo));
    dayTex += grid * 0.05;
  }
  vec3 night = uHasNight > 0.5 ? texture2D(uNight, vUv).rgb * uNightTint * 1.6 * uNightBoost : vec3(0.0);
  night += dayTex * 0.02;
  vec3 day = dayTex * max(l, 0.0);
  float term = smoothstep(-0.15, 0.25, l);
  vec3 col = mix(night, day, term);
  float ocean = uHasSpec > 0.5 ? texture2D(uSpec, vUv).r : 0.6;
  vec3 r = reflect(-uSunDir, n);
  col += ocean * pow(max(dot(r, v), 0.0), 24.0) * 0.35 * uSunColor * max(l, 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += rim * uAtmos * 0.35 * clamp(l + 0.4, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const ATMOS_VERT = /* glsl */`
varying vec3 vNormalV; varying vec3 vWorldNormal;
void main(){ vNormalV = normalize(normalMatrix * normal); vWorldNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ATMOS_FRAG = /* glsl */`
uniform vec3 uAtmos, uAtmosDeep, uSunDir; uniform float uReveal, uStrength;
varying vec3 vNormalV; varying vec3 vWorldNormal;
void main(){
  float nd = -dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0));
  float v = pow(clamp(0.62 + nd, 0.0, 1.0), 4.0) * smoothstep(0.0, 0.07, nd);
  float sunFacing = smoothstep(-0.3, 0.6, dot(normalize(vWorldNormal), uSunDir));
  vec3 col = mix(uAtmosDeep, uAtmos, v) * v * (0.35 + 0.65 * sunFacing) * uReveal * uStrength;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** additive Fresnel limb, BackSide sphere */
export function atmosphere({ radius = 1.04, segments = 64, sunDir = SUN_DIR, strength = 1 } = {}) {
  const uniforms = {
    uAtmos: { value: new THREE.Color(COLORS.atmos) }, uAtmosDeep: { value: new THREE.Color(COLORS.atmosDeep) },
    uSunDir: { value: sunDir.clone() }, uReveal: { value: 1 }, uStrength: { value: strength },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: ATMOS_VERT, fragmentShader: ATMOS_FRAG, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, segments), mat);
  mesh.renderOrder = 2; mesh.name = 'atmosphere';
  return { mesh, uniforms, material: mat, setReveal(v) { uniforms.uReveal.value = v; }, setSunDir(v) { uniforms.uSunDir.value.copy(v); } };
}

/**
 * earth(stage, opts) -> { group (tilted), spin (rotating child), mesh, material, uniforms, atmosphere, clouds, update(dt), loadTextures(), ... }
 * Radius 1. Texture set is chosen by tier / touch / width; LOW on <=2 GB stays procedural.
 */
export function earth(stage, opts = {}) {
  const tier = opts.tier || (stage && stage.tier) || 'MID';
  const segs = opts.segments || (tier === 'HIGH' ? 96 : tier === 'MID' ? 64 : 48);
  const sunDir = (opts.sunDir || SUN_DIR).clone();
  const group = new THREE.Group(); group.name = 'earthGroup';
  group.rotation.z = -23.4 * DEG;
  const spin = new THREE.Group(); spin.name = 'earthSpin'; group.add(spin);
  spin.rotation.y = opts.spin || 0;
  const uniforms = {
    uDay: { value: null }, uNight: { value: null }, uSpec: { value: null },
    uSunDir: { value: sunDir }, uSunColor: { value: new THREE.Color(COLORS.sun) },
    uNightTint: { value: new THREE.Color(COLORS.earthNight) }, uAtmos: { value: new THREE.Color(COLORS.atmos) },
    uAtmosDeep: { value: new THREE.Color(COLORS.atmosDeep) }, uBase: { value: new THREE.Color(COLORS.atmosDeep) }, uRaised: { value: new THREE.Color(COLORS.panelRaised) },
    uHasDay: { value: 0 }, uHasNight: { value: 0 }, uHasSpec: { value: 0 }, uTime: { value: 0 }, uNightBoost: { value: opts.nightBoost ?? 1 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segs, segs), material); mesh.name = 'earth';
  spin.add(mesh);
  const atmo = atmosphere({ radius: 1.04, segments: Math.min(64, segs), sunDir, strength: opts.atmosStrength ?? 1 });
  group.add(atmo.mesh);

  const api = {
    group, spin, mesh, material, uniforms, atmosphere: atmo, clouds: null, tier,
    spinSpeed: opts.spinSpeed ?? 0.004, sunDir, textures: {}, loaded: false,
    setSunDir(v) { sunDir.copy(v); atmo.setSunDir(v); },
    setReveal(v) { atmo.setReveal(v); },
    update(dt, quality) {
      spin.rotation.y += api.spinSpeed * dt;
      uniforms.uTime.value += dt;
      if (api.clouds) { api.clouds.rotation.y += api.spinSpeed * 1.15 * dt; api.clouds.visible = !quality || quality.clouds !== false; }
    },
    /** world direction of a lat/lon point right now */
    worldDirOf(lat, lon, out = new THREE.Vector3()) { latLonToLocal(lat, lon, 1, out); spin.updateWorldMatrix(true, false); return out.applyMatrix4(spin.matrixWorld).sub(spin.getWorldPosition(_v0)).normalize(); },
    /** spin.rotation.y needed so that (lat,lon) faces the given world direction */
    spinFor(lat, lon, worldDir) {
      const p = latLonToLocal(lat, lon, 1, _v1);
      group.updateWorldMatrix(true, false);
      const q = group.getWorldQuaternion(_q0).invert();
      const d = _v2.copy(worldDir).normalize().applyQuaternion(q);
      return Math.atan2(d.x, d.z) - Math.atan2(p.x, p.z);
    },
    /** lerp spin toward target angle along the shortest arc */
    spinToward(target, lambda, dt) {
      let diff = ((target - spin.rotation.y + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      spin.rotation.y += diff * (1 - Math.exp(-lambda * dt));
    },
    async loadTextures() {
      if (api.loaded || api.loading) return; api.loading = true;
      try {
        const touchy = (stage && (stage.isTouch || stage.narrow)) || opts.small;
        const lowMem = navigator.deviceMemory !== undefined && navigator.deviceMemory <= 2;
        if (tier === 'LOW' && lowMem) return; // procedural only
        const size = touchy ? 1024 : 2048;
        const aniso = stage && stage.renderer ? Math.min(8, stage.renderer.capabilities.getMaxAnisotropy()) : 4;
        const day = await loadTexture(`earth_atmos_${size}.jpg`, { cdnFile: 'earth_atmos_2048.jpg', srgb: true, anisotropy: aniso });
        if (day) { uniforms.uDay.value = day; uniforms.uHasDay.value = 1; api.textures.day = day; }
        const spec = await loadTexture(`earth_specular_${size}.jpg`, { cdnFile: 'earth_specular_2048.jpg', srgb: false, anisotropy: aniso });
        if (spec) { uniforms.uSpec.value = spec; uniforms.uHasSpec.value = 1; api.textures.spec = spec; }
        // night lights: 735 KB PNG on HIGH desktop, the 40 KB 1024 JPEG everywhere else (the heritage framing needs them)
        const lights = tier === 'HIGH' && !touchy
          ? await loadTexture('earth_lights_2048.png', { cdnFile: 'earth_lights_2048.png', srgb: true, anisotropy: aniso })
          : await loadTexture('earth_lights_1024.jpg', { cdnFile: 'earth_lights_2048.png', srgb: true, anisotropy: aniso });
        if (lights) { uniforms.uNight.value = lights; uniforms.uHasNight.value = 1; api.textures.lights = lights; }
        if (tier === 'HIGH' && opts.clouds !== false) {
          const clouds = await loadTexture('earth_clouds_1024.png', { cdnFile: 'earth_clouds_1024.png', srgb: true, anisotropy: aniso });
          if (clouds) {
            const cm = new THREE.MeshStandardMaterial({ map: clouds, transparent: true, opacity: 0.5, depthWrite: false, roughness: 1, metalness: 0, envMapIntensity: 0 });
            api.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.008, 64, 64), cm); api.clouds.name = 'clouds'; api.clouds.renderOrder = 1;
            api.clouds.rotation.y = spin.rotation.y; group.add(api.clouds); api.textures.clouds = clouds;
          }
        }
        api.loaded = true;
      } catch (err) { console.warn('[gl] earth textures', err); }
      finally { api.loading = false; if (stage) stage.markDirty(); }
    },
    dispose() { disposeObject(group); },
  };
  return api;
}
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q0 = new THREE.Quaternion();

/* ================================================================== STARS */
const STAR_VERT = /* glsl */`
attribute float aSize; attribute float aPhase; attribute vec3 aColor;
uniform float uTime, uPixelRatio, uScale; varying vec3 vColor; varying float vTw;
void main(){ vColor = aColor; vTw = 0.75 + 0.25 * sin(uTime * 0.8 + aPhase);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio * uScale * (130.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv; }`;
const STAR_FRAG = /* glsl */`
varying vec3 vColor; varying float vTw; uniform float uOpacity;
void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.12, d) * vTw * uOpacity; if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
/** stars(count, stage, opts) -> { points, material, update(t, quality), setOpacity, dispose } */
export function stars(count = 3000, stage, { rMin = 60, rMax = 90, seed = 7, sizeScale = 1 } = {}) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const pos = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count), col = new Float32Array(count * 3);
  const cText = new THREE.Color(COLORS.text), cAtm = new THREE.Color(COLORS.atmos), cSun = new THREE.Color(COLORS.sun);
  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = lerp(rMin, rMax, rnd()); const q = Math.sqrt(1 - u * u);
    pos[i * 3] = r * q * Math.cos(th); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * q * Math.sin(th);
    size[i] = lerp(0.6, 2.2, Math.pow(rnd(), 2.2)) * sizeScale; phase[i] = rnd() * Math.PI * 2;
    const k = rnd(); const c = k < 0.85 ? cText : k < 0.95 ? cAtm : cSun;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1)); geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: (stage && stage.dpr) || 1 }, uScale: { value: 1 }, uOpacity: { value: 1 } },
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, material); points.name = 'stars'; points.frustumCulled = false;
  return {
    points, material, count,
    update(t, quality) { material.uniforms.uTime.value = t; if (stage) material.uniforms.uPixelRatio.value = stage.dpr; const n = Math.round(count * ((quality && quality.stars) || 1)); if (geo.drawRange.count !== n) geo.setDrawRange(0, n); },
    setOpacity(o) { material.uniforms.uOpacity.value = o; },
    dispose() { geo.dispose(); material.dispose(); },
  };
}

/* ================================================================== SATELLITE */
/** procedural bus + panels + dish + magenta beacon. satellite(scale, stage) -> { group, beacon, update(t) } */
export function satellite(scale = 0.035, stage) {
  const envMap = stage && stage.getEnvironment ? stage.getEnvironment() : null;
  const g = new THREE.Group(); g.name = 'satellite';
  const busMat = new THREE.MeshStandardMaterial({ color: COLORS.satBus, metalness: 0.85, roughness: 0.3, envMap, envMapIntensity: 0.35 });
  const bus = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1.6), busMat); g.add(bus);
  const panelMat = new THREE.MeshStandardMaterial({ color: COLORS.satPanel, metalness: 0.9, roughness: 0.2, emissive: COLORS.satPanel, emissiveIntensity: 0.3, side: THREE.DoubleSide, envMap, envMapIntensity: 0.35 });
  const panelGeo = new THREE.PlaneGeometry(4.2, 1.2);
  const boomGeo = new THREE.BoxGeometry(0.4, 0.08, 0.08);
  for (const sgn of [-1, 1]) {
    const p = new THREE.Mesh(panelGeo, panelMat); p.position.x = sgn * (0.5 + 0.35 + 2.1); g.add(p);
    const b = new THREE.Mesh(boomGeo, busMat); b.position.x = sgn * 0.7; g.add(b);
  }
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 8, 0, Math.PI * 2, 0, 0.6), new THREE.MeshStandardMaterial({ color: COLORS.satDish, metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide, envMap, envMapIntensity: 0.35 }));
  dish.position.z = -1.05; dish.rotation.x = Math.PI / 2; g.add(dish);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: COLORS.accentHot }));
  beacon.position.y = 0.6; g.add(beacon);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(64, [[0, 'rgba(255,63,198,0.9)'], [0.4, 'rgba(212,18,161,0.35)'], [1, 'rgba(212,18,161,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
  halo.scale.setScalar(0.9); halo.position.y = 0.6; g.add(halo);
  g.scale.setScalar(scale);
  return {
    group: g, beacon, halo, bus,
    update(t) { const ph = (t % 2.4) / 2.4; const s = 1 + 0.6 * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2)); beacon.scale.setScalar(s); halo.scale.setScalar(0.9 * (0.8 + 0.4 * s)); },
    dispose() { disposeObject(g); },
  };
}

/* ================================================================== PLUME */
/** three additive sprites trailing a vehicle speck. plume() -> { group, update(t, headPos, tangent, jitter), setOpacity(o) } */
export function plume({ jitter = true } = {}) {
  const tex = radialTexture(128, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,106,61,0.9)'], [0.6, 'rgba(212,18,161,0.35)'], [1, 'rgba(212,18,161,0)']]);
  const g = new THREE.Group(); g.name = 'plume';
  const defs = [[0.03, 0.9, 0.006], [0.05, 0.5, 0.016], [0.08, 0.2, 0.03]];
  const sprites = defs.map(([s, o, off]) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: o })); sp.userData = { s, o, off }; sp.scale.setScalar(s); g.add(sp); return sp; });
  let fade = 1;
  return {
    group: g, sprites,
    update(t, head, tangent) {
      for (let i = 0; i < sprites.length; i++) {
        const sp = sprites[i]; const { s, o, off } = sp.userData;
        sp.position.copy(head).addScaledVector(tangent, -off);
        const j = jitter ? 1 + 0.08 * Math.sin(t * (17 + i * 5.3) + i) : 1;
        sp.scale.setScalar(s * j); sp.material.opacity = o * fade;
      }
    },
    setOpacity(f) { fade = f; g.visible = f > 0.01; },
    dispose() { disposeObject(g); tex.dispose(); },
  };
}

/* ================================================================== SUN FLARE */
/** occlusion-tested additive sun sprite(s). sunFlare({dir, distance}) -> { group, update(camera, earthCenter, earthRadius, visibility) } */
export function sunFlare({ dir = SUN_DIR, distance = 40, coreScale = 1.6, haloScale = 7 } = {}) {
  const g = new THREE.Group(); g.name = 'sunFlare';
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(256, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,0.95)'], [0.3, 'rgba(255,230,194,0.6)'], [0.6, 'rgba(255,230,194,0.12)'], [1, 'rgba(255,230,194,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(256, [[0, 'rgba(255,230,194,0.35)'], [0.35, 'rgba(255,200,160,0.12)'], [1, 'rgba(255,230,194,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
  core.scale.setScalar(coreScale); halo.scale.setScalar(haloScale);
  g.add(halo, core); g.position.copy(dir).multiplyScalar(distance);
  core.renderOrder = halo.renderOrder = 10;
  const toSun = new THREE.Vector3(), toEarth = new THREE.Vector3(), fwd = new THREE.Vector3();
  return {
    group: g, core, halo,
    update(camera, earthCenter = _origin, earthRadius = 1, visibility = 1) {
      toSun.copy(g.position).sub(camera.position).normalize();
      toEarth.copy(earthCenter).sub(camera.position); const d = toEarth.length(); toEarth.divideScalar(d);
      const angR = Math.asin(Math.min(1, earthRadius / d));
      const ang = Math.acos(clamp(toSun.dot(toEarth), -1, 1));
      const occl = 1 - smoothstep(angR - 1 * DEG, angR + 1 * DEG, ang);
      camera.getWorldDirection(fwd);
      const off = Math.acos(clamp(fwd.dot(toSun), -1, 1));
      const half = (camera.fov * DEG) / 2 * Math.sqrt(1 + camera.aspect * camera.aspect);
      const inFrame = smoothstep(half + 25 * DEG, half + 4 * DEG, off);
      const o = clamp(visibility * (1 - occl) * inFrame);
      core.material.opacity = o; halo.material.opacity = o * 0.9; g.visible = o > 0.002;
      return o;
    },
    dispose() { disposeObject(g); },
  };
}
const _origin = new THREE.Vector3();

/* ================================================================== FAT LINES */
function flattenPoints(points, closed = false) {
  const out = [];
  for (const p of points) out.push(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]);
  if (closed && points.length) { const p = points[0]; out.push(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]); }
  return out;
}
function pathLength(flat) { let L = 0; for (let i = 3; i < flat.length; i += 3) L += Math.hypot(flat[i] - flat[i - 3], flat[i + 1] - flat[i - 2], flat[i + 2] - flat[i - 1]); return L; }
function patchDraw(mat) {
  mat.uniforms.uDraw = { value: 1e9 };
  mat.fragmentShader = mat.fragmentShader
    .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uDraw;')
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n#ifdef USE_DASH\nif ( vLineDistance > uDraw ) discard;\n#endif');
}
/**
 * fatLine(points, opts) -> { object, material, isFat, length, setDraw(t 0..1), setPoints(points), setOpacity, setColor, dispose }
 * Line2/LineMaterial (resolution upkeep by the stage through region.lineMaterials). opts.low -> THREE.Line fallback.
 * draw-on uses an injected uDraw cutoff (keeps the dash pattern intact), not setDrawRange.
 */
export function fatLine(points, opts = {}) {
  const { color = COLORS.lineStrong, width = 1.2, opacity = 1, dashed = false, dashSize = 0.06, gapSize = 0.03, draw = false, blending = THREE.NormalBlending, depthWrite = true, depthTest = true, low = false, closed = false } = opts;
  const flat = flattenPoints(points, closed);
  const length = pathLength(flat);
  if (low) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize, gapSize, transparent: true, opacity, depthWrite, depthTest, blending }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite, depthTest, blending });
    const line = new THREE.Line(geo, mat); if (dashed) line.computeLineDistances();
    const n = flat.length / 3;
    return {
      object: line, material: mat, isFat: false, length,
      setDraw(t) { geo.setDrawRange(0, Math.max(0, Math.round(n * clamp(t)))); },
      setPoints(pts) { const f = flattenPoints(pts, closed); if (f.length === geo.attributes.position.array.length) { geo.attributes.position.array.set(f); geo.attributes.position.needsUpdate = true; } else { geo.setAttribute('position', new THREE.Float32BufferAttribute(f, 3)); } if (dashed) line.computeLineDistances(); },
      setOpacity(o) { mat.opacity = o; line.visible = o > 0.002; }, setColor(c) { mat.color.set(c); },
      dispose() { geo.dispose(); mat.dispose(); },
    };
  }
  const geo = new LineGeometry(); geo.setPositions(flat);
  const needDash = dashed || draw;
  const mat = new LineMaterial({ color, linewidth: width, dashed: needDash, dashSize: dashed ? dashSize : 1e6, gapSize: dashed ? gapSize : 0, transparent: true, opacity, depthWrite, depthTest, blending, alphaToCoverage: false });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  if (draw) patchDraw(mat);
  const line = new Line2(geo, mat); if (needDash) line.computeLineDistances();
  line.frustumCulled = false;
  const api = {
    object: line, material: mat, isFat: true, length,
    setDraw(t) { if (mat.uniforms.uDraw) mat.uniforms.uDraw.value = length * clamp(t); },
    setPoints(pts) {
      const f = flattenPoints(pts, closed);
      const seg = new Float32Array(2 * f.length - 6);
      for (let i = 0; i < f.length - 3; i += 3) { seg.set(f.slice(i, i + 6), i * 2); }
      const buf = geo.attributes.instanceStart && geo.attributes.instanceStart.data;
      if (buf && buf.array.length === seg.length) { buf.array.set(seg); buf.needsUpdate = true; } else { geo.setPositions(f); }
      api.length = pathLength(f); if (needDash) line.computeLineDistances();
    },
    setOpacity(o) { mat.opacity = o; line.visible = o > 0.002; }, setColor(c) { mat.color.set(c); },
    dispose() { geo.dispose(); mat.dispose(); },
  };
  return api;
}

/**
 * orbitRing(radius, opts) -> fatLine api + { normal, e1, e2, pointAt(theta, out) }
 * Defined by a plane normal and a start direction (in-plane), or by inclination/raan degrees.
 */
export function orbitRing(radius = 1.42, opts = {}) {
  const { segments = 256, inclination = 52, raan = 0 } = opts;
  let normal, e1;
  if (opts.normal && opts.start) { normal = opts.normal.clone().normalize(); e1 = opts.start.clone().projectOnPlane(normal).normalize(); }
  else { normal = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), inclination * DEG).applyAxisAngle(new THREE.Vector3(0, 1, 0), raan * DEG); e1 = new THREE.Vector3(1, 0, 0).projectOnPlane(normal).normalize(); }
  const e2 = new THREE.Vector3().crossVectors(normal, e1).normalize();
  const pointAt = (theta, out = new THREE.Vector3()) => out.copy(e1).multiplyScalar(Math.cos(theta) * radius).addScaledVector(e2, Math.sin(theta) * radius);
  const pts = []; for (let i = 0; i <= segments; i++) pts.push(pointAt((i / segments) * Math.PI * 2));
  const line = fatLine(pts, { color: COLORS.accent, width: 1.5, ...opts });
  return Object.assign(line, { normal, e1, e2, radius, pointAt });
}

/* ================================================================== RIBBON */
/**
 * ribbon(points, opts) -> { group, curve, tube, twin, uniforms, setProgress(p), getPoint(t), getTangent(t), dispose }
 * Emissive TubeGeometry that draws itself (uProgress discard on uv.x) plus an additive twin tube (bloom stand-in).
 */
export function ribbon(points, opts = {}) {
  const { radius = 0.0045, segments = 220, radial = 8, color = COLORS.accentDeep, emissive = COLORS.accent, emissiveIntensity = 2.4, twin = true, twinRadius = 0.018, twinOpacity = 0.08, closed = false, tension = 0.5, progress = 0 } = opts;
  const vecs = points.map(p => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
  const curve = new THREE.CatmullRomCurve3(vecs, closed, 'centripetal', tension);
  const uniforms = { uProgress: { value: progress } };
  const inject = mat => {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uProgress = uniforms.uProgress;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vRibbonU;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRibbonU = uv.x;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uProgress; varying float vRibbonU;').replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( vRibbonU > uProgress ) discard;');
    };
    mat.customProgramCacheKey = () => 'sl-ribbon-' + mat.type;
    return mat;
  };
  const group = new THREE.Group(); group.name = 'ribbon';
  const tubeMat = inject(new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity, roughness: 0.35, metalness: 0.1 }));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, radial, closed), tubeMat); tube.frustumCulled = false; group.add(tube);
  let twinMesh = null;
  if (twin) {
    const twinMat = inject(new THREE.MeshBasicMaterial({ color: emissive, transparent: true, opacity: twinOpacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    twinMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(segments, 200), twinRadius, radial, closed), twinMat); twinMesh.frustumCulled = false; twinMesh.renderOrder = 1; group.add(twinMesh);
  }
  return {
    group, curve, tube, twin: twinMesh, uniforms, material: tubeMat,
    get progress() { return uniforms.uProgress.value; },
    setProgress(p) { uniforms.uProgress.value = clamp(p); },
    getPoint(t, out) { return curve.getPointAt(clamp(t), out); },
    getTangent(t, out) { return curve.getTangentAt(clamp(t), out); },
    dispose() { disposeObject(group); },
  };
}

/* ================================================================== SMALL HELPERS */
/** wire grid in the XZ plane (GridHelper with hairline colour) */
export function wireGrid(size = 2, divisions = 12, { color = COLORS.line, opacity = 1 } = {}) {
  const g = new THREE.GridHelper(size, divisions, color, color);
  g.material.transparent = opacity < 1; g.material.opacity = opacity; g.material.depthWrite = false;
  return g;
}
/** wireframe box (EdgesGeometry) */
export function wireBox(w = 1, h = 1, d = 1, { color = COLORS.line, opacity = 1 } = {}) {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
/** CSS px position of an object for DOM tags: projectLabel(obj, camera, region, el) -> {x, y, visible}
 *  x/y/visible are the true projection; the tag itself is clamped so its whole box stays inside the region
 *  (and clear of the fixed .chapnav column on desktop), so labels never clip at the viewport edge. */
let _chapnavEl;
export function projectLabel(obj, camera, region, el) {
  obj.getWorldPosition(_v0); _v0.project(camera);
  const rw = region.rect.w, rh = region.rect.h;
  const x = (_v0.x * 0.5 + 0.5) * rw, y = (-_v0.y * 0.5 + 0.5) * rh;
  const visible = _v0.z < 1 && x >= 0 && y >= 0 && x <= rw && y <= rh;
  // the tag is centred on the projected point (site.css .region__tag: absolute, left/top 0, opacity 0 until projected)
  if (el) {
    // measure only when the text or the region size changes (avoids per-frame layout reads)
    if (el._lblTxt !== el.textContent || el._lblRw !== rw) { el._lblTxt = el.textContent; el._lblRw = rw; el._lblW = el.offsetWidth; el._lblH = el.offsetHeight; }
    if (_chapnavEl === undefined) _chapnavEl = document.querySelector('.chapnav');
    const pad = 12;
    const rightInset = _chapnavEl && innerWidth >= 1024 ? Math.max(0, region.rect.x + rw - (innerWidth - 64)) : 0;
    const hw = el._lblW / 2, hh = el._lblH / 2;
    const cx = rw - rightInset - 2 * pad > el._lblW ? clamp(x, pad + hw, rw - rightInset - pad - hw) : x;
    const cy = rh - 2 * pad > el._lblH ? clamp(y, pad + hh, rh - pad - hh) : y;
    el.style.transform = `translate(calc(${cx.toFixed(1)}px - 50%), calc(${cy.toFixed(1)}px - 50%))`;
    el.style.opacity = visible ? '1' : '0';
  }
  return { x, y, visible };
}

/* ================================================================== SCROLL + POINTER HELPERS */
/**
 * bindScrub(el, {smooth}) : progress 0..1 across a tall sticky-stage element
 * 0 when el.top reaches viewport top, 1 when el.bottom reaches viewport bottom. Smoothed toward the target
 * on update(dt) (scrub ~0.8 s). Works with native scroll and Lenis (which scrolls the window).
 */
export function bindScrub(el, { smooth = 0.8, onUpdate = null, useCore = true } = {}) {
  let target = 0, value = 0, dead = false, lastRect = null, offCore = null, coreFed = false;
  const measure = () => {
    if (!el) return;
    const r = el.getBoundingClientRect(); const range = r.height - window.innerHeight;
    lastRect = r;
    if (!coreFed) target = range > 1 ? clamp(-r.top / range) : (r.top < 0 ? 1 : 0);
  };
  // Single source of truth with core.js: when the element is a [data-scrub] section that core.js drives
  // (ScrollTrigger scrub 0.8, or its rAF fallback), take that progress so the DOM beats and the camera agree.
  try {
    const SLc = useCore ? window.SL : null;
    if (SLc && typeof SLc.onScrub === 'function' && el && el.hasAttribute('data-scrub')) {
      coreFed = true; smooth = Math.min(smooth, 0.25);
      offCore = SLc.onScrub(el, p => { target = clamp(p); });
      target = typeof SLc.progress === 'function' ? clamp(SLc.progress(el)) : 0;
    }
  } catch { coreFed = false; }
  measure(); value = target;
  window.addEventListener('scroll', measure, { passive: true }); window.addEventListener('resize', measure);
  return {
    get target() { return target; }, get progress() { return value; }, get rect() { return lastRect; }, get fromCore() { return coreFed; },
    update(dt) { if (dead) return value; const k = 1 - Math.exp(-dt * (4 / smooth)); value += (target - value) * k; if (Math.abs(target - value) < 1e-4) value = target; if (onUpdate) onUpdate(value); return value; },
    jump() { measure(); value = target; return value; }, measure,
    kill() { dead = true; if (offCore) { try { offCore(); } catch { /* noop */ } } window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); },
  };
}

/** pointerParallax(opts) -> { update(dt, t, scale) -> {yaw, pitch}, dispose } ; touch -> 6 s sinusoidal drift */
export function pointerParallax({ yaw = 0.035, pitch = 0.025, lerpPerFrame = 0.045, touch = false, driftPeriod = 6 } = {}) {
  let tx = 0, ty = 0, x = 0, y = 0;
  const onMove = ev => { tx = clamp((ev.clientX / window.innerWidth) * 2 - 1, -1, 1); ty = clamp(-((ev.clientY / window.innerHeight) * 2 - 1), -1, 1); };
  if (!touch) window.addEventListener('pointermove', onMove, { passive: true });
  const out = { yaw: 0, pitch: 0 };
  return {
    update(dt, t, scale = 1) {
      if (touch) { const w = (Math.PI * 2) / driftPeriod; tx = Math.sin(t * w); ty = Math.cos(t * w * 0.8) * 0.8; }
      const k = Math.min(1, lerpPerFrame * Math.min(2.5, dt * 60));
      x += (tx - x) * k; y += (ty - y) * k;
      out.yaw = x * yaw * scale; out.pitch = y * pitch * scale; return out;
    },
    dispose() { window.removeEventListener('pointermove', onMove); },
  };
}

/**
 * cameraRig(camera) : apply (pos, target, fov) plus yaw/pitch parallax around the target and an idle drift.
 */
export function cameraRig(camera) {
  const pos = new THREE.Vector3(), tgt = new THREE.Vector3(), rel = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  return {
    apply(p, t, fov, yaw = 0, pitch = 0, drift = null) {
      pos.copy(p); tgt.copy(t);
      if (drift) pos.add(drift);
      rel.copy(pos).sub(tgt);
      if (yaw) rel.applyAxisAngle(up, yaw);
      if (pitch) { right.crossVectors(rel, up).normalize(); rel.applyAxisAngle(right, pitch); }
      camera.position.copy(tgt).add(rel);
      camera.lookAt(tgt);
      if (fov && Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },
  };
}

export { THREE };
