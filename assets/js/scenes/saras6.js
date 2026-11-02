/*
 * SpaceLabs — scenes/saras6.js : SARAS (PRODUCT 02)
 * Two regions on one shared stage, both built from gl.js primitives:
 *   1. SIX AXES emblem (title cell, [data-region="emblem"]): the shared satellite inside three gimbal rings
 *      (roll / pitch / yaw, 72 ticks each, projected degree labels) drifting on a Lissajous inside a
 *      translation cage. Pointer x/y sets the target pitch/yaw (±25°); touch or idle runs a 16 s scripted
 *      attitude loop. The ring of the axis currently moving lights magenta; a DOM readout prints the attitude.
 *   2. DISTURBANCE AND RECOVERY scrub stage (section.scrub[data-scrub], sticky [data-region="stage"]):
 *      model → 18° gust tilt (power4.out) → closed-loop recovery (damped) → HILS corner node + Ethernet link.
 * Progress comes from core.js through gl.bindScrub (single source of truth with the DOM steps).
 * mount(stage, opts) -> handle | null. Never throws: a failure leaves the inline SVG fallbacks visible.
 */
import { THREE, COLORS, SUN_DIR, DEG, satellite, fatLine, wireBox, projectLabel, bindScrub, pointerParallax, damp, clamp, lerp, remap, smoothstep, ease, disposeObject } from '../gl.js';

const RINGS = [
  { key: 'roll', label: 'ROLL', r: 2.6 },
  { key: 'pitch', label: 'PITCH', r: 3.1 },
  { key: 'yaw', label: 'YAW', r: 3.6 },
];
const C_COLD = new THREE.Color(COLORS.lineStrong), C_HOT = new THREE.Color(COLORS.accent), C_BRIGHT = new THREE.Color(0x7A7A90);
const CAGE = 8;

/** "+12.4°" / "−08.1°" (true minus sign, two integer digits, one decimal) */
function fmtDeg(rad) {
  const v = rad / DEG, a = Math.abs(v);
  return `${v < -0.05 ? '−' : '+'}${a < 10 ? '0' : ''}${a.toFixed(1)}°`;
}

function makeTicks(r) {
  const a = [], n = 72;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2, l = i % 6 === 0 ? 0.17 : 0.075;
    a.push(Math.cos(th) * (r - l), Math.sin(th) * (r - l), 0, Math.cos(th) * (r + l), Math.sin(th) * (r + l), 0);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLORS.lineStrong, transparent: true, opacity: 0.9 }));
}

function addLights(scene) {
  const sun = new THREE.DirectionalLight(COLORS.sun, 2.4); sun.position.copy(SUN_DIR).multiplyScalar(10); scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(COLORS.atmos, 0.4); fill.position.set(-6, -2, -4); scene.add(fill, fill.target);
  scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.28));
}

/**
 * buildRig(stage, {low}) -> the gimbal rig.
 * Nesting mirrors a real gimbal: yaw (outer, normal Y) > pitch (middle, normal X) > roll (inner, normal Z) > body.
 * The body quaternion therefore equals Euler(x = pitch, y = yaw, z = roll, 'YXZ').
 */
function buildRig(stage, { low = false, satScale = 0.48 } = {}) {
  const root = new THREE.Group(); root.name = 'sarasRig';
  const assembly = new THREE.Group(); assembly.name = 'gimbal'; root.add(assembly);
  const gYaw = new THREE.Group(), gPitch = new THREE.Group(), gRoll = new THREE.Group();
  assembly.add(gYaw); gYaw.add(gPitch); gPitch.add(gRoll);
  const sat = satellite(satScale, stage); gRoll.add(sat.group);

  const rings = RINGS.map(def => {
    const holder = new THREE.Group();
    const torus = new THREE.Mesh(new THREE.TorusGeometry(def.r, 0.03, 8, low ? 72 : 144), new THREE.MeshBasicMaterial({ color: COLORS.lineStrong }));
    const ticks = makeTicks(def.r);
    holder.add(torus, ticks);
    const marker = new THREE.Object3D();
    let parent;
    if (def.key === 'yaw') { parent = gYaw; holder.rotation.x = Math.PI / 2; marker.position.set(-def.r, 0, 0); }
    else if (def.key === 'pitch') { parent = gPitch; holder.rotation.y = Math.PI / 2; marker.position.set(0, def.r, 0); }
    else { parent = gRoll; marker.position.set(def.r * 0.7071, -def.r * 0.7071, 0); }
    parent.add(holder, marker);
    return { ...def, holder, torus, ticks, marker, hot: 0, angle: 0, rate: 0 };
  });

  // translation cage: the three translational DOF the body drifts through
  const cage = wireBox(CAGE, CAGE, CAGE, { color: COLORS.lineStrong, opacity: 0.5 }); cage.material.depthWrite = false; root.add(cage);
  const cageInner = wireBox(CAGE * 0.5, CAGE * 0.5, CAGE * 0.5, { color: COLORS.lineStrong, opacity: 0.18 }); cageInner.material.depthWrite = false; root.add(cageInner);

  const prev = { p: 0, y: 0, r: 0 };
  const api = {
    root, assembly, gYaw, gPitch, gRoll, sat, rings, cage, cageInner,
    /** attitude in radians (gimbal order yaw > pitch > roll) */
    setEuler(pitch, yaw, roll, dt = 1 / 60) {
      gYaw.rotation.y = yaw; gPitch.rotation.x = pitch; gRoll.rotation.z = roll;
      const inv = 1 / Math.max(1e-3, dt);
      rings[0].angle = roll; rings[1].angle = pitch; rings[2].angle = yaw;
      rings[0].rate = Math.abs(roll - prev.r) * inv; rings[1].rate = Math.abs(pitch - prev.p) * inv; rings[2].rate = Math.abs(yaw - prev.y) * inv;
      prev.p = pitch; prev.y = yaw; prev.r = roll;
    },
    /** Lissajous drift of the whole gimbal inside the cage (translational DOF) */
    drift(t, amp = 0.4) {
      assembly.position.set(amp * Math.sin(t * 0.31), amp * Math.sin(t * 0.23 + 1.3), amp * Math.sin(t * 0.17 + 2.1));
    },
    /** colour the rings: the axis currently moving lights magenta; hoverK brightens the whole rig */
    update(dt, t, hoverK = 0) {
      let dom = -1, best = 2 * DEG; // > 2 deg/s counts as "moving"
      rings.forEach((r, i) => { if (r.rate > best) { best = r.rate; dom = i; } });
      rings.forEach((r, i) => {
        r.hot = damp(r.hot, i === dom ? 1 : 0, 5, dt);
        r.torus.material.color.copy(C_COLD).lerp(C_BRIGHT, hoverK * 0.5).lerp(C_HOT, r.hot);
        r.ticks.material.color.copy(C_COLD).lerp(C_BRIGHT, hoverK * 0.5).lerp(C_HOT, r.hot * 0.7);
      });
      sat.update(t);
    },
    dispose() {
      sat.dispose();
      for (const r of rings) { r.torus.geometry.dispose(); r.torus.material.dispose(); r.ticks.geometry.dispose(); r.ticks.material.dispose(); }
      cage.geometry.dispose(); cage.material.dispose(); cageInner.geometry.dispose(); cageInner.material.dispose();
    },
  };
  return api;
}

/* ================================================================== 1. SIX AXES emblem */
function mountEmblem(stage, el) {
  if (!el) return null;
  const low = stage.tier === 'LOW';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  addLights(scene);
  const rig = buildRig(stage, { low }); scene.add(rig.root);
  const tags = {}; for (const r of RINGS) tags[r.key] = el.querySelector(`[data-tag="${r.key}"]`);
  const readout = el.querySelector('[data-attitude]');

  // scripted attitude loop (16 s, four poses) for touch and idle; pointer overrides on fine pointers
  const poses = [[0, 0, 0], [14, 6, 0], [10, -18, 12], [-8, 12, -16]].map(a => a.map(d => d * DEG));
  const cur = { p: 0, y: 0, r: 0 }, tgt = { p: 0, y: 0, r: 0 };
  const camDir = new THREE.Vector3(0.55, 0.36, 1).normalize();
  let dist = 18;
  const fit = (w, h) => {
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect; camera.fov = aspect < 1 ? 38 : 30; camera.updateProjectionMatrix();
    dist = 5.7 / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
    camera.position.copy(camDir).multiplyScalar(dist); camera.lookAt(0, 0, 0);
  };
  let hoverK = 0, lastText = -1;

  const region = stage.register(el, {
    scene, camera, clearColor: COLORS.void, exposure: 1.0, order: 1,
    onResize: fit,
    onFrame: ({ dt, t, pointer, hover, region }) => {
      hoverK = damp(hoverK, hover ? 1 : 0, 4, dt);
      if (hover && pointer.inside) {
        tgt.p = clamp(-pointer.y, -1, 1) * 25 * DEG; tgt.y = clamp(pointer.x, -1, 1) * 25 * DEG; tgt.r = 0;
      } else {
        const loop = (t % 16) / 4, seg = Math.floor(loop), k = ease.inOut2(loop - seg);
        const A = poses[seg], B = poses[(seg + 1) % poses.length];
        tgt.p = lerp(A[0], B[0], k); tgt.y = lerp(A[1], B[1], k); tgt.r = lerp(A[2], B[2], k);
      }
      const lam = hover ? 5 : 2.5;
      cur.p = damp(cur.p, tgt.p, lam, dt); cur.y = damp(cur.y, tgt.y, lam, dt); cur.r = damp(cur.r, tgt.r, lam, dt);
      rig.setEuler(cur.p, cur.y, cur.r, dt);
      rig.drift(t, 0.4);
      rig.update(dt, t, hoverK);
      // the whole instrument turns slowly on its mount; the pointer adds a little parallax
      rig.root.rotation.y = 0.16 * Math.sin(t * 0.17) + (pointer.inside ? pointer.x * 0.08 * hoverK : 0);
      rig.root.rotation.x = 0.05 * Math.sin(t * 0.11);
      // projected degree labels on the rings + the attitude readout (10 Hz text updates)
      const textNow = t - lastText > 0.1;
      for (const r of rig.rings) {
        const tag = tags[r.key]; if (!tag) continue;
        projectLabel(r.marker, camera, region, tag);
        if (textNow) { tag.textContent = `${r.label} ${fmtDeg(r.angle)}`; tag.classList.toggle('is-hot', r.hot > 0.5); }
      }
      if (textNow) { lastText = t; if (readout) readout.textContent = `PITCH ${fmtDeg(cur.p)} · YAW ${fmtDeg(cur.y)} · ROLL ${fmtDeg(cur.r)}`; }
    },
    dispose: () => { rig.dispose(); disposeObject(scene); },
  });
  if (!region) return null;
  return { region, scene, camera, rig, dispose() { stage.unregister(region); } };
}

/* ================================================================== 2. DISTURBANCE AND RECOVERY stage */
function makeGust(low) {
  const dir = new THREE.Vector3(-1, -0.42, 0.25).normalize();
  const side = new THREE.Vector3(0.25, 0, 1).cross(dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, side).normalize();
  const group = new THREE.Group(); group.name = 'gust';
  const lines = [[0, 0], [1.1, 0.5], [-0.9, 0.9], [0.4, -1.2]].map(([s, u]) => {
    const a = new THREE.Vector3().addScaledVector(side, s).addScaledVector(up, u).addScaledVector(dir, -2.4);
    const b = a.clone().addScaledVector(dir, 4.8);
    const l = fatLine([a, b], { color: COLORS.accent, width: 1.2, opacity: 0, dashed: true, dashSize: 0.55, gapSize: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, low });
    group.add(l.object); return l;
  });
  group.position.copy(dir).multiplyScalar(-6.4); // upstream of the body, flowing toward it
  return {
    group, dir, lines,
    setOpacity(o) { for (const l of lines) l.setOpacity(o); group.visible = o > 0.005; },
    stream(t) { const s = (t * 5.5) % 1.2; group.position.copy(dir).multiplyScalar(-6.4 + s); },
    dispose() { for (const l of lines) l.dispose(); },
  };
}

function mountStage(stage, sectionEl) {
  if (!sectionEl) return null;
  const el = sectionEl.querySelector('[data-region="stage"]');
  if (!el) return null;
  const low = stage.tier === 'LOW';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  addLights(scene);
  const rig = buildRig(stage, { low }); scene.add(rig.root);
  const gust = makeGust(low); rig.root.add(gust.group);

  // HILS corner node + Ethernet link (lit in step 04)
  const corner = new THREE.Vector3(CAGE / 2, CAGE / 2, CAGE / 2);
  const node = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshBasicMaterial({ color: COLORS.accentHot, transparent: true, opacity: 0 }));
  node.position.copy(corner); rig.root.add(node);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeHalo(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  halo.scale.setScalar(1.6); halo.position.copy(corner); rig.root.add(halo);
  const link = fatLine([corner, new THREE.Vector3(0, 0, 0)], { color: COLORS.accent, width: 1.2, opacity: 0.85, dashed: true, dashSize: 0.28, gapSize: 0.14, draw: true, depthWrite: false, low });
  link.setDraw(0); link.object.visible = false; rig.root.add(link.object);
  const tag = el.querySelector('[data-tag="hils"]');
  const readout = el.querySelector('[data-readout]');

  const scrub = bindScrub(sectionEl, { smooth: 0.8 });
  const par = pointerParallax({ yaw: 0.06, pitch: 0.035, touch: stage.isTouch, driftPeriod: 9 });
  let dist = 20, baseElev = 0.3, lastText = -1;
  const camPos = new THREE.Vector3();
  const fit = (w, h) => {
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect; camera.fov = aspect < 1 ? 46 : 32; camera.updateProjectionMatrix();
    dist = 5.9 / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
    // desktop: the DOM steps sit in the left column, so the rig lives right of centre; portrait: steps sit at the bottom
    rig.root.position.set(aspect > 1.2 ? 2.6 : 0, aspect < 1 ? 1.4 : 0.1, 0);
  };
  const cur = { p: 0, y: 0, r: 0 };

  const region = stage.register(el, {
    scene, camera, clearColor: COLORS.void, exposure: 1.0, order: 1,
    lineMaterials: [...gust.lines, link].filter(l => l.isFat).map(l => l.material),
    onResize: fit,
    onFrame: ({ dt, t, region }) => {
      const p = scrub.update(dt);
      // --- attitude script ------------------------------------------------
      let tilt = 0, mode = 'MILS', step = 1;
      const sway = 1.5 * DEG * Math.sin(t * 0.45);
      if (p < 0.25) { tilt = 0; }
      else if (p < 0.5) { step = 2; const u = remap(p, 0.25, 0.37); tilt = 18 * DEG * ease.out4(u) + 3.5 * DEG * remap(p, 0.37, 0.5); }
      else if (p < 0.75) { step = 3; mode = 'OILS'; const u = remap(p, 0.5, 0.75); tilt = 21.5 * DEG * Math.exp(-5 * u) * Math.cos(Math.PI * 2 * 1.25 * u); }
      else { step = 4; mode = 'HILS'; tilt = 0; }
      const tp = tilt * 0.86 + sway, ty = tilt * 0.18 + 0.6 * sway, tr = tilt * 0.48;
      cur.p = damp(cur.p, tp, 9, dt); cur.y = damp(cur.y, ty, 9, dt); cur.r = damp(cur.r, tr, 9, dt);
      rig.setEuler(cur.p, cur.y, cur.r, dt);
      rig.update(dt, t, 0);
      // --- gust (step 02) ---------------------------------------------------
      const g = smoothstep(0.25, 0.3, p) * (1 - smoothstep(0.47, 0.52, p));
      gust.setOpacity(g * 0.9); if (g > 0) gust.stream(t);
      // --- HILS node + Ethernet link (step 04) ------------------------------
      const lit = smoothstep(0.75, 0.82, p);
      const pulse = 0.75 + 0.25 * Math.sin(t * 4);
      node.material.opacity = lit; node.scale.setScalar(0.8 + 0.5 * pulse * lit); halo.material.opacity = lit * 0.8 * pulse;
      const drawn = remap(p, 0.78, 0.92);
      link.object.visible = drawn > 0.001; link.setDraw(drawn);
      if (tag) { projectLabel(node, camera, region, tag); if (lit < 0.5) tag.style.opacity = '0'; tag.classList.toggle('is-hot', lit > 0.5); }
      // --- camera: slow orbit with progress + pointer parallax ---------------
      const pp = par.update(dt, t, 1);
      const yaw = -0.42 + 0.9 * p + pp.yaw, elev = baseElev + 0.08 * Math.sin(p * Math.PI) + pp.pitch;
      camPos.set(Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev)).multiplyScalar(dist);
      camera.position.copy(camPos); camera.lookAt(0, 0, 0);
      // --- SIM readout (10 Hz) ---------------------------------------------
      if (readout && t - lastText > 0.1) {
        lastText = t;
        const err = Math.abs(tilt) / DEG;
        readout.textContent = `MODE ${mode} · STEP 0${step} · PITCH ${fmtDeg(cur.p)} · ERR ${err < 10 ? '0' : ''}${err.toFixed(1)}°`;
      }
    },
    dispose: () => { scrub.kill(); par.dispose(); rig.dispose(); gust.dispose(); link.dispose(); node.geometry.dispose(); node.material.dispose(); halo.material.map.dispose(); halo.material.dispose(); disposeObject(scene); },
  });
  if (!region) { scrub.kill(); par.dispose(); return null; }
  return { region, scene, camera, rig, scrub, dispose() { stage.unregister(region); } };
}

function makeHalo() {
  const size = 64, c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,63,198,0.9)'); grd.addColorStop(0.4, 'rgba(212,18,161,0.35)'); grd.addColorStop(1, 'rgba(212,18,161,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

/* ================================================================== entry */
export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  let emblem = null, recovery = null;
  try { emblem = mountEmblem(stage, opts.emblemEl || document.querySelector('[data-region="emblem"]')); }
  catch (err) { console.warn('[scenes/saras6] emblem failed', err); }
  try { recovery = mountStage(stage, opts.stageEl || document.querySelector('section.scrub[data-scrub]')); }
  catch (err) { console.warn('[scenes/saras6] stage failed', err); }
  if (!emblem && !recovery) return null;
  return {
    emblem, recovery,
    dispose() { try { emblem && emblem.dispose(); } catch { /* noop */ } try { recovery && recovery.dispose(); } catch { /* noop */ } },
  };
}
export default mount;
