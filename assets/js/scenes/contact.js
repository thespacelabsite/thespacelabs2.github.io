/*
 * SpaceLabs — scenes/contact.js : GROUND STATION EARTH (contact.html title-block emblem)
 * The shared Earth rotated so Thiruvananthapuram (8.5241 N, 76.9366 E) faces the camera; the sun set to the
 * direction of 5 N 20 W so the subcontinent sits in early night with the dusk rim glowing to the west and the
 * city lights emerging as the night texture arrives. The pin: a 1 px accent line from the surface to 1.08 radii,
 * a 0.012 sphere at the tip, a ring on the surface pulsing outward every 2.4 s, and a DOM label
 * (.region__tag[data-tag="pin"]) placed beside the tip through gl.projectLabel. Idle only, no scrub.
 * Built only from gl.js factories; fails soft (returns null, the inline SVG fallback stays).
 */
import {
  THREE, COLORS, DEG, clamp, lerp, damp, ease,
  earth as makeEarth, stars as makeStars, radialTexture, projectLabel, pointerParallax, cameraRig, latLonToLocal, disposeObject,
} from '../gl.js';

const STATION = { lat: 8.5241, lon: 76.9366 };   // Thiruvananthapuram (city coordinates; the Google Maps link is the office)
const SUBSOLAR = { lat: 5, lon: -20 };            // early evening over Kerala, dusk rim to the west
const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * mount(stage, { emblemEl }) -> { region, scene, camera, earth, pin, dispose } | null
 */
export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  const el = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!el) return null;
  try { return mountUnsafe(stage, el, opts); }
  catch (err) { console.warn('[scenes/contact] mount failed', err); return null; }
}

function mountUnsafe(stage, el, opts) {
  const tier = stage.tier, low = tier === 'LOW', high = tier === 'HIGH';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);

  /* ---- Earth, turned so the station faces the camera axis (+Z); the sun follows from the subsolar point */
  const earth = makeEarth(stage, { clouds: high, segments: high ? 96 : low ? 48 : 64, nightBoost: 1.45, atmosStrength: 1.15 });
  earth.spinSpeed = 0;
  scene.add(earth.group);
  earth.spin.rotation.y = earth.spinFor(STATION.lat, STATION.lon, new THREE.Vector3(0, 0, 1));
  const pinDir = earth.worldDirOf(STATION.lat, STATION.lon, new THREE.Vector3());
  let subsolar = SUBSOLAR;
  try { const q = new URLSearchParams(location.search).get('gsun'); if (q) { const [la, lo] = q.split(',').map(Number); if (Number.isFinite(la) && Number.isFinite(lo)) subsolar = { lat: la, lon: lo }; } } catch { /* noop */ }
  const sunDir = earth.worldDirOf(subsolar.lat, subsolar.lon, new THREE.Vector3());
  earth.setSunDir(sunDir);
  const sun = new THREE.DirectionalLight(COLORS.sun, 2.4); sun.position.copy(sunDir).multiplyScalar(10); scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.22));

  /* ---- stars */
  const stars = makeStars(low ? 500 : high ? 1600 : 1000, stage, { rMin: 40, rMax: 70, seed: 23 });
  scene.add(stars.points);

  /* ---- the pin (spin-local so it stays glued to Kerala) */
  const pLocal = latLonToLocal(STATION.lat, STATION.lon, 1);
  const pin = new THREE.Group(); pin.name = 'pin';
  pin.position.copy(pLocal); pin.lookAt(pLocal.clone().multiplyScalar(2));           // pin +Z = local vertical
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0.004), new THREE.Vector3(0, 0, 0.08)]);
  const lineMat = new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0 });
  const mast = new THREE.Line(lineGeo, lineMat); mast.renderOrder = 4;
  const tipMat = new THREE.MeshBasicMaterial({ color: COLORS.accentHot, transparent: true, opacity: 0 });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.012, 14, 10), tipMat); tip.position.z = 0.08; tip.renderOrder = 4;
  const haloTex = radialTexture(64, [[0, 'rgba(255,63,198,0.9)'], [0.4, 'rgba(212,18,161,0.35)'], [1, 'rgba(212,18,161,0)']]);
  const haloMat = new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
  const halo = new THREE.Sprite(haloMat); halo.position.z = 0.08; halo.scale.setScalar(0.085); halo.renderOrder = 4;
  const ringGeo = new THREE.RingGeometry(0.02, 0.024, 56);
  const baseMat = new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  const base = new THREE.Mesh(ringGeo, baseMat); base.position.z = 0.012; base.renderOrder = 3;
  const pulseMat = new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  const pulse = new THREE.Mesh(ringGeo, pulseMat); pulse.position.z = 0.012; pulse.renderOrder = 3;
  pin.add(mast, tip, halo, base, pulse);
  earth.spin.add(pin);

  /* ---- camera framing: the pin at the frame centre, the Earth filling the cell width and sitting low */
  const rig = cameraRig(camera);
  const parallax = pointerParallax({ yaw: 0.05, pitch: 0.035, touch: stage.isTouch, driftPeriod: 9 });
  const up0 = Y_UP.clone().projectOnPlane(pinDir).normalize();
  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), drift = new THREE.Vector3();
  let camDist = 3.6, camLift = 0.24;
  const fit = (w, h) => {
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect;
    camera.fov = aspect < 0.95 ? 42 : 34;
    camera.updateProjectionMatrix();
    const halfV = (camera.fov / 2) * DEG, halfH = Math.atan(Math.tan(halfV) * aspect);
    const lim = Math.min(halfV, halfH);
    const angR = lim * (aspect < 0.95 ? 0.94 : 0.82);      // Earth's angular radius vs the tight half-fov
    camDist = 1 / Math.sin(angR);
    camLift = aspect < 0.95 ? 0.26 : 0.16;                   // camera above the pin line: Earth centre drops below the frame centre
  };
  fit(1, 1.2);

  /* ---- DOM label beside the tip */
  const tag = el.querySelector('[data-tag="pin"]');
  const placeTag = (region, k) => {
    if (!tag) return;
    camera.updateMatrixWorld(); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    tip.updateWorldMatrix(true, false);
    const p = projectLabel(tip, camera, region);
    const w = tag.offsetWidth || 220, h = tag.offsetHeight || 36, W = region.rect.w, H = region.rect.h;
    // beside the tip (right, else left); when neither side has room (narrow cells) hang it below the pin
    let x = p.x + 18, y = p.y - h * 0.5, mode = '';
    if (x + w > W - 12) { x = p.x - 18 - w; mode = 'is-left'; }
    if (x < 12) { x = clamp(p.x - w * 0.5, 12, Math.max(12, W - w - 12)); y = p.y + 22; mode = 'is-below'; }
    y = clamp(y, 12, Math.max(12, H - h - 12));
    for (const m of ['is-left', 'is-below']) if (tag.classList.contains(m) !== (mode === m)) tag.classList.toggle(m, mode === m);
    tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    tag.style.opacity = p.visible ? k.toFixed(3) : '0';
  };

  /* ---- intro on the wall clock from the first rendered frame */
  let started = false, t0 = 0, kicked = false;
  const EXPOSURE = 0.95;

  const region = stage.register(el, {
    scene, camera, clearColor: COLORS.void, exposure: 0, order: 1,
    onResize: fit,
    onFrame: ctx => {
      const { dt, t, hover, region: r } = ctx;
      if (!started) { started = true; t0 = performance.now(); }
      if (!kicked) { kicked = true; setTimeout(() => earth.loadTextures(), 60); }
      const age = (performance.now() - t0) / 1000;
      const kEarth = ease.out2(clamp(age / 1.6));           // planet + exposure
      const kPin = ease.out2(clamp((age - 0.7) / 0.9));     // pin after the planet
      const kTag = ease.out2(clamp((age - 1.3) / 0.7));     // label last
      r.exposure = EXPOSURE * kEarth;
      earth.setReveal(kEarth);
      earth.update(dt, stage.quality);
      stars.update(t, stage.quality);
      // camera: above the pin line, looking at the pin; pointer parallax + slow drift keep it alive
      const par = parallax.update(dt, t, hover ? 1.4 : 1);
      camPos.copy(pinDir).multiplyScalar(camDist).addScaledVector(up0, camLift);
      camTgt.copy(pinDir);
      drift.set(Math.sin(t * 0.09) * 0.02, Math.cos(t * 0.07) * 0.015, 0);
      rig.apply(camPos, camTgt, camera.fov, par.yaw, par.pitch, drift);
      stars.points.rotation.set(par.pitch * 0.3, par.yaw * 0.3, 0);
      // pin: fade in, beacon breath, 2.4 s outward pulse
      lineMat.opacity = 0.95 * kPin; tipMat.opacity = kPin; baseMat.opacity = 0.9 * kPin;
      const ph = (t % 2.4) / 2.4;
      const breath = 1 + 0.35 * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
      tip.scale.setScalar(lerp(0.6, 1, kPin) * breath);
      haloMat.opacity = (0.55 + 0.35 * (breath - 1) / 0.35) * kPin;
      halo.scale.setScalar(0.085 * (0.85 + 0.3 * (breath - 1) / 0.35));
      pulse.scale.setScalar(1 + 2.6 * ease.out2(ph));
      pulseMat.opacity = 0.8 * (1 - ph) * kPin;
      placeTag(r, kTag);
    },
    dispose: () => {
      try { parallax.dispose(); } catch { /* noop */ }
      try { earth.dispose(); stars.dispose(); haloTex.dispose(); } catch { /* noop */ }
      disposeObject(scene);
      if (tag) tag.style.opacity = '0';
    },
  });
  if (!region) throw new Error('region refused');

  const api = {
    region, scene, camera, earth, pin, tip, pinDir, sunDir,
    dispose() { stage.unregister(region); },
  };
  try { if (new URLSearchParams(location.search).get('debug') === '1') { window.__sl = Object.assign(window.__sl || {}, { contact: api, stage }); } } catch { /* noop */ }
  return api;
}
