/*
 * SpaceLabs — scenes/astra.js : PRODUCT 01 — ASTRA
 *  · TRAJECTORY FAN emblem (title block, [data-region="emblem"]): a dark Earth limb with a tangent launch grid,
 *    one target orbit, 11 candidate ascent curves (hairline ghosts) and the optimum as a self-drawing emissive
 *    ribbon with a travelling marker. Hovering a ghost brightens it and a mono DOM tag reads "CANDIDATE 07".
 *  · CONVERGENCE scrub stage ([data-region="stage"] inside section.scrub[data-scrub]): the same fan; scroll
 *    progress drives four beats — define vehicle and phases → set constraints and objective → converge
 *    (the 11 ghosts lerp toward the optimum in 48 discrete iterations) → export and iterate — and feeds the
 *    "SIM" readout ("ITER 012 / 048 · ΔV ↓ · CONSTRAINTS NOMINAL").
 * Built only from gl.js factories; every entry point fails soft (tier NONE keeps the inline SVG stills).
 */
import {
  THREE, COLORS, DEG, clamp, lerp, smoothstep, remap, damp, ease,
  earth as makeEarth, stars as makeStars, orbitRing, ribbon as makeRibbon, fatLine, wireGrid, projectLabel, bindScrub, disposeObject,
} from '../gl.js';

const SAMPLES = 48;            // points per candidate curve
const ITERS = 48;              // optimiser iterations shown on the stage
const ORBIT_R = 1.42;
const FAN_SUN = new THREE.Vector3(-3.2, 1.6, 1.4).normalize();      // dusk limb: lit rim on the left, night to the right
const Y_UP = new THREE.Vector3(0, 1, 0);

/* candidate parameters: ang = insertion angle along the ring (rad, 0 = optimum), loft = extra apogee, sway = lateral, lift = early pitch */
const OPTIMUM = { ang: 0, loft: 0.10, sway: 0, lift: 0.42 };
const GHOSTS = [
  { ang: -0.62, loft: 0.02, sway: -0.16, lift: 0.10 }, { ang: -0.50, loft: 0.34, sway: 0.10, lift: 0.55 }, { ang: -0.38, loft: -0.04, sway: 0.22, lift: 0.30 },
  { ang: -0.26, loft: 0.22, sway: -0.20, lift: 0.70 }, { ang: -0.13, loft: 0.46, sway: 0.05, lift: 0.20 }, { ang: 0.12, loft: 0.00, sway: 0.15, lift: 0.60 },
  { ang: 0.24, loft: 0.30, sway: -0.08, lift: 0.05 }, { ang: 0.36, loft: 0.08, sway: 0.24, lift: 0.80 }, { ang: 0.48, loft: 0.40, sway: -0.18, lift: 0.35 },
  { ang: 0.60, loft: 0.16, sway: 0.02, lift: 0.50 }, { ang: 0.72, loft: -0.02, sway: 0.12, lift: 0.15 },
];

/* ------------------------------------------------------------------ geometry helpers */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _side = new THREE.Vector3(), _dir = new THREE.Vector3(), _p = new THREE.Vector3();
function slerpDir(a, b, s, out) {
  const w = Math.acos(clamp(a.dot(b), -1, 1)), sa = Math.sin(w);
  if (sa < 1e-5) return out.copy(a);
  return out.copy(a).multiplyScalar(Math.sin((1 - s) * w) / sa).addScaledVector(b, Math.sin(s * w) / sa).normalize();
}
/** fill `pts` (SAMPLES + 1 Vector3) with an ascent from the launch direction L to the ring point at par.ang */
function ascent(L, ring, par, pts) {
  const E = ring.pointAt(par.ang, _b).normalize();
  _side.crossVectors(L, E).normalize();
  for (let i = 0; i <= SAMPLES; i++) {
    const s = i / SAMPLES;
    slerpDir(L, E, s, _dir);
    const climb = Math.pow(s, 1 - 0.55 * par.lift);                              // lift: how early the altitude is gained
    const r = 1 + (ORBIT_R - 1) * climb + par.loft * Math.sin(Math.PI * s);
    pts[i].copy(_dir).multiplyScalar(r).addScaledVector(_side, par.sway * Math.sin(Math.PI * s));
  }
  return pts;
}
const lerpPar = (a, b, k, out) => { out.ang = lerp(a.ang, b.ang, k); out.loft = lerp(a.loft, b.loft, k); out.sway = lerp(a.sway, b.sway, k); out.lift = lerp(a.lift, b.lift, k); return out; };
const newPts = () => Array.from({ length: SAMPLES + 1 }, () => new THREE.Vector3());

/* ------------------------------------------------------------------ the fan (shared by both regions) */
/**
 * makeFan(stage, { low, ghostOpacity }) -> { rig, earth, ring, grid, ghosts[], optimum, marker, launch, insertion,
 *   setIteration(k 0..ITERS, noise 0..1), setHover(i | -1), setRingHot(0..1), setGhostFade(0..1), update(dt, t), lineMaterials, dispose }
 */
function makeFan(stage, { low = false, ghostOpacity = 0.5 } = {}) {
  const rig = new THREE.Group(); rig.name = 'fanRig';
  // Earth, radius 1, dusk-lit; textures only after the first frame (loadTextures() is called by the owner)
  const earth = makeEarth(stage, { sunDir: FAN_SUN, clouds: false, segments: low ? 40 : 64, atmosStrength: 1.15 });
  earth.spinSpeed = 0.006; earth.spin.rotation.y = 1.9;
  rig.add(earth.group);
  // launch site (world direction, front-top-left of the visible cap) and its tangent 20x20 launch grid
  const L = new THREE.Vector3(-0.50, 0.74, 0.56).normalize();
  const grid = wireGrid(0.9, 20, { color: COLORS.line, opacity: 0.7 });
  grid.position.copy(L).multiplyScalar(1.002);
  grid.quaternion.setFromUnitVectors(Y_UP, L);
  rig.add(grid);
  // target orbit: inclined so it crosses the frame from lower-left behind the Earth to the upper right in front
  const normal = new THREE.Vector3(-0.34, 0.46, 0.82).normalize();
  const start = new THREE.Vector3(0.62, 0.72, 0.30);
  // ring + ghosts use the dim/muted greys (lineStrong at partial opacity is invisible on the void background)
  const ring = orbitRing(ORBIT_R, { normal, start, segments: low ? 128 : 256, width: 1.2, color: COLORS.dim, opacity: 0.7, low });
  rig.add(ring.object);
  // ghosts
  const ghosts = GHOSTS.map((base, i) => {
    const pts = ascent(L, ring, base, newPts());
    const line = fatLine(pts, { color: COLORS.muted, width: 1.2, opacity: ghostOpacity, low, depthWrite: false });
    rig.add(line.object);
    return { i, base, cur: { ...base }, pts, line, hot: 0, opacity: ghostOpacity };
  });
  // optimum: emissive ribbon that draws itself + a twin for the glow; the ghost positions converge toward it
  const optPts = ascent(L, ring, OPTIMUM, newPts());
  const optimum = makeRibbon(optPts, { radius: low ? 0.009 : 0.011, segments: low ? 96 : 180, radial: 8, twin: !low, twinRadius: 0.038, twinOpacity: 0.09, progress: 0 });
  rig.add(optimum.group);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10), new THREE.MeshBasicMaterial({ color: COLORS.accentHot }));
  rig.add(marker);
  const launch = new THREE.Object3D(); launch.position.copy(L).multiplyScalar(1.01); rig.add(launch);
  const insertion = new THREE.Object3D(); insertion.position.copy(optPts[SAMPLES]); rig.add(insertion);
  const optMid = new THREE.Object3D(); optMid.position.copy(optPts[Math.round(SAMPLES * 0.55)]); rig.add(optMid);

  const cCold = new THREE.Color(COLORS.muted), cHot = new THREE.Color(COLORS.text), cRing = new THREE.Color(COLORS.dim), cRingHot = new THREE.Color(COLORS.accent);
  const tmpPar = { ang: 0, loft: 0, sway: 0, lift: 0 };
  let iter = -1, lastNoise = -1, hover = -1, ringHot = 0, ghostFade = 1;
  const api = {
    rig, earth, ring, grid, ghosts, optimum, marker, launch, insertion, optMid, L,
    lineMaterials: [ring, ...ghosts.map(g => g.line)].filter(l => l.isFat).map(l => l.material),
    /** k = 0 keeps the authored spread, k = ITERS collapses every ghost onto the optimum (48 discrete steps) */
    setIteration(k, noise = 0) {
      k = Math.round(clamp(k, 0, ITERS)); noise = +noise.toFixed(2);
      if (k === iter && noise === lastNoise) return;
      iter = k; lastNoise = noise;
      const f = ease.inOut2(k / ITERS);
      for (const g of ghosts) {
        lerpPar(g.base, OPTIMUM, f, g.cur);
        if (noise > 0 && k > 0 && k < ITERS) {               // line-search jitter that dies out as the optimiser settles
          const n = noise * (1 - f) * 0.08, ph = k * 1.7 + g.i * 2.3;
          g.cur.loft += Math.sin(ph) * n; g.cur.sway += Math.cos(ph * 1.3) * n; g.cur.ang += Math.sin(ph * 0.7) * n * 0.6;
        }
        ascent(L, ring, g.cur, g.pts); g.line.setPoints(g.pts);
      }
    },
    setHover(i) { hover = i; },
    setRingHot(v) { ringHot = v; },
    setGhostFade(v) { ghostFade = v; },
    update(dt, t) {
      earth.update(dt, stage.quality);
      for (const g of ghosts) {
        g.hot = damp(g.hot, g.i === hover ? 1 : 0, 10, dt);
        g.line.material.color.copy(cCold).lerp(cHot, g.hot);
        if (g.line.isFat) g.line.material.linewidth = lerp(1.2, 2.0, g.hot);
        g.line.setOpacity(lerp(g.opacity, 1, g.hot) * ghostFade);
      }
      ring.material.color.copy(cRing).lerp(cRingHot, ringHot);
      ring.setOpacity(lerp(0.7, 0.9, ringHot));
    },
    dispose() {
      earth.dispose(); ring.dispose(); optimum.dispose(); for (const g of ghosts) g.line.dispose();
      marker.geometry.dispose(); marker.material.dispose(); grid.geometry.dispose(); grid.material.dispose();
    },
  };
  api.setIteration(0);
  return api;
}

/* ------------------------------------------------------------------ lights */
function lights(scene) {
  const sun = new THREE.DirectionalLight(COLORS.sun, 2.2); sun.position.copy(FAN_SUN).multiplyScalar(10); scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.22));
  const fill = new THREE.PointLight(COLORS.accent, 0.5, 6, 2); fill.position.set(0.6, 1.9, 1.2); scene.add(fill);
}

/* ------------------------------------------------------------------ screen-space pick of the nearest ghost */
const _w = new THREE.Vector3();
function pickGhost(fan, camera, pointer, w, h, threshold = 16) {
  const px = (pointer.x * 0.5 + 0.5) * w, py = (-pointer.y * 0.5 + 0.5) * h;
  let best = -1, bestD = threshold * threshold;
  fan.rig.updateWorldMatrix(true, false);
  for (const g of fan.ghosts) {
    for (let i = 0; i <= SAMPLES; i += 2) {
      _w.copy(g.pts[i]).applyMatrix4(fan.rig.matrixWorld).project(camera);
      if (_w.z > 1) continue;
      const dx = (_w.x * 0.5 + 0.5) * w - px, dy = (-_w.y * 0.5 + 0.5) * h - py, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = g.i; }
    }
  }
  return best;
}

/* ================================================================== EMBLEM */
function mountEmblem(stage, el) {
  const low = stage.tier === 'LOW';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 200);
  lights(scene);
  const fan = makeFan(stage, { low, ghostOpacity: 0.42 });
  scene.add(fan.rig);
  const stars = makeStars(low ? 300 : 700, stage, { rMin: 40, rMax: 70, seed: 21, sizeScale: 0.8 }); scene.add(stars.points);
  const tagCand = el.querySelector('[data-tag="cand"]'), tagOpt = el.querySelector('[data-tag="opt"]');
  // framed so the whole fan (every ghost, launch site to insertion) sits inside the cell with the limb below it
  const target = new THREE.Vector3(0.3, 1.05, 0), camOff = new THREE.Vector3(0.05, 0.42, 3.35);
  const fit = (w, h) => {
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect; camera.fov = aspect < 0.9 ? 40 : 34; camera.updateProjectionMatrix();
    const k = aspect < 0.9 ? 1 / Math.max(0.55, aspect / 0.9) : 1;              // narrow cells: back off so the fan stays in frame
    camera.position.copy(target).addScaledVector(camOff, Math.min(1.35, k) * 1.25); camera.lookAt(target);
  };
  let kicked = false, yaw = 0, pitch = 0, hover = -1, hoverT = 0, intro = 0;
  const region = stage.register(el, {
    scene, camera, clearColor: COLORS.void, exposure: 0.95, order: 1,
    lineMaterials: fan.lineMaterials,
    onResize: fit,
    onFrame: ({ dt, t, pointer, hover: fine, w, h, region: r }) => {
      if (!kicked) { kicked = true; setTimeout(() => fan.earth.loadTextures(), 120); }
      intro = Math.min(1, intro + dt / 1.2);
      fan.update(dt, t); stars.update(t, stage.quality);
      // idle: the optimum draws itself on a 9 s loop (7 s draw, 2 s hold) with the marker riding the head
      const loop = (t % 9) / 9, drawn = ease.inOut1(clamp(loop / 0.78)) * ease.reveal(intro);
      fan.optimum.setProgress(drawn); fan.optimum.getPoint(Math.max(0.001, drawn), fan.marker.position); fan.marker.visible = drawn > 0.002;
      // pointer: slow precession + parallax; hover pick (fine pointer only, throttled)
      yaw = damp(yaw, pointer.inside && fine ? pointer.x * 0.16 : 0, 3, dt);
      pitch = damp(pitch, pointer.inside && fine ? -pointer.y * 0.06 : 0, 3, dt);
      fan.rig.rotation.set(pitch, 0.04 * Math.sin(t * 0.21) + yaw, 0);
      hoverT += dt;
      if (fine && pointer.inside) { if (hoverT > 0.05) { hoverT = 0; hover = pickGhost(fan, camera, pointer, w, h); } }
      else hover = -1;
      fan.setHover(hover);
      if (tagCand) {
        if (hover >= 0) { const g = fan.ghosts[hover]; _p.copy(g.pts[Math.round(SAMPLES * 0.6)]).applyMatrix4(fan.rig.matrixWorld); _tagObj.position.copy(_p); tagCand.textContent = `CANDIDATE ${String(hover + 1).padStart(2, '0')}`; projectLabel(_tagObj, camera, r, tagCand); }
        else tagCand.style.opacity = '0';
      }
      if (tagOpt) { const o = projectLabel(fan.optMid, camera, r, tagOpt); if (hover >= 0 || drawn < 0.6) tagOpt.style.opacity = '0'; else tagOpt.style.opacity = o.visible ? '1' : '0'; }
    },
    dispose: () => { fan.dispose(); stars.dispose(); disposeObject(scene); },
  });
  return region ? { region, scene, camera, fan, dispose: () => stage.unregister(region) } : null;
}
const _tagObj = new THREE.Object3D();

/* ================================================================== CONVERGENCE STAGE */
const BEATS = { define: 0.22, constrain: 0.42, converge: 0.85 };   // beat boundaries (match the .step data-from/to bands)
function mountStage(stage, sectionEl, stickyEl, readoutEl) {
  const low = stage.tier === 'LOW';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
  lights(scene);
  const fan = makeFan(stage, { low, ghostOpacity: 0.5 });
  scene.add(fan.rig);
  const stars = makeStars(low ? 500 : 1400, stage, { rMin: 40, rMax: 80, seed: 33, sizeScale: 0.9 }); scene.add(stars.points);
  const tagL = stickyEl.querySelector('[data-tag="launch"]'), tagP = stickyEl.querySelector('[data-tag="insertion"]');
  const scrub = bindScrub(sectionEl, { smooth: 0.6 });
  const target = new THREE.Vector3(), camOff = new THREE.Vector3();
  let aspect = 1, wide = true;
  const fit = (w, h) => {
    aspect = w / Math.max(1, h); wide = aspect >= 1.05;
    camera.aspect = aspect; camera.fov = wide ? 32 : 44; camera.updateProjectionMatrix();
  };
  let kicked = false, yaw = 0, p = 0, lastText = '', textT = 0, dolly = 0;
  const setText = s => { if (readoutEl && s !== lastText) { lastText = s; readoutEl.textContent = s; } };
  const region = stage.register(stickyEl, {
    scene, camera, clearColor: COLORS.void, exposure: 0.95, order: 1,
    lineMaterials: fan.lineMaterials,
    onResize: fit,
    onFrame: ({ dt, t, pointer, hover, region: r }) => {
      if (!kicked) { kicked = true; setTimeout(() => fan.earth.loadTextures(), 120); }
      p = scrub.update(dt);
      fan.update(dt, t); stars.update(t, stage.quality);
      // beats
      const define = smoothstep(0, BEATS.define, p);                                   // 0 → 1 across beat 1
      const constrain = smoothstep(BEATS.define, BEATS.constrain, p);                  // ring lights, ghosts appear
      const conv = remap(p, BEATS.constrain, BEATS.converge);                          // 0..1 across beat 3
      const exportK = smoothstep(BEATS.converge, 1, p);                                // ghosts fade, optimum glows
      const k = Math.round(conv * ITERS);
      fan.setIteration(k, 1);
      fan.setRingHot(constrain * (1 - exportK * 0.5));
      fan.setGhostFade(constrain * (1 - exportK));
      // the optimum: draws itself during "define" (vehicle and phases), re-draws fully once converged
      const drawn = p < BEATS.constrain ? ease.inOut1(define) : 1;
      fan.optimum.setProgress(drawn);
      const head = p < BEATS.constrain ? drawn : ((t * 0.12) % 1);
      fan.optimum.getPoint(Math.max(0.001, head), fan.marker.position); fan.marker.visible = drawn > 0.002;
      fan.optimum.material.emissiveIntensity = lerp(2.4, 3.6, exportK);
      if (fan.optimum.twin) fan.optimum.twin.material.opacity = lerp(0.09, 0.16, exportK);
      // camera: wide stages keep the whole fan (launch → every ghost → insertion) right of the step column and
      // clear of the chapter-nav dots, centred vertically with the limb below; narrow stages lift the fan into the
      // upper half above the step panel. Gentle dolly in as it converges.
      dolly = damp(dolly, conv, 2, dt);
      const dist = wide ? lerp(5.0, 4.6, dolly) : lerp(4.7, 4.3, dolly) * 1.4;
      if (wide) target.set(-0.34, 1.0, 0); else target.set(0.15, 0.3, 0);
      camOff.set(0.05, 0.3, 1).normalize().multiplyScalar(dist);
      yaw = damp(yaw, pointer.inside && hover ? pointer.x * 0.08 : 0, 3, dt);
      fan.rig.rotation.set(0, 0.03 * Math.sin(t * 0.17) + yaw + lerp(-0.1, 0.06, ease.inOut1(p)), 0);
      camera.position.copy(target).add(camOff); camera.lookAt(target);
      // tags (labels only)
      if (tagL) { const o = projectLabel(fan.launch, camera, r, tagL); tagL.style.opacity = o.visible && define > 0.3 ? '1' : '0'; }
      if (tagP) { const o = projectLabel(fan.insertion, camera, r, tagP); tagP.style.opacity = o.visible && constrain > 0.5 ? '1' : '0'; }
      // readout at 10 Hz
      textT += dt;
      if (textT > 0.1) {
        textT = 0;
        const kk = String(k).padStart(3, '0');
        if (p < BEATS.define) setText('VEHICLE · PHASES · ITER 000 / 048');
        else if (p < BEATS.constrain) setText('CONSTRAINTS SET · OBJECTIVE ΔV · ITER 000 / 048');
        else if (p < BEATS.converge) setText(`ITER ${kk} / 048 · ΔV ↓ · CONSTRAINTS NOMINAL`);
        else setText('ITER 048 / 048 · CONVERGED · EXPORT CSV');
      }
    },
    dispose: () => { scrub.kill(); fan.dispose(); stars.dispose(); disposeObject(scene); },
  });
  return region ? { region, scene, camera, fan, scrub, dispose: () => stage.unregister(region) } : null;
}

/* ================================================================== PAGE ENTRY */
/**
 * mount(stage, { emblemEl, stageSectionEl, stageEl, readoutEl }) -> { emblem, stage, dispose } | null
 */
export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  const $ = s => document.querySelector(s);
  const emblemEl = opts.emblemEl || $('[data-region="emblem"]');
  const sectionEl = opts.stageSectionEl || $('section.scrub[data-scrub]');
  const stickyEl = opts.stageEl || (sectionEl && sectionEl.querySelector('[data-region="stage"]'));
  const readoutEl = opts.readoutEl || (sectionEl && sectionEl.querySelector('[data-readout]'));
  const out = { emblem: null, stage: null, dispose() { try { out.emblem?.dispose(); } catch { /* noop */ } try { out.stage?.dispose(); } catch { /* noop */ } } };
  if (emblemEl) { try { out.emblem = mountEmblem(stage, emblemEl); } catch (err) { console.warn('[scenes/astra] emblem failed', err); } }
  if (sectionEl && stickyEl) { try { out.stage = mountStage(stage, sectionEl, stickyEl, readoutEl); } catch (err) { console.warn('[scenes/astra] stage failed', err); } }
  try { window.__slAstra = out; } catch { /* noop */ }
  return out.emblem || out.stage ? out : null;
}
