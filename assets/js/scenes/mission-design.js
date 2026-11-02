/* SpaceLabs — scenes/mission-design.js
   TRANSFER ARC emblem for mission-design.html (SERVICE 01).
   Earth (radius 1.4) inside two coplanar circular orbits (radii 3 and 6, Line2 hairlines), a Hohmann
   transfer half-ellipse drawn by an emissive ribbon as a vehicle marker flies it, brief plume bursts at
   departure (ΔV₁) and arrival (ΔV₂), the unflown half of the ellipse as a dashed ghost, a faint ground grid,
   and three mono DOM tags (ΔV₁ · ΔV₂ · TOF — labels only) positioned with gl.projectLabel.
   Idle: slow 0.05 rad/s precession; pointer adds a little yaw; page scroll adds a little more.
   Mounted on [data-region="emblem"] through the shared stage (one WebGL context per page). */
import { THREE, COLORS, SUN_DIR, DEG, earth, orbitRing, ribbon, fatLine, wireGrid, plume, projectLabel, damp, clamp, smoothstep, disposeObject } from '../gl.js';

const R_EARTH = 1.4, R_IN = 3.0, R_OUT = 6.0, PLUME_SCALE = 6;
const CYCLE = 15;                 // seconds per transfer loop
const FLY_END = 0.58, HOLD_END = 0.9; // phases of the loop (fly → hold → rewind)

const easeInOut = x => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const burst = (u, a, b) => smoothstep(a, a + (b - a) * 0.25, u) * (1 - smoothstep(a + (b - a) * 0.55, b, u));

export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;                 // tier NONE: the page keeps its inline SVG
  const el = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!el) return null;
  try {
    const low = stage.tier === 'LOW';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    const sun = new THREE.DirectionalLight(COLORS.sun, 2.4); sun.position.copy(SUN_DIR).multiplyScalar(30); scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x1B2A4A, 0x000000, 0.2));
    const rig = new THREE.Group(); scene.add(rig);           // everything that precesses lives here

    // Earth, scaled to radius 1.4 (spec); textures only after the first painted frame
    const e = earth(stage, { clouds: false, segments: low ? 40 : 64 });
    e.spinSpeed = 0.02; e.group.scale.setScalar(R_EARTH); rig.add(e.group);

    // ground grid for depth
    const grid = wireGrid(16, 16, { color: COLORS.line, opacity: 0.45 }); grid.position.y = -2.6; rig.add(grid);

    // the two coplanar circular orbits (shared e1/e2 basis)
    const ringOpts = { inclination: 7, raan: 24, width: 1.2, color: COLORS.lineStrong, opacity: 0.75, low, segments: low ? 128 : 256 };
    const inner = orbitRing(R_IN, ringOpts), outer = orbitRing(R_OUT, ringOpts);
    rig.add(inner.object, outer.object);

    // Hohmann half-ellipse: periapsis on +e1 (inner), apoapsis on −e1 (outer)
    const c = (R_OUT - R_IN) / 2, a = (R_OUT + R_IN) / 2, b = Math.sqrt(a * a - c * c);
    const ellipsePt = th => inner.e1.clone().multiplyScalar(-c + a * Math.cos(th)).addScaledVector(inner.e2, b * Math.sin(th));
    const N = 48, pts = []; for (let i = 0; i <= N; i++) pts.push(ellipsePt((i / N) * Math.PI));
    const arc = ribbon(pts, { radius: 0.03, segments: low ? 80 : 160, radial: low ? 6 : 8, twin: !low, twinRadius: 0.1, twinOpacity: 0.07, progress: 0 });
    rig.add(arc.group);
    // unflown half (return leg) as a dashed ghost, dimmer
    const ghostPts = []; for (let i = 0; i <= N; i++) ghostPts.push(ellipsePt(Math.PI + (i / N) * Math.PI));
    const ghost = fatLine(ghostPts, { color: COLORS.lineStrong, width: 1, opacity: 0.28, dashed: true, dashSize: 0.16, gapSize: 0.1, low }); rig.add(ghost.object);

    // vehicle speck + plume (scaled wrapper: plume() is authored for a radius-1 scene)
    const ship = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 12), new THREE.MeshBasicMaterial({ color: COLORS.accentHot })); rig.add(ship);
    const pl = plume({ jitter: true }); const plWrap = new THREE.Group(); plWrap.scale.setScalar(PLUME_SCALE); plWrap.add(pl.group); rig.add(plWrap);
    pl.setOpacity(0);

    // tag anchors
    const dep = new THREE.Object3D(); dep.position.copy(pts[0]);
    const arr = new THREE.Object3D(); arr.position.copy(pts[N]);
    const apex = new THREE.Object3D(); apex.position.copy(ellipsePt(Math.PI / 2)).multiplyScalar(1.06);
    rig.add(dep, arr, apex);
    const tagDep = el.querySelector('[data-tag="dv1"]'), tagArr = el.querySelector('[data-tag="dv2"]'), tagTof = el.querySelector('[data-tag="tof"]');

    const fit = (w, h) => {                                   // frame the outer orbit for any cell aspect
      const aspect = w / Math.max(1, h);
      camera.aspect = aspect; camera.fov = aspect < 1 ? 46 : 34; camera.updateProjectionMatrix();
      const d = (R_OUT + 1.8) / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
      camera.position.set(0.5, 1.7, 2.4).normalize().multiplyScalar(d); camera.lookAt(0, -0.2, 0);
    };

    const head = new THREE.Vector3(), tan = new THREE.Vector3(), headL = new THREE.Vector3();
    let kicked = false, yaw = 0, t0 = -1, drawn = 0, scrollYaw = 0;
    const scrollKick = () => { scrollYaw = clamp(window.scrollY / Math.max(1, window.innerHeight), 0, 2) * 0.35; };

    const region = stage.register(el, {
      scene, camera, clearColor: COLORS.void, exposure: 0.9,
      lineMaterials: [inner, outer, ghost].filter(l => l.isFat).map(l => l.material),  // stage keeps LineMaterial.resolution = cell size
      onResize: fit,
      onFrame: ({ dt, t, pointer, hover, region }) => {
        if (!kicked) { kicked = true; t0 = t; setTimeout(() => e.loadTextures(), 80); }
        e.update(dt, stage.quality);

        // transfer loop: fly 0→1 (eased), hold, rewind; hover holds the drawn arc
        const ph = ((t - t0) % CYCLE) / CYCLE;
        let target;
        if (ph < FLY_END) target = easeInOut(ph / FLY_END);
        else if (ph < HOLD_END || hover) target = 1;
        else target = 1 - (ph - HOLD_END) / (1 - HOLD_END);
        const flying = ph < FLY_END && !hover;
        drawn = flying ? target : damp(drawn, target, flying ? 30 : 6, dt);
        const u = clamp(drawn);
        arc.setProgress(u);

        // vehicle + plume bursts at departure / arrival
        arc.getPoint(u, head); arc.getTangent(u, tan);
        ship.position.copy(head); ship.visible = u > 0.002 && u < 0.998 || flying;
        const o = flying ? Math.max(burst(u, 0, 0.14), burst(u, 0.86, 1)) : 0;
        pl.setOpacity(o);
        if (o > 0.01) { headL.copy(head).divideScalar(PLUME_SCALE); pl.update(t, headL, tan); }

        // precession + pointer yaw + a little scroll
        yaw = damp(yaw, pointer.inside ? pointer.x * 0.22 : 0, 4, dt);
        rig.rotation.y = 0.05 * t + yaw + scrollYaw;

        // mono tags (labels only), sequenced with the flight
        if (tagDep) { projectLabel(dep, camera, region, tagDep); }
        if (tagArr) { const r = projectLabel(arr, camera, region, tagArr); tagArr.style.opacity = r.visible && u > 0.84 ? '1' : '0'; }
        if (tagTof) { const r = projectLabel(apex, camera, region, tagTof); tagTof.style.opacity = r.visible && u > 0.42 ? '1' : '0'; }
      },
      dispose: () => {
        removeEventListener('scroll', scrollKick);
        e.dispose(); arc.dispose(); ghost.dispose(); inner.dispose(); outer.dispose(); pl.dispose();
        ship.geometry.dispose(); ship.material.dispose(); disposeObject(scene);
      },
    });
    if (!region) return null;
    addEventListener('scroll', scrollKick, { passive: true }); scrollKick();
    return { region, scene, camera, earth: e, arc, dispose: () => stage.unregister(region) };
  } catch (err) { console.warn('[scenes/mission-design] mount failed', err); return null; }
}

export default mount;
