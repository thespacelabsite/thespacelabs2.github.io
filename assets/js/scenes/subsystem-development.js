/* assets/js/scenes/subsystem-development.js — EXPLODED NGC BLOCK emblem (SERVICE 02 — SYSTEM DEVELOPMENT)
 * Four metallic slabs (SENSORS / FLIGHT COMPUTER / NGC · ADCS SOFTWARE / ACTUATOR DRIVE) with emissive magenta
 * connectors between them. Assembled at rest; explodes along Y (+0.6 per slab, staggered, expo-out) as the
 * capabilities ledger scrolls into view and re-assembles on scroll back; a hover over the cell explodes it fully;
 * on touch the in-view cell runs a slow scripted loop. A small magenta pulse travels sensors → actuator.
 * Built only from gl.js factories + three core. Exports mount(stage, opts) -> handle | null. Never throws. */
import { THREE, COLORS, DEG, wireGrid, projectLabel, damp, clamp, smoothstep, ease, disposeObject } from '../gl.js';

const SLAB = { w: 2.4, h: 0.18, d: 1.6 };
const REST_GAP = 0.08;          // face-to-face gap when assembled
const EXPLODE = 0.6;            // extra travel per slab when exploded (spec)
const LAYERS = 4;
/* label anchors: out from each slab's right face, angled back so the tag clears the stack's back corner */
const ANCHOR = { x: SLAB.w / 2 + 0.75, z: -0.42 };
const LEAD0 = { x: SLAB.w / 2 + 0.04, z: -0.02 };
const LEAD1 = { x: SLAB.w / 2 + 0.68, z: -0.38 };
/* horizontal screen-space extent of the stack + anchors (world units, rig at rest): left corner / anchor */
const EXTENT = { left: 1.55, right: 1.85 };
const VIEW_DIR = new THREE.Vector3(1.0, 0.78, 1.35).normalize();
const VIEW_RIGHT = new THREE.Vector3(VIEW_DIR.z, 0, -VIEW_DIR.x).normalize();   // camera right vector for this view

export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;                                  // tier NONE: the page keeps its inline SVG
  const el = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!el) return null;
  try {
    const low = stage.tier === 'LOW';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);

    /* lights stay fixed; everything that yaws lives in the rig */
    const sun = new THREE.DirectionalLight(COLORS.sun, 2.4); sun.position.set(3, 6, 2.5); scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(COLORS.atmos, 0.45); fill.position.set(-4, 1.5, -3); scene.add(fill);
    scene.add(new THREE.HemisphereLight(0x2A2A36, 0x050507, 0.6));
    const core = new THREE.PointLight(COLORS.accent, 0, 5, 2); scene.add(core);       // glows from inside the exploded stack
    const rig = new THREE.Group(); scene.add(rig);

    /* materials + shared geometries */
    const envMap = stage.getEnvironment ? stage.getEnvironment() : null;
    const slabMat = new THREE.MeshStandardMaterial({ color: 0xCFD0D6, metalness: 0.9, roughness: 0.3, envMap, envMapIntensity: 0.35 });
    const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.lineStrong, transparent: true, opacity: 0.9 });
    const leadMat = new THREE.LineBasicMaterial({ color: COLORS.lineStrong, transparent: true, opacity: 0.8 });
    const conMat = new THREE.MeshStandardMaterial({ color: COLORS.accentDeep, emissive: COLORS.accent, emissiveIntensity: 2.2, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0, depthWrite: false });
    const pulseMat = new THREE.MeshBasicMaterial({ color: COLORS.accentHot, transparent: true, opacity: 0 });
    const slabGeo = new THREE.BoxGeometry(SLAB.w, SLAB.h, SLAB.d);
    const edgeGeo = new THREE.EdgesGeometry(slabGeo);
    const conGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, low ? 6 : 10, 1);
    const pulseGeo = new THREE.SphereGeometry(0.04, low ? 8 : 12, low ? 6 : 10);

    /* slabs, bottom (sensors) to top (actuator drive) */
    const slabs = [], anchors = [], tags = [];
    const restY = i => (i - (LAYERS - 1) / 2) * (SLAB.h + REST_GAP);
    for (let i = 0; i < LAYERS; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(slabGeo, slabMat));
      g.add(new THREE.LineSegments(edgeGeo, edgeMat));
      g.position.y = restY(i);
      rig.add(g); slabs.push(g);
      const a = new THREE.Object3D(); a.position.set(ANCHOR.x, 0, ANCHOR.z); g.add(a); anchors.push(a);   // label anchor: the tag's text starts here
      tags.push(el.querySelector(`[data-tag="l${i}"]`));
    }
    /* leader hairlines: slab edge -> label anchor (one LineSegments, positions refreshed per frame) */
    const leadPos = new Float32Array(LAYERS * 2 * 3);
    const leadGeo = new THREE.BufferGeometry(); leadGeo.setAttribute('position', new THREE.BufferAttribute(leadPos, 3));
    const leaders = new THREE.LineSegments(leadGeo, leadMat); leaders.frustumCulled = false; rig.add(leaders);
    /* connectors: two emissive cylinders per gap at x = ±0.75 */
    const cons = [];
    for (let i = 0; i < LAYERS - 1; i++) {
      for (const sx of [-0.75, 0.75]) {
        const m = new THREE.Mesh(conGeo, conMat); m.position.set(sx, 0, 0); m.renderOrder = 1; rig.add(m); cons.push({ mesh: m, gap: i });
      }
    }
    /* signal pulse travelling up the +x connectors */
    const pulse = new THREE.Mesh(pulseGeo, pulseMat); pulse.position.x = 0.75; rig.add(pulse);
    /* ground grid */
    const grid = wireGrid(7, 14, { color: COLORS.line, opacity: 0.7 }); grid.position.y = -1.95; rig.add(grid);

    /* camera: frame the exploded stack AND its right-reading tags for any cell aspect.
       The tags start at the anchors and run right, so the view is pulled back until stack + longest tag fit,
       then shifted so the pair is centred (with the desktop chapter-nav column kept clear). */
    const _look = new THREE.Vector3();
    const fit = (w, h) => {
      const aspect = w / Math.max(1, h);
      camera.aspect = aspect; camera.fov = aspect < 1 ? 42 : 30; camera.updateProjectionMatrix();
      const base = 2.35 / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
      const hw = 2.35 * Math.max(1, aspect);                                 // visible half-width at the stack (world units)
      let lblPx = 0; for (const tg of tags) if (tg) lblPx = Math.max(lblPx, tg.offsetWidth / 2);   // box = 2x text (::before spacer)
      lblPx += 18 + (window.innerWidth >= 1024 ? 64 : 0);                   // clamp pad + chapter-nav column
      const L = lblPx * 2 * hw / Math.max(1, w);                             // tag length in world units at zoom 1
      const span = EXTENT.left + EXTENT.right;
      const s = Math.max(1, span / Math.max(0.5, 1.8 * hw - L));
      const shift = (EXTENT.right + L * s - EXTENT.left) / 2;
      _look.copy(VIEW_RIGHT).multiplyScalar(shift); _look.y = -0.05;
      camera.position.copy(VIEW_DIR).multiplyScalar(base * s).add(_look); camera.lookAt(_look);
    };

    /* scroll driver: the capabilities ledger entering the viewport explodes the block (re-assembles on scroll back) */
    const ledger = document.getElementById(opts.ledgerId || 'capabilities');
    let dirty = true, scrollX = 0;
    const onScroll = () => { dirty = true; };
    window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll);

    let x = 0, yaw = 0, pitch = 0, kicked = false;
    const _a = new THREE.Vector3();
    const region = stage.register(el, {
      scene, camera, clearColor: COLORS.void, exposure: 1.0,
      onResize: fit,
      onFrame: ({ dt, t, pointer, hover, active, region }) => {
        if (!kicked) { kicked = true; }
        if (dirty && ledger) {
          dirty = false;
          const r = ledger.getBoundingClientRect(); const vh = window.innerHeight || 1;
          scrollX = smoothstep(vh * 0.95, vh * 0.4, r.top);                    // 0 below the fold -> 1 as the ledger reaches 40 % of the viewport
        }
        const idle = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin(t * 0.6));             // "assembled at rest" with a faint breath
        const loop = stage.isTouch && active ? 0.5 - 0.5 * Math.cos(t * 0.45) : 0;   // touch: slow scripted explode/assemble
        const target = Math.max(scrollX, hover ? 1 : 0, loop, idle);
        x = damp(x, target, 2.4, dt);

        /* slab positions (staggered expo-out) + connectors */
        for (let i = 0; i < LAYERS; i++) {
          const e = ease.out4(clamp((x - i * 0.08) / 0.76));
          slabs[i].position.y = restY(i) + e * EXPLODE * (i - (LAYERS - 1) / 2);
        }
        for (const c of cons) {
          const lo = slabs[c.gap].position.y + SLAB.h / 2, hi = slabs[c.gap + 1].position.y - SLAB.h / 2;
          const len = Math.max(0.001, hi - lo);
          c.mesh.position.y = (lo + hi) / 2; c.mesh.scale.y = len;
          c.mesh.visible = len > REST_GAP + 0.02;
        }
        conMat.opacity = clamp((x - 0.12) / 0.5);
        core.intensity = 2.2 * clamp((x - 0.1) / 0.6);
        /* leaders follow the slabs */
        for (let i = 0; i < LAYERS; i++) {
          const y = slabs[i].position.y, o = i * 6;
          leadPos[o] = LEAD0.x; leadPos[o + 1] = y; leadPos[o + 2] = LEAD0.z;
          leadPos[o + 3] = LEAD1.x; leadPos[o + 4] = y; leadPos[o + 5] = LEAD1.z;
        }
        leadGeo.attributes.position.needsUpdate = true;
        /* pulse: sensors -> actuator every 2.4 s while exploded */
        const ph = (t % 2.4) / 2.4;
        const y0 = slabs[0].position.y, y3 = slabs[LAYERS - 1].position.y;
        pulse.position.y = y0 + (y3 - y0) * ph;
        const vis = clamp((x - 0.25) / 0.4) * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
        pulseMat.opacity = vis; pulse.visible = vis > 0.02;
        pulse.scale.setScalar(0.8 + 0.6 * vis);
        /* gentle yaw oscillation + pointer parallax (labels stay on the right) */
        yaw = damp(yaw, pointer.inside ? pointer.x * 0.12 : 0, 4, dt);
        pitch = damp(pitch, pointer.inside ? -pointer.y * 0.08 : 0, 4, dt);
        rig.rotation.y = 0.16 * Math.sin(t * 0.18) + yaw;   // kept small so the tags stay clear of the stack
        rig.rotation.x = pitch;
        /* projected DOM tags */
        for (let i = 0; i < LAYERS; i++) if (tags[i]) projectLabel(anchors[i], camera, region, tags[i]);
      },
      dispose: () => {
        window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll);
        slabGeo.dispose(); edgeGeo.dispose(); conGeo.dispose(); pulseGeo.dispose(); leadGeo.dispose();
        slabMat.dispose(); edgeMat.dispose(); leadMat.dispose(); conMat.dispose(); pulseMat.dispose();
        disposeObject(scene);
      },
    });
    if (!region) return null;
    return {
      region, scene, camera,
      setExplode(v) { scrollX = clamp(v); dirty = false; stage.wake(); },      // debug / screenshots
      get explode() { return x; },
      dispose: () => stage.unregister(region),
    };
  } catch (err) { console.warn('[scenes/subsystem-development] mount failed', err); return null; }
}
