/* assets/js/scenes/simulation.js — SERVICE 05 · LOOP RING emblem
 * Five nodes (NGC MATH MODELS / ONBOARD PROCESSOR / FLIGHT SOFTWARE / SENSORS / ACTUATORS) on a torus ring,
 * three additive pulses circulating, a mode readout cycling MILS → OILS → HILS every 3 s. The mode decides which
 * nodes render metallic ("real", in the loop) and which stay wireframe ("simulated"). Scroll turns the ring so each
 * node comes to the front; hovering a .loop[data-mode] card in the page pins the mode. The same scene is painted
 * into the title emblem and (>= 1024) into the sticky cell beside the Loops cards. Built only from gl.js + three core.
 * Exports mount(stage, opts) -> handle | null. Never throws. */
import { THREE, COLORS, SUN_DIR, DEG, orbitRing, radialTexture, projectLabel, damp, lerp, disposeObject } from '../gl.js';

const NODES = [
  { key: 'models', label: 'NGC MATH MODELS' },
  { key: 'processor', label: 'ONBOARD PROCESSOR' },
  { key: 'software', label: 'FLIGHT SOFTWARE' },
  { key: 'sensors', label: 'SENSORS' },
  { key: 'actuators', label: 'ACTUATORS' },
];
// which nodes are real hardware/software in each SARAS mode (saras6.html Simulation Modes, verbatim bullets)
const MODES = {
  MILS: { real: [], note: 'ALL SIMULATED' },
  OILS: { real: ['processor', 'software'], note: 'PROCESSOR · SOFTWARE IN LOOP' },
  HILS: { real: ['processor', 'software', 'sensors', 'actuators'], note: 'PROCESSOR · SOFTWARE · SENSORS · ACTUATORS IN LOOP' },
};
const ORDER = ['MILS', 'OILS', 'HILS'];
const R = 3.2;                       // ring radius (spec)
const CYCLE = 3;                     // seconds per mode

export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  const emblemEl = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!emblemEl) return null;
  try {
    const low = stage.tier === 'LOW';
    const envMap = stage.getEnvironment ? stage.getEnvironment() : null;

    /* ---- scene */
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight(COLORS.sun, 2.2); sun.position.copy(SUN_DIR).multiplyScalar(10); scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(COLORS.atmos, 0.5); fill.position.set(-6, 2, -4); scene.add(fill);
    scene.add(new THREE.HemisphereLight(0x2A2A36, 0x050507, 0.5));
    const rig = new THREE.Group(); scene.add(rig);

    // the ring (torus in the XZ plane) + a dashed inner guide
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.02, 6, low ? 96 : 180), new THREE.MeshBasicMaterial({ color: COLORS.lineStrong }));
    ring.rotation.x = Math.PI / 2; rig.add(ring);
    const guide = orbitRing(R * 0.7, { inclination: 0, raan: 0, segments: 160, width: 1, color: COLORS.line, opacity: 0.9, dashed: true, dashSize: 0.14, gapSize: 0.1, low, depthWrite: false });
    rig.add(guide.object);
    // a faint ground disc shadow-line below the ring for depth
    const base = orbitRing(R * 1.12, { inclination: 0, raan: 0, segments: 160, width: 1, color: COLORS.line, opacity: 0.35, low, depthWrite: false });
    base.object.position.y = -0.9; rig.add(base.object);

    // five nodes
    const boxGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.44, 0.44, 0.44));
    const nodes = NODES.map((n, i) => {
      const a = -Math.PI / 2 + (i / NODES.length) * Math.PI * 2;     // node 0 starts at the front
      const g = new THREE.Group(); g.position.set(R * Math.cos(a), 0, R * Math.sin(a)); g.rotation.y = -a;
      const solidMat = new THREE.MeshStandardMaterial({ color: 0xCFD0D6, metalness: 0.9, roughness: 0.3, envMap, envMapIntensity: 0.35, transparent: true, opacity: 0 });
      const solid = new THREE.Mesh(boxGeo, solidMat); g.add(solid);
      const wire = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: COLORS.lineStrong, transparent: true, opacity: 0.9 })); g.add(wire);
      // stem down to the base disc + the label anchor above the box
      const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.22, 0), new THREE.Vector3(0, -0.9, 0)]), new THREE.LineBasicMaterial({ color: COLORS.line, transparent: true, opacity: 0.6 })); g.add(stem);
      const anchor = new THREE.Object3D(); anchor.position.y = 0.62; g.add(anchor);
      rig.add(g);
      return { ...n, group: g, solid, solidMat, wire, anchor, real: 0, target: 0, tags: [] };
    });

    // three additive pulses circulating on the ring, each with a short trailing glow (the magenta element)
    const pulseTex = radialTexture(96, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,63,198,0.95)'], [0.5, 'rgba(212,18,161,0.35)'], [1, 'rgba(212,18,161,0)']]);
    const pulses = [];
    for (let k = 0; k < 3; k++) {
      const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: pulseTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95 }));
      head.scale.setScalar(0.34);
      const tail = new THREE.Sprite(new THREE.SpriteMaterial({ map: pulseTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 }));
      tail.scale.setScalar(0.5);
      rig.add(head, tail); pulses.push({ head, tail, phase: (k / 3) * Math.PI * 2 });
    }

    /* ---- DOM hooks */
    const tagsIn = el => NODES.map(n => el.querySelector(`[data-tag="${n.key}"]`));
    const regionsDom = [emblemEl];
    const loopsEl = opts.loopsEl || document.querySelector('[data-region="ambient"][data-sim-stage]');
    if (loopsEl) regionsDom.push(loopsEl);
    for (const el of regionsDom) { const tags = tagsIn(el); nodes.forEach((n, i) => { if (tags[i]) n.tags.push(tags[i]); }); }
    const readouts = [...document.querySelectorAll('[data-sim-mode]')];
    const notes = [...document.querySelectorAll('[data-sim-note]')];
    const cards = [...document.querySelectorAll('.loop[data-mode]')];

    /* ---- mode state */
    let modeIdx = 0, modeT = 0, pinned = null, lastMode = '';
    const applyMode = name => {
      const m = MODES[name] || MODES.MILS;
      for (const n of nodes) n.target = m.real.includes(n.key) ? 1 : 0;
      if (name !== lastMode) {
        lastMode = name;
        for (const r of readouts) r.textContent = `MODE · ${name}`;
        for (const r of notes) r.textContent = m.note;
        for (const c of cards) c.classList.toggle('is-active', c.dataset.mode === name);
        try { emblemEl.setAttribute('data-sim', name); if (loopsEl) loopsEl.setAttribute('data-sim', name); } catch { /* noop */ }
      }
    };
    const pin = name => { if (!MODES[name]) return; pinned = name; modeIdx = ORDER.indexOf(name); modeT = 0; applyMode(name); stage.markDirty(); };
    const unpin = () => { pinned = null; modeT = 0; };
    const listeners = [];
    const on = (el, type, fn, o) => { el.addEventListener(type, fn, o); listeners.push(() => el.removeEventListener(type, fn, o)); };
    for (const c of cards) {
      on(c, 'pointerenter', () => pin(c.dataset.mode)); on(c, 'pointerleave', unpin);
      on(c, 'focusin', () => pin(c.dataset.mode)); on(c, 'focusout', unpin);
    }
    let cardIO = null;
    if (stage.isTouch && cards.length) {
      try {
        cardIO = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting && e.intersectionRatio >= 0.6) pin(e.target.dataset.mode); }, { threshold: [0.6] });
        for (const c of cards) cardIO.observe(c);
      } catch { cardIO = null; }
    }
    applyMode(ORDER[0]);

    /* ---- per-frame update, run once per stage frame even when two regions paint the scene */
    let lastT = -1, yaw = 0, turn = 0, yawTarget = 0;
    const camPos = new THREE.Vector3(), nodePos = new THREE.Vector3();
    const tick = (dt, t, pointer, hover) => {
      if (hover && pointer.inside) yawTarget = pointer.x * 0.25;      // whichever region the pointer is over steers the ring
      if (t === lastT) return; lastT = t;
      if (!pinned) { modeT += dt; if (modeT >= CYCLE) { modeT = 0; modeIdx = (modeIdx + 1) % ORDER.length; applyMode(ORDER[modeIdx]); } }
      for (const n of nodes) {
        n.real = damp(n.real, n.target, 5, dt);
        n.solidMat.opacity = n.real; n.solid.visible = n.real > 0.01;
        n.wire.material.opacity = lerp(0.9, 0.22, n.real);
        const s = 1 + 0.1 * n.real; n.group.scale.setScalar(s);
      }
      // pulses run the ring; faster in HILS (real-time), slowest in MILS
      const speed = pinned === 'MILS' || (!pinned && ORDER[modeIdx] === 'MILS') ? 0.55 : ORDER[modeIdx] === 'OILS' ? 0.8 : 1.05;
      for (const p of pulses) {
        const th = t * speed + p.phase; p.head.position.set(R * Math.cos(th), 0, R * Math.sin(th));
        const th2 = th - 0.14; p.tail.position.set(R * Math.cos(th2), 0, R * Math.sin(th2));
      }
      // rotation: slow idle turn + scroll (each viewport of scroll brings the next node to the front) + pointer yaw
      if (!(hover && pointer.inside)) yawTarget = damp(yawTarget, 0, 3, dt);
      yaw = damp(yaw, yawTarget, 4, dt);
      let sy = 0; try { sy = window.scrollY / Math.max(1, window.innerHeight); } catch { sy = 0; }
      turn = damp(turn, sy * (Math.PI * 2 / NODES.length), 6, dt);
      rig.rotation.y = 0.05 * t + yaw + turn;
    };

    /* ---- cameras: one per region, framed for any cell aspect (the ring seen from ~28 deg elevation) */
    const makeCamera = (margin = 1.18) => {
      const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
      const fit = (w, h) => {
        const aspect = w / Math.max(1, h);
        camera.aspect = aspect; camera.fov = aspect < 1 ? 46 : 32; camera.updateProjectionMatrix();
        // tall cells (desktop sticky columns) need extra side room for the base disc and the projected tags
        const m = aspect < 1 ? margin : Math.max(1.2, margin - 0.2);
        const d = (R * m) / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
        camera.position.set(0, Math.sin(28 * DEG), Math.cos(28 * DEG)).multiplyScalar(d); camera.lookAt(0, -0.15, 0);
      };
      fit(1, 1);
      return { camera, fit };
    };
    const frontTag = (camera, region, tags) => {
      // the node nearest the camera gets .is-front (brighter mono label)
      camera.getWorldPosition(camPos); let best = -1, bestD = Infinity;
      nodes.forEach((n, i) => { n.group.getWorldPosition(nodePos); const d = nodePos.distanceToSquared(camPos); if (d < bestD) { bestD = d; best = i; } });
      nodes.forEach((n, i) => { const tag = tags[i]; if (!tag) return; projectLabel(n.anchor, camera, region, tag); if (i === best !== tag.classList.contains('is-front')) tag.classList.toggle('is-front', i === best); });
    };

    const regions = [];
    const registerCell = (el, margin) => {
      if (!el) return null;
      const { camera, fit } = makeCamera(margin);
      const tags = tagsIn(el);
      const region = stage.register(el, {
        scene, camera, clearColor: COLORS.void, exposure: 0.95,
        lineMaterials: [guide, base].filter(l => l.isFat).map(l => l.material),
        onResize: fit,
        onFrame: ({ dt, t, pointer, hover, region }) => {
          tick(dt, t, pointer, hover);
          frontTag(camera, region, tags);
        },
      });
      if (region) regions.push(region);
      return region;
    };
    const emblem = registerCell(emblemEl, 1.42);
    const loops = loopsEl ? registerCell(loopsEl, 1.36) : null;
    if (!emblem && !loops) throw new Error('no region registered');

    const dispose = () => {
      for (const r of regions) { try { stage.unregister(r); } catch { /* noop */ } }
      for (const off of listeners) { try { off(); } catch { /* noop */ } }
      if (cardIO) { try { cardIO.disconnect(); } catch { /* noop */ } }
      try { guide.dispose(); base.dispose(); pulseTex.dispose(); boxGeo.dispose(); edgeGeo.dispose(); disposeObject(scene); } catch { /* noop */ }
    };
    return { region: emblem, loopsRegion: loops, scene, nodes, pin, unpin, get mode() { return pinned || ORDER[modeIdx]; }, dispose };
  } catch (err) { console.warn('[scenes/simulation] mount failed', err); return null; }
}
