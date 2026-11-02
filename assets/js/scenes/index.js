/*
 * SpaceLabs — scenes/index.js : FIRST LIGHT CORRIDOR (hero), the two lit product panels
 * (ASTRA trajectory fan, SARAS gimbal rings), the heritage night framing, and mountAmbient()
 * for subpage title blocks. Built only from gl.js factories; all entry points fail soft.
 */
import {
  THREE, COLORS, SUN_DIR, DEG, clamp, lerp, smoothstep, remap, damp, ease,
  earth as makeEarth, stars as makeStars, satellite as makeSatellite, plume as makePlume, sunFlare, ribbon as makeRibbon,
  orbitRing, fatLine, wireGrid, bindScrub, pointerParallax, cameraRig, disposeObject,
} from '../gl.js';

const Y_UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();

/* ------------------------------------------------------------------ camera keys (sun-relative framing) */
/** camera key from a described framing: where the sun and the Earth centre sit in the frame */
function beatKey({ dist, sunYaw, sunPitch, earthPitch, earthYaw = 0, fov }) {
  const f = SUN_DIR.clone().applyAxisAngle(Y_UP, sunYaw * DEG);
  const r = new THREE.Vector3().crossVectors(f, Y_UP).normalize();
  f.applyAxisAngle(r, -sunPitch * DEG).normalize();
  r.crossVectors(f, Y_UP).normalize();
  const e = f.clone().applyAxisAngle(r, -earthPitch * DEG).applyAxisAngle(Y_UP, -earthYaw * DEG).normalize();
  const pos = e.clone().multiplyScalar(-dist);
  const target = pos.clone().addScaledVector(f, dist);
  return { pos, target, fov, f, e, dist };
}
const KEYS_LANDSCAPE = [
  { dist: 3.0, sunYaw: 15, sunPitch: 3, earthPitch: 15.5, earthYaw: 4, fov: 32 },   // A Horizon: sunrise cresting the limb, Earth fills the lower ~56 %
  { dist: 4.3, sunYaw: 30, sunPitch: 11, earthPitch: 7, earthYaw: -6, fov: 32 },    // B Ascent
  { dist: 5.8, sunYaw: 50, sunPitch: 18, earthPitch: 0.5, earthYaw: 1, fov: 30 },   // C Insertion: whole orbit in frame
  { dist: 7.8, sunYaw: 62, sunPitch: 22, earthPitch: -1, earthYaw: -14, fov: 28 },  // D Wide: Earth in the left third
];
const KEYS_PORTRAIT = [ // narrow horizontal fov: launch site stays in frame lower-left, sun crests at the right edge
  { dist: 4.0, sunYaw: 10, sunPitch: 3, earthPitch: 13, earthYaw: 7, fov: 44 },
  { dist: 5.0, sunYaw: 30, sunPitch: 12, earthPitch: 7, earthYaw: 2, fov: 44 },
  { dist: 6.6, sunYaw: 48, sunPitch: 18, earthPitch: 0, earthYaw: 1, fov: 42 },
  { dist: 8.6, sunYaw: 60, sunPitch: 22, earthPitch: -7, earthYaw: 0, fov: 40 },
];
const STOPS = [0, 0.38, 0.72, 1.0];

/* ------------------------------------------------------------------ ribbon + orbit geometry (world space, Earth at origin) */
function ribbonLayout() {
  const A = beatKey(KEYS_LANDSCAPE[0]);
  const eHat = A.pos.clone().normalize();                  // Earth -> camera
  const a0 = new THREE.Vector3().crossVectors(A.f, Y_UP).normalize().projectOnPlane(eHat).normalize(); // screen-right on the limb circle
  const b0 = new THREE.Vector3().crossVectors(eHat, a0);   // screen-up
  const d = A.dist;
  const limb = alpha => eHat.clone().multiplyScalar(1 / d).add(a0.clone().multiplyScalar(Math.cos(alpha)).addScaledVector(b0, Math.sin(alpha)).multiplyScalar(Math.sqrt(1 - 1 / (d * d))));
  const L = limb(165 * DEG).addScaledVector(eHat, 0.10).normalize();                  // launch site: left limb, just in front of it
  const Pdir = eHat.clone().multiplyScalar(0.53).addScaledVector(a0, 0.53).addScaledVector(b0, 0.67).normalize();
  const R = 1.42, P = Pdir.clone().multiplyScalar(R);                                // insertion point, upper right
  // orbit plane through P at 52 deg inclination; pick the normal whose prograde tangent best matches the ribbon direction
  const incl = 52 * DEG, ny = Math.cos(incl), rr = Math.sin(incl);
  const A1 = rr * P.x, B1 = rr * P.z, K = -ny * P.y, Rr = Math.hypot(A1, B1), delta = Math.atan2(A1, B1);
  const as = Math.asin(clamp(K / Rr, -1, 1));
  const ribbonDir = Pdir.clone().sub(L).normalize();
  let best = null;
  for (const psi of [as - delta, Math.PI - as - delta]) for (const sgn of [1, -1]) {
    const nn = new THREE.Vector3(rr * Math.cos(psi), ny, rr * Math.sin(psi)).multiplyScalar(sgn);
    const t = new THREE.Vector3().crossVectors(nn, Pdir);
    const score = t.dot(ribbonDir);
    if (!best || score > best.score) best = { nn, t, score };
  }
  const slerp = (a, b, s) => { const w = Math.acos(clamp(a.dot(b), -1, 1)), sa = Math.sin(w); return a.clone().multiplyScalar(Math.sin((1 - s) * w) / sa).addScaledVector(b, Math.sin(s * w) / sa).normalize(); };
  const pts = [];
  for (const s of [0, 0.06, 0.18, 0.36, 0.56, 0.76]) pts.push(slerp(L, Pdir, s).multiplyScalar(s === 0 ? 1.0 : 1 + 0.42 * (1 - Math.pow(1 - s, 1.6))));
  pts.push(P.clone().addScaledVector(best.t, -0.22));
  pts.push(P);
  return { L, P, Pdir, normal: best.nn, tangent: best.t, points: pts, radius: R };
}

/* ================================================================== INDEX */
/**
 * mountIndex(stage, { heroEl, productEls, heritageEl, readoutEl, backdropEl, onProgress })
 *  heroEl      the 300svh hero section (scroll driver; the stage inside it is CSS sticky)
 *  productEls  [astraEl, sarasEl] transparent panel rectangles (data-region="panel-astra" | "panel-saras")
 *  heritageEl  the heritage chapter (night framing while it is centred)
 *  readoutEl   optional element receiving the SIM readout text
 *  backdropEl  element whose intersection gates the full-viewport render (default: document.body)
 * Returns { hero, panels, progress, dispose } or null when the stage has no WebGL.
 */
export function mountIndex(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  try { return mountIndexUnsafe(stage, opts); }
  catch (err) { console.warn('[scenes/index] mount failed', err); return null; }
}

function mountIndexUnsafe(stage, { heroEl, productEls = [], heritageEl = null, readoutEl = null, backdropEl = null, onProgress = null }) {
  const tier = stage.tier, low = tier === 'LOW';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(stage.portrait ? 44 : 32, 1, 0.05, 300);
  const sun = new THREE.DirectionalLight(COLORS.sun, 2.6); sun.position.copy(SUN_DIR).multiplyScalar(10); scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.18));

  const earth = makeEarth(stage); earth.spinSpeed = 0; scene.add(earth.group);
  const stars = makeStars(tier === 'HIGH' ? 6000 : tier === 'MID' ? 3000 : 1500, stage); scene.add(stars.points);
  const flare = sunFlare(); scene.add(flare.group);

  // ribbon / orbit / vehicle live in the spin group so they stay attached to the planet
  const lay = ribbonLayout();
  earth.group.updateMatrixWorld(true);
  const toLocal = v => earth.spin.worldToLocal(v.clone());
  const invQ = earth.spin.getWorldQuaternion(new THREE.Quaternion()).invert();
  const ribbon = makeRibbon(lay.points.map(toLocal), { radius: 0.0045, segments: tier === 'HIGH' ? 400 : tier === 'MID' ? 220 : 120, twin: !low, progress: 0 });
  earth.spin.add(ribbon.group);
  // the ribbon fades out once the hero has scrolled away (ambient Earth behind later chapters must never cross text)
  ribbon.material.transparent = true;
  const ribbonTwinOpacity = ribbon.twin ? ribbon.twin.material.opacity : 0, ribbonEmissive = ribbon.material.emissiveIntensity;
  const nLocal = lay.normal.clone().applyQuaternion(invQ), pLocal = toLocal(lay.P);
  const orbit = orbitRing(lay.radius, { normal: nLocal, start: pLocal, dashed: true, dashSize: 0.06, gapSize: 0.03, draw: true, width: 1.5, color: COLORS.accent, opacity: 0, low, depthWrite: false });
  const guide = orbitRing(lay.radius, { normal: nLocal, start: pLocal, width: 1.2, color: COLORS.lineStrong, opacity: 0, low, depthWrite: false });
  orbit.setDraw(0); orbit.object.visible = false; guide.object.visible = false;
  earth.spin.add(orbit.object, guide.object);
  const speck = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), new THREE.MeshBasicMaterial({ color: 0xFFFFFF })); earth.spin.add(speck);
  const plume = makePlume({ jitter: !low }); earth.spin.add(plume.group);
  const sat = makeSatellite(0.035, stage); sat.group.visible = false; earth.spin.add(sat.group);

  const rig = cameraRig(camera);
  const parallax = pointerParallax({ touch: stage.isTouch });
  const scrub = heroEl ? bindScrub(heroEl, { smooth: 0.8 }) : null;

  let keys = [], posCurve = null, tgtCurve = null;
  const heritagePos = new THREE.Vector3(), heritageDir = new THREE.Vector3();
  const buildKeys = () => {
    keys = (stage.portrait ? KEYS_PORTRAIT : KEYS_LANDSCAPE).map(beatKey);
    posCurve = new THREE.CatmullRomCurve3(keys.map(k => k.pos), false, 'centripetal');
    tgtCurve = new THREE.CatmullRomCurve3(keys.map(k => k.target), false, 'centripetal');
    // heritage: park on the night side (anti-sun azimuth) at the elevation where 8.5N 77E faces the camera once the
    // planet has swung round, so the subcontinent sits at the frame centre; far enough that the dusk rim stays in frame
    const saved = earth.spin.rotation.y;
    earth.spin.rotation.y = earth.spinFor(8.5, 77, SUN_DIR.clone().negate());
    earth.worldDirOf(8.5, 77, heritageDir);
    earth.spin.rotation.y = saved;
    heritagePos.copy(heritageDir).multiplyScalar(stage.portrait ? 5.6 : 3.0);
  };
  buildKeys();
  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), drift = new THREE.Vector3(), head = new THREE.Vector3(), tangent = new THREE.Vector3(), tmp = new THREE.Vector3();

  // visibility of the hero / heritage chapters
  let heroVisible = true, heritageVisible = false, io = null;
  try {
    io = new IntersectionObserver(entries => { for (const en of entries) { if (en.target === heroEl) heroVisible = en.isIntersecting; if (en.target === heritageEl) heritageVisible = en.isIntersecting; } stage.markDirty(); }, { rootMargin: '-22% 0px -22% 0px', threshold: 0 });
    if (heroEl) io.observe(heroEl); if (heritageEl) io.observe(heritageEl);
  } catch { io = null; }

  // intro — core.js stores 'sl-visited' before this module mounts and flags a revisit with html.is-revisit;
  // without core.js (dev harness) read sessionStorage ourselves
  let visited = false;
  try {
    const rootEl = document.documentElement;
    if (window.SL || rootEl.classList.contains('is-core-ready')) visited = rootEl.classList.contains('is-revisit');
    else { visited = sessionStorage.getItem('sl-visited') === '1'; sessionStorage.setItem('sl-visited', '1'); }
  } catch { /* noop */ }
  const introDur = visited ? 0.8 : 2.0;
  let introT = 0, introStart = 0, introDone = false, started = false, disposedFlag = false;
  let heritageBlend = 0, spinIdle = 0, plumeFade = 1, satFade = 0, tBirth = -1, lastReadout = -1, texturesKicked = false;
  const state = { progress: 0, uProgress: 0, exposure: 0, altKm: 0, beat: 0 };

  /* ---- T-0 particle burst (window 'sl:launch' {kind:'egg'} from core.js's LaunchButton): 200 points, 1.2 s, lower-right of the frame */
  let burst = null;
  const spawnBurst = () => {
    try {
      if (burst) { scene.remove(burst.points); burst.dispose(); burst = null; }
      const n = 200, pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
      const nf = camera.near, ff = camera.far, dist = 3.0;
      const zNdc = (ff + nf) / (ff - nf) - (2 * ff * nf) / ((ff - nf) * dist);
      const origin = new THREE.Vector3(0.82, -0.82, zNdc).unproject(camera);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = origin.x; pos[i * 3 + 1] = origin.y; pos[i * 3 + 2] = origin.z;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), s = 0.5 + Math.random() * 1.3;
        vel[i * 3] = Math.sin(ph) * Math.cos(th) * s * 0.45; vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * s + 0.4; vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * s * 0.45;
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color: COLORS.accentHot, size: 0.05, sizeAttenuation: true, transparent: true, opacity: 1, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 20; scene.add(points);
      burst = { points, vel, t0: stage.time, dispose() { geo.dispose(); mat.dispose(); } };
      stage.markDirty();
    } catch (err) { console.warn('[scenes/index] burst', err); }
  };
  const stepBurst = (dt, t) => {
    if (!burst) return;
    const age = t - burst.t0;
    if (age > 1.2) { scene.remove(burst.points); burst.dispose(); burst = null; return; }
    const a = burst.points.geometry.attributes.position, arr = a.array, v = burst.vel;
    for (let i = 0; i < arr.length; i += 3) { v[i + 1] -= 1.6 * dt; arr[i] += v[i] * dt; arr[i + 1] += v[i + 1] * dt; arr[i + 2] += v[i + 2] * dt; }
    a.needsUpdate = true; burst.points.material.opacity = 1 - ease.in3(age / 1.2);
  };
  const onLaunch = e => { if (e && e.detail && e.detail.kind === 'egg') spawnBurst(); };
  window.addEventListener('sl:launch', onLaunch);

  const camAt = (p, outPos, outTgt) => {
    let i = 0; while (i < STOPS.length - 2 && p > STOPS[i + 1]) i++;
    const lt = ease.inOut1(clamp((p - STOPS[i]) / (STOPS[i + 1] - STOPS[i])));
    const u = (i + lt) / (STOPS.length - 1);
    posCurve.getPoint(u, outPos); tgtCurve.getPoint(u, outTgt);
    state.beat = i + lt;
    return lerp(keys[i].fov, keys[i + 1].fov, lt);
  };

  const heroFrame = ctx => {
    const { dt, t } = ctx;
    if (!started) { started = true; introStart = performance.now(); }
    if (!texturesKicked) { texturesKicked = true; setTimeout(() => earth.loadTextures(), 60); }
    const p = scrub ? scrub.update(dt) : 0;
    state.progress = p;
    // intro ramp on the wall clock from the first rendered frame (killed by any scroll)
    if (!introDone) { introT = (performance.now() - introStart) / 1000; if (introT >= introDur || window.scrollY > 24 || (scrub && scrub.target > 0.01)) introDone = true; }
    const introK = introDone ? 1 : ease.out2(clamp(introT / introDur));
    earth.setReveal(introK);
    // camera along the beats + heritage framing
    let fov = camAt(p, camPos, camTgt);
    heritageBlend = damp(heritageBlend, heritageVisible && !heroVisible ? 1 : 0, 1.6, dt);
    const hb = smoothstep(0, 1, heritageBlend);
    if (hb > 0.0005) { camPos.lerp(heritagePos, hb); camTgt.lerp(ORIGIN, hb); fov = lerp(fov, stage.portrait ? 44 : 32, hb); }
    const par = parallax.update(dt, t, (1 - 0.6 * p) * (1 - hb));
    drift.set(Math.sin(t * 0.11) * 0.015, Math.cos(t * 0.09) * 0.012, 0);
    rig.apply(camPos, camTgt, fov, par.yaw, par.pitch, drift);
    stars.points.rotation.set(par.pitch * 0.3, par.yaw * 0.3, 0);
    // exposure: 1.05 -> 0.8 (wide) -> 0.35 (ambient after the hero scrolls out) -> 0.5 (heritage)
    let expo = p < 0.72 ? 1.05 : lerp(1.05, 0.8, (p - 0.72) / 0.28);
    const rect = scrub ? scrub.rect : null;
    const ambient = rect ? clamp((window.innerHeight - rect.bottom) / (0.6 * window.innerHeight)) : (heroVisible ? 0 : 1);
    expo = lerp(expo, 0.35, ambient); expo = lerp(expo, 0.5, hb);
    // hero-only bright line work (ribbon, plume, predicted orbit, guide, sun flare) is gone within the first ~20 %
    // of a viewport after the hero unpins; the ambient Earth behind later chapters stays dim and clean
    const heroK = 1 - smoothstep(0, 0.35, ambient);
    ctx.region.exposure = expo * introK; state.exposure = ctx.region.exposure;
    // Earth spin: slow idle, swung so 8.5N 77E faces the camera while the heritage chapter is centred
    spinIdle += 0.004 * dt;
    let want = spinIdle;
    if (hb > 0.0005) { const target = earth.spinFor(8.5, 77, heritageDir); let diff = ((target - spinIdle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; want = spinIdle + diff * hb; }
    earth.spinToward(want, 3.0, dt);
    earth.update(dt, stage.quality);
    // ribbon draw-on: 0.12 after load, to 1.0 across p 0.05-0.70
    const rp = ease.inOut1(remap(p, 0.05, 0.70));
    const uProgress = lerp(0.12 * introK, 1, rp);
    ribbon.setProgress(uProgress); state.uProgress = uProgress;
    ribbon.group.visible = heroK > 0.004;
    ribbon.material.opacity = heroK; ribbon.material.emissiveIntensity = ribbonEmissive * heroK;
    if (ribbon.twin) ribbon.twin.material.opacity = ribbonTwinOpacity * heroK;
    const born = uProgress >= 0.95;
    plumeFade = damp(plumeFade, born ? 0 : 1, 1 / 0.6 * 3, dt);
    satFade = damp(satFade, born ? 1 : 0, 1 / 0.6 * 3, dt);
    const headT = Math.min(uProgress, 0.9999);
    ribbon.getPoint(headT, head); ribbon.getTangent(headT, tangent);
    speck.position.copy(head); speck.visible = plumeFade > 0.02 && heroK > 0.05; plume.setOpacity(plumeFade * introK * heroK); plume.update(t, head, tangent);
    state.altKm = Math.max(0, (head.length() - 1) * 6371);
    if (satFade * heroK > 0.01) {
      if (tBirth < 0) tBirth = t;
      const th = ((t - tBirth) * Math.PI * 2) / 48;
      orbit.pointAt(th, sat.group.position);
      sat.group.visible = true; sat.group.scale.setScalar(0.035 * satFade * heroK);
      earth.spin.getWorldPosition(tmp); sat.group.lookAt(tmp); sat.update(t);
      state.altKm = (orbit.radius - 1) * 6371;
    } else { sat.group.visible = false; tBirth = -1; }
    // predicted orbit (dashOffset-style draw-on through uDraw) + planned guide
    const od = ease.inOut1(remap(p, 0.62, 0.90)), oo = 0.85 * remap(p, 0.62, 0.72) * introK * heroK;
    orbit.setDraw(od); orbit.setOpacity(oo); orbit.object.visible = oo > 0.002;
    const go = 0.12 * remap(p, 0.5, 0.6) * introK * heroK; guide.setOpacity(go); guide.object.visible = go > 0.002;
    // sun flare with occlusion test, stars twinkle
    flare.update(camera, ORIGIN, 1, introK * (1 - hb) * lerp(0.35, 1, heroK));
    stars.update(t, stage.quality);
    // SIM readout, 10 Hz
    if (readoutEl && t - lastReadout > 0.1) { lastReadout = t; readoutEl.textContent = `ALT ${Math.round(state.altKm).toString().padStart(4, '0')} km · INC 52.0° · TRACK ${Math.round(uProgress * 100).toString().padStart(3, '0')}`; }
    stepBurst(dt, t);
    if (onProgress) onProgress(p, state);
  };

  const backdrop = stage.register(backdropEl || document.body, {
    scene, camera, full: true, post: true, order: 0, exposure: 0,
    lineMaterials: [orbit, guide].filter(l => l.isFat).map(l => l.material),
    onFrame: heroFrame,
    onResize: () => { buildKeys(); },
    dispose: () => { disposeObject(scene); },
  });

  // The hero's sticky stage (.hero__stage[data-region="hero"]) is painted by the full-viewport backdrop, so the
  // stage never tags it: mark it data-gl="on" at the first rendered frame (site.css then cross-fades the poster)
  // and "off" if the stage falls back to tier NONE.
  // The heritage chapter ([data-region="heritage"]) is framed by the same backdrop (night side, 8.5N 77E facing the
  // camera), so its earth-night poster must hide too, or the photo sits on top of the live planet with a hard seam.
  const heroStage = heroEl ? (heroEl.matches('[data-region]') ? heroEl : heroEl.querySelector('[data-region]')) : null;
  const backdropEls = [heroStage, heritageEl && heritageEl.matches('[data-region]') ? heritageEl : null].filter(Boolean);
  const setHeroGl = v => { for (const el of backdropEls) { try { el.setAttribute('data-gl', v); } catch { /* noop */ } } };
  setHeroGl('off');
  const offTier = stage.on('tier', d => { if (d && d.tier === 'NONE') setHeroGl('off'); });
  if (stage.ready && stage.ready.then) stage.ready.then(() => { if (!disposedFlag && stage.tier !== 'NONE') setHeroGl('on'); });

  /* ---- product panels (two) */
  const panels = [];
  productEls.forEach((el, i) => {
    if (!el) return;
    const kind = /saras/i.test(el.dataset.region || el.id || '') ? 'saras' : /astra/i.test(el.dataset.region || el.id || '') ? 'astra' : (i === 0 ? 'astra' : 'saras');
    const pnl = mountPanel(stage, el, kind); if (pnl) panels.push(pnl);
  });

  const api = {
    hero: { scene, camera, earth, ribbon, orbit, guide, satellite: sat, stars, flare, scrub, state, region: backdrop },
    panels, state,
    get progress() { return state.progress; },
    dispose() {
      disposedFlag = true;
      try { window.removeEventListener('sl:launch', onLaunch); offTier(); setHeroGl('off'); } catch { /* noop */ }
      try { if (burst) { scene.remove(burst.points); burst.dispose(); burst = null; } } catch { /* noop */ }
      try { if (io) io.disconnect(); if (scrub) scrub.kill(); parallax.dispose(); } catch { /* noop */ }
      for (const p of panels) p.dispose();
      if (backdrop) stage.unregister(backdrop);
    },
  };
  return api;
}

/* ================================================================== PAGE ENTRY (index.html) */
/**
 * mount(stage, opts) — the index page's scene entry. Resolves its own DOM (#hero, [data-region^="panel-"],
 * #heritage, [data-readout] | #readout) and calls mountIndex; opts override any of those.
 * Convention: every assets/js/scenes/<page>.js exports mount(stage, opts) -> handle | null.
 */
export function mount(stage, opts = {}) {
  const $ = s => document.querySelector(s);
  return mountIndex(stage, {
    heroEl: $('#hero'),
    productEls: [...document.querySelectorAll('[data-region^="panel-"]')],
    heritageEl: $('#heritage'),
    readoutEl: $('[data-readout]') || $('#readout'),
    ...opts,
  });
}

/* ================================================================== PANELS */
function mountPanel(stage, el, kind) {
  try {
    const low = stage.tier === 'LOW';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    const envMap = stage.getEnvironment();
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshPhysicalMaterial({ color: COLORS.panel, metalness: 0.2, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.15, envMap, envMapIntensity: 0.35 }));
    glass.position.z = -0.3; scene.add(glass);
    const rim = new THREE.DirectionalLight(COLORS.sun, 0.6); rim.position.set(1.4, 1.6, 2.2); scene.add(rim, rim.target);
    scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.3));
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0 }));
    outline.position.z = -0.29; scene.add(outline);
    const glyph = kind === 'saras' ? sarasGlyph(stage, low) : astraGlyph(low);
    // the <= 4 deg pointer tilt lives on this GL group, not on the DOM region (site.css applies the CSS tilt only to
    // panels the renderer does not paint, so the scissor rectangle always matches the DOM box)
    const tiltG = new THREE.Group(); tiltG.add(glyph.group); scene.add(tiltG);
    let hoverK = 0, idle = 0, tiltX = 0, tiltY = 0;
    const fit = (w, h) => {
      const aspect = Math.max(0.2, w / Math.max(1, h));
      camera.aspect = aspect; camera.fov = 30; camera.updateProjectionMatrix();
      const dist = (glyph.fitRadius / Math.tan(15 * DEG)) / Math.min(1, aspect) * 1.12;
      camera.position.set(0, 0, dist); camera.lookAt(0, 0, 0);
      const gh = 2 * Math.tan(15 * DEG) * (dist + 0.3), gw = gh * aspect;
      // the DOM text block covers the lower ~45 % of the card: shrink the glyph a little and lift it into the open band
      // above the text by moving the camera (and the glass/outline with it, so they still fill the frame exactly) down,
      // never further than its own extent allows (8 % margin under the top edge)
      const k = aspect < 1.1 ? 0.78 : 0.88; tiltG.scale.setScalar(k);
      const halfH = Math.tan(15 * DEG) * dist, extent = glyph.fitRadius * k;
      const lift = clamp(halfH * 0.92 - extent, 0, 0.22 * gh);
      camera.position.set(0, -lift, dist); camera.lookAt(0, -lift, 0);
      glass.position.y = -lift; outline.position.y = -lift;
      glass.scale.set(gw, gh, 1); outline.scale.set(gw * 0.965, gh * 0.965, 1);
      if (glyph.fit) glyph.fit(aspect);
    };
    const region = stage.register(el, {
      scene, camera, clearColor: COLORS.panel, exposure: 1.0, order: 1,
      lineMaterials: glyph.lineMaterials || [],
      onResize: fit,
      onFrame: ctx => {
        const { dt, t } = ctx;
        hoverK = damp(hoverK, ctx.active ? 1 : 0, ctx.active ? 6 : 3, dt);
        idle += dt;
        const px = ctx.pointer.inside ? ctx.pointer.x : Math.sin(idle * 0.35) * 0.6, py = ctx.pointer.inside ? ctx.pointer.y : 0.5 + Math.cos(idle * 0.27) * 0.3;
        rim.position.set(lerp(rim.position.x, px * 2.6, 0.12), lerp(rim.position.y, py * 2.6, 0.12), 2.0);
        rim.intensity = lerp(0.6, 1.6, hoverK);
        outline.material.opacity = 0.7 * hoverK;
        tiltX = damp(tiltX, ctx.pointer.inside ? -ctx.pointer.y * 0.07 : 0, 6, dt);
        tiltY = damp(tiltY, ctx.pointer.inside ? ctx.pointer.x * 0.07 : 0, 6, dt);
        tiltG.rotation.set(tiltX, tiltY, 0);
        glyph.update(dt, t, hoverK, ctx);
      },
      dispose: () => { disposeObject(scene); glyph.dispose?.(); },
    });
    return { kind, el, region, scene, camera, glyph, dispose() { stage.unregister(region); } };
  } catch (err) { console.warn('[scenes/index] panel failed', kind, err); return null; }
}

/** ASTRA: seven candidate ascent curves + one optimum over a 12x12 wire grid; hover converges the ghosts */
function astraGlyph(low) {
  const group = new THREE.Group(); group.rotation.x = 0.22;
  const grid = wireGrid(2.6, 12, { color: COLORS.line, opacity: 1 }); grid.position.y = -0.62; group.add(grid);
  const L = new THREE.Vector3(-0.58, -0.6, 0.3), O = new THREE.Vector3(0.56, 0.46, -0.42);
  const dir = O.clone().sub(L).normalize(), perp = new THREE.Vector3().crossVectors(dir, Y_UP).normalize();
  const mk = (s, up, side) => L.clone().lerp(O, s).addScaledVector(Y_UP, up).addScaledVector(perp, side);
  const optC = [mk(0.22, 0.34, 0), mk(0.62, 0.30, 0.02)];
  const ghostDefs = [[-0.1, 0.18, 0.05, 0.22], [0.08, -0.14, -0.12, 0.05], [0.26, 0.1, 0.3, -0.08], [-0.2, -0.05, -0.28, 0.1], [0.14, 0.26, 0.12, -0.2], [-0.06, 0.02, 0.2, 0.18], [0.3, -0.1, -0.06, -0.14]];
  const curvePts = (c1, c2) => new THREE.CatmullRomCurve3([L, c1, c2, O], false, 'centripetal').getPoints(48);
  const ghosts = ghostDefs.map(([u1, s1, u2, s2]) => {
    const base = [mk(0.22, 0.14 + u1, s1), mk(0.62, 0.18 + u2, s2)];
    const line = fatLine(curvePts(base[0], base[1]), { color: COLORS.lineStrong, width: 1.2, opacity: 0.9, low });
    group.add(line.object); return { base, line, cur: [base[0].clone(), base[1].clone()] };
  });
  const optimum = fatLine(curvePts(optC[0], optC[1]), { color: COLORS.accentHot, width: 1.8, low });
  const twin = low ? null : fatLine(curvePts(optC[0], optC[1]), { color: COLORS.accent, width: 4, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false });
  group.add(optimum.object); if (twin) group.add(twin.object);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), new THREE.MeshBasicMaterial({ color: COLORS.accentHot })); group.add(marker);
  const optCurve = new THREE.CatmullRomCurve3([L, optC[0], optC[1], O], false, 'centripetal');
  let conv = 0, shown = -1;
  return {
    group, fitRadius: 0.78,
    lineMaterials: [optimum, twin, ...ghosts.map(g => g.line)].filter(l => l && l.isFat).map(l => l.material),
    fit(aspect) { group.scale.setScalar(aspect > 1.2 ? 1.1 : 1); },
    update(dt, t, hoverK) {
      conv = damp(conv, hoverK, 1.2 / 1.2 * 2.2, dt);
      if (Math.abs(conv - shown) > 0.002) {
        shown = conv; const k = ease.inOut2(conv);
        for (const g of ghosts) { g.cur[0].copy(g.base[0]).lerp(optC[0], k); g.cur[1].copy(g.base[1]).lerp(optC[1], k); g.line.setPoints(curvePts(g.cur[0], g.cur[1])); g.line.setOpacity(lerp(0.9, 0.35, k)); }
      }
      optCurve.getPointAt((t * 0.11) % 1, marker.position);
    },
    dispose() { for (const g of ghosts) g.line.dispose(); optimum.dispose(); twin?.dispose(); },
  };
}

/** SARAS: the shared satellite inside three gimbal rings with 72 ticks each; the rotating axis lights magenta */
function sarasGlyph(stage, low) {
  const group = new THREE.Group();
  const sat = makeSatellite(0.18, stage); group.add(sat.group);
  const ringMat = () => new THREE.MeshBasicMaterial({ color: COLORS.lineStrong });
  const tickMat = () => new THREE.LineBasicMaterial({ color: COLORS.lineStrong, transparent: true, opacity: 0.9 });
  const makeTicks = r => { const a = []; for (let i = 0; i < 72; i++) { const th = (i / 72) * Math.PI * 2, l = i % 6 === 0 ? 0.03 : 0.015; a.push(Math.cos(th) * (r - l), Math.sin(th) * (r - l), 0, Math.cos(th) * (r + l), Math.sin(th) * (r + l), 0); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return new THREE.LineSegments(g, tickMat()); };
  const rings = [0.75, 0.85, 0.95].map((r, i) => {
    const holder = new THREE.Group();
    const torus = new THREE.Mesh(new THREE.TorusGeometry(r, 0.004, 6, low ? 64 : 128), ringMat()); const ticks = makeTicks(r);
    holder.add(torus, ticks);
    if (i === 0) holder.rotation.y = Math.PI / 2; else if (i === 1) holder.rotation.x = Math.PI / 2;  // normals: X (roll), Y (yaw), Z (pitch)
    group.add(holder); return { holder, torus, ticks, hot: 0 };
  });
  const poses = [new THREE.Euler(0, 0, 0), new THREE.Euler(0.55, 0.1, 0.05), new THREE.Euler(0.5, 0.9, 0.08), new THREE.Euler(-0.15, 0.8, 0.7), new THREE.Euler(0, 0, 0)].map(e => new THREE.Quaternion().setFromEuler(e));
  const qa = new THREE.Quaternion(), qd = new THREE.Quaternion(), axis = new THREE.Vector3();
  const cHot = new THREE.Color(COLORS.accent), cCold = new THREE.Color(COLORS.lineStrong), cBright = new THREE.Color(0x6A6A80);
  return {
    group, fitRadius: 1.0,
    lineMaterials: [],
    update(dt, t, hoverK) {
      const loop = (t % 16) / 4, seg = Math.floor(loop), lt = ease.inOut2(loop - seg);
      const A = poses[seg], B = poses[(seg + 1) % poses.length];
      qa.copy(A).slerp(B, lt); sat.group.quaternion.copy(qa);
      // dominant rotation axis of this segment
      qd.copy(A).invert().premultiply(B); axis.set(qd.x, qd.y, qd.z); const ang = 2 * Math.acos(clamp(qd.w, -1, 1));
      const comps = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)]; const dom = ang < 1e-3 ? -1 : comps.indexOf(Math.max(...comps));
      rings.forEach((r, i) => {
        r.hot = damp(r.hot, i === dom ? 1 : 0, 4, dt);
        r.torus.material.color.copy(cCold).lerp(cBright, hoverK * 0.6).lerp(cHot, r.hot);
        r.ticks.material.color.copy(cCold).lerp(cBright, hoverK * 0.6).lerp(cHot, r.hot * 0.6);
      });
      group.rotation.y = Math.sin(t * 0.13) * 0.25 + hoverK * 0.15; group.rotation.x = Math.cos(t * 0.1) * 0.12;
      sat.update(t);
    },
    dispose() { sat.dispose(); for (const r of rings) { r.torus.geometry.dispose(); r.torus.material.dispose(); r.ticks.geometry.dispose(); r.ticks.material.dispose(); } },
  };
}

/* ================================================================== AMBIENT (subpage title blocks) */
/**
 * mountAmbient(stage, regionEl, { exposure = 0.45, satellite = true, stars = true, sunDir })
 * Earth parked lower-right of the cell at low exposure, the dim planned orbit and the satellite orbiting (48 s).
 * Idle only: no scrub. Returns { region, scene, earth, dispose } or null.
 */
export function mountAmbient(stage, regionEl, opts = {}) {
  if (!stage || stage.isNone() || !regionEl) return null;
  try {
    const { exposure = 0.45, satellite: withSat = true, stars: withStars = true, sunDir = SUN_DIR } = opts;
    const low = stage.tier === 'LOW';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 300); camera.position.set(0, 0, 3.6); camera.lookAt(0, 0, 0);
    const sun = new THREE.DirectionalLight(COLORS.sun, 2.6); sun.position.copy(sunDir).multiplyScalar(10); scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.18));
    const earth = makeEarth(stage, { sunDir, segments: stage.tier === 'HIGH' ? 72 : stage.tier === 'MID' ? 56 : 40, clouds: false });
    earth.spin.rotation.y = opts.spin ?? 2.6;
    scene.add(earth.group);
    const stars = withStars ? makeStars(low ? 400 : 900, stage, { rMin: 40, rMax: 70, seed: 11 }) : null; if (stars) scene.add(stars.points);
    const guide = orbitRing(1.42, { inclination: 52, raan: 40, width: 1.2, color: COLORS.lineStrong, opacity: 0.12, low, depthWrite: false });
    earth.group.add(guide.object);
    const sat = withSat ? makeSatellite(0.035, stage) : null; if (sat) earth.group.add(sat.group);
    const tmp = new THREE.Vector3();
    let texturesKicked = false, satFade = 0;
    const fit = (w, h) => {
      const aspect = w / Math.max(1, h);
      earth.group.position.set(aspect >= 1 ? 0.95 * Math.min(1.6, aspect) * 0.75 : 0.55, aspect >= 1 ? -0.72 : -0.9, 0);
    };
    const region = stage.register(regionEl, {
      scene, camera, clearColor: COLORS.void, exposure, order: 1,
      lineMaterials: guide.isFat ? [guide.material] : [],
      onResize: fit,
      onFrame: ctx => {
        const { dt, t } = ctx;
        if (!texturesKicked) { texturesKicked = true; setTimeout(() => earth.loadTextures(), 80); }
        earth.update(dt, stage.quality);
        if (stars) stars.update(t, stage.quality);
        if (sat) {
          satFade = damp(satFade, 1, 1.5, dt);
          guide.pointAt((t * Math.PI * 2) / 48, sat.group.position);
          earth.group.getWorldPosition(tmp); sat.group.lookAt(tmp); sat.group.scale.setScalar(0.035 * satFade); sat.update(t);
        }
      },
      dispose: () => { disposeObject(scene); },
    });
    return { region, scene, camera, earth, satellite: sat, dispose() { stage.unregister(region); } };
  } catch (err) { console.warn('[scenes/index] ambient failed', err); return null; }
}
