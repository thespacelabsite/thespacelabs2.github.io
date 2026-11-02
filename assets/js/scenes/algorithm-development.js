/* SpaceLabs — scenes/algorithm-development.js
   SERVICE 03 emblem: COST SURFACE.
   A 10x10 plane displaced in the vertex shader by three Gaussians, a gentle bowl and a ripple, drawn as hairline
   wireframe (#2A2A36) with ONE magenta iso-contour band around the minimum; a hot sphere descends a precomputed
   24-step gradient path with a trailing line. Idle: the descent loops; scrolling the page forces convergence.
   Readout: "STEP nn / 24" (computed from the scene, labelled SIM — no fabricated cost values).
   Exports mount(stage, opts) -> handle | null. Tier NONE: the page keeps its inline SVG fallback. */
import { THREE, COLORS, DEG, fatLine, projectLabel, damp, clamp, disposeObject } from '../gl.js';

/* ---- the cost function (JS mirror of the GLSL below; keep both in sync) */
const G = (x, y, cx, cy, s) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
const cost = (x, y) => 1.5 * G(x, y, -2.4, 1.6, 1.7) + 1.0 * G(x, y, 2.6, -2.4, 1.5) - 1.2 * G(x, y, 1.2, 1.6, 1.8)
  + 0.025 * ((x - 1.2) ** 2 + (y - 1.6) ** 2) + 0.05 * Math.sin(x * 1.3) * Math.cos(y * 1.1);
const grad = (x, y, e = 1e-3) => [(cost(x + e, y) - cost(x - e, y)) / (2 * e), (cost(x, y + e) - cost(x, y - e)) / (2 * e)];

const GLSL_COST = `
float gauss(vec2 p, vec2 c, float s) { vec2 d = p - c; return exp(-dot(d, d) / (2.0 * s * s)); }
float cost(vec2 p) {
  return 1.5 * gauss(p, vec2(-2.4, 1.6), 1.7) + 1.0 * gauss(p, vec2(2.6, -2.4), 1.5) - 1.2 * gauss(p, vec2(1.2, 1.6), 1.8)
       + 0.025 * dot(p - vec2(1.2, 1.6), p - vec2(1.2, 1.6)) + 0.05 * sin(p.x * 1.3) * cos(p.y * 1.1);
}`;
const VERT = `${GLSL_COST}
varying float vH;
void main() {
  float h = cost(position.xy);
  vH = h;
  vec3 p = vec3(position.x, h, -position.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
/* wireframe: hairline grey, tinted magenta where the wire crosses the iso height */
const FRAG_WIRE = `
uniform vec3 uLine; uniform vec3 uAccent; uniform float uIso; uniform float uOpacity;
varying float vH;
void main() {
  float band = 1.0 - smoothstep(0.012, 0.05, abs(vH - uIso));
  vec3 c = mix(uLine, uAccent, band);
  gl_FragColor = vec4(c, uOpacity + band * 0.5);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
/* solid surface pass: transparent everywhere except the single iso-contour band */
const FRAG_ISO = `
uniform vec3 uAccent; uniform float uIso;
varying float vH;
void main() {
  float band = 1.0 - smoothstep(0.0, 0.028, abs(vH - uIso));
  if (band < 0.02) discard;
  gl_FragColor = vec4(uAccent, band * 0.75);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* 24-step gradient descent with momentum from the far flank into the well (verified to converge by step ~13) */
function descentPath(steps = 24) {
  let x = -3.6, y = -3.4, vx = 0, vy = 0;
  const pts = [[x, y]];
  for (let i = 0; i < steps; i++) {
    const [gx, gy] = grad(x, y);
    let sx = -gx * 1.4, sy = -gy * 1.4;
    const L = Math.hypot(sx, sy) || 1e-6, cap = 0.6, floor = 0.1;
    if (L > cap) { sx *= cap / L; sy *= cap / L; } else if (L < floor && i < 18) { sx *= floor / L; sy *= floor / L; }
    vx = 0.45 * vx + sx; vy = 0.45 * vy + sy; x += vx; y += vy;
    pts.push([x, y]);
  }
  return pts;
}
const toWorld = ([x, y], lift = 0.05, out = new THREE.Vector3()) => out.set(x, cost(x, y) + lift, -y);

export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  const el = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!el) return null;
  try {
    const low = stage.tier === 'LOW';
    const STEPS = 24;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    const rig = new THREE.Group(); scene.add(rig);

    /* surface */
    /* the smooth iso pass uses the fine mesh; the hairline wire uses a coarser one so it reads as a grid, not a sheet */
    const div = low ? 48 : 96, wdiv = low ? 28 : 40;
    const plane = new THREE.PlaneGeometry(10, 10, div, div);
    const wirePlane = new THREE.PlaneGeometry(10, 10, wdiv, wdiv);
    const uniforms = {
      uLine: { value: new THREE.Color(COLORS.lineStrong) }, uAccent: { value: new THREE.Color(COLORS.accent) },
      uIso: { value: -0.75 }, uOpacity: { value: 0.9 },
    };
    const wireMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG_WIRE, uniforms, transparent: true, depthWrite: false });
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(wirePlane), wireMat); wire.frustumCulled = false; rig.add(wire);
    const isoMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG_ISO, uniforms: { uAccent: uniforms.uAccent, uIso: uniforms.uIso }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const iso = new THREE.Mesh(plane, isoMat); iso.frustumCulled = false; iso.renderOrder = 1; rig.add(iso);

    /* descent path + trail */
    const steps2d = descentPath(STEPS);
    const keys = steps2d.map(p => toWorld(p, 0.06));
    const curve = new THREE.CatmullRomCurve3(keys, false, 'centripetal', 0.5);
    const dense = curve.getSpacedPoints(low ? 72 : 160);
    const trail = fatLine(dense, { color: COLORS.accent, width: 1.5, opacity: 0.9, draw: true, low, depthTest: false });
    trail.object.renderOrder = 2; rig.add(trail.object);
    /* step markers: tiny dots at each iterate */
    const dotGeo = new THREE.BufferGeometry(); dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(keys.flatMap(v => [v.x, v.y, v.z]), 3));
    const dotMat = new THREE.PointsMaterial({ color: COLORS.accent, size: low ? 0.07 : 0.05, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false });
    const dots = new THREE.Points(dotGeo, dotMat); dots.renderOrder = 2; rig.add(dots);

    /* the iterate: a hot sphere with an additive halo */
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshBasicMaterial({ color: COLORS.accentHot, toneMapped: false }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    ball.renderOrder = 3; halo.renderOrder = 3; ball.add(halo); ball.position.copy(keys[0]); rig.add(ball);

    /* anchors for DOM tags */
    const startObj = new THREE.Object3D(); startObj.position.copy(keys[0]).add(new THREE.Vector3(0, 0.25, 0));
    const minObj = new THREE.Object3D(); minObj.position.copy(keys[keys.length - 1]).add(new THREE.Vector3(0.9, -0.55, 0.9));
    rig.add(startObj, minObj);
    const tagStart = el.querySelector('[data-tag="start"]'), tagMin = el.querySelector('[data-tag="min"]');
    const readout = el.querySelector('[data-readout]');

    /* framing: fit the 10x10 surface from a three-quarter elevated view, any cell aspect */
    const fit = (w, h) => {
      const aspect = w / Math.max(1, h);
      camera.aspect = aspect; camera.fov = aspect < 1 ? 46 : 34; camera.updateProjectionMatrix();
      const r = aspect < 1 ? 7.4 : 7.0;
      const d = r / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
      camera.position.set(0.95, 0.95, 1.0).normalize().multiplyScalar(d);
      camera.lookAt(0, -0.25, 0);
    };

    /* state */
    let kicked = false, yaw = 0, pitchOff = 0, p = 0, shown = 0, lastStep = -1;
    const DESCEND = 9.6, HOLD = 3.2, RESET = 1.2, PERIOD = DESCEND + HOLD + RESET;
    const cur = new THREE.Vector3().copy(keys[0]);
    const scrollP = () => { try { return clamp(window.scrollY / (window.innerHeight * 0.9)); } catch { return 0; } };
    const setStep = n => {
      if (n === lastStep) return; lastStep = n;
      if (readout) readout.textContent = `STEP ${String(n).padStart(2, '0')} / ${STEPS}`;
    };

    const region = stage.register(el, {
      scene, camera, clearColor: COLORS.void, exposure: 1.0,
      lineMaterials: trail.isFat ? [trail.material] : [],
      onResize: fit,
      onFrame: ({ dt, t, pointer, hover }) => {
        if (!kicked) { kicked = true; fit(el.clientWidth || 1, el.clientHeight || 1); }
        /* idle loop: descend over 9.6 s, hold, reset; a scrolled page forces the converged state */
        const phase = t % PERIOD;
        let idle, fade = 1;
        if (phase < DESCEND) idle = phase / DESCEND;
        else if (phase < DESCEND + HOLD) idle = 1;
        else { idle = 0; fade = 0; }
        const sp = scrollP();
        const target = Math.max(idle, sp);
        if (sp > 0.02 || idle > 0) fade = 1;
        p = target;
        const step = Math.min(STEPS, Math.floor(p * STEPS + 1e-6));
        setStep(step);
        /* ball glides to the current iterate; trail draws just behind it */
        const k = keys[step];
        cur.x = damp(cur.x, k.x, 9, dt); cur.y = damp(cur.y, k.y, 9, dt); cur.z = damp(cur.z, k.z, 9, dt);
        ball.position.copy(cur);
        shown = damp(shown, fade, 6, dt);
        ball.visible = shown > 0.03; ball.scale.setScalar(0.6 + 0.4 * shown);
        halo.scale.setScalar(1 + 0.18 * Math.sin(t * 4.2));
        trail.setDraw(shown < 0.5 && step === 0 ? 0 : (step / STEPS));
        trail.setOpacity(0.9 * shown);
        dotMat.opacity = 0.55 * shown;
        /* pointer: gentle yaw/pitch of the whole rig; slow precession otherwise */
        yaw = damp(yaw, pointer.inside ? pointer.x * 0.22 : 0, 3, dt);
        pitchOff = damp(pitchOff, pointer.inside ? -pointer.y * 0.08 : 0, 3, dt);
        rig.rotation.y = 0.035 * t + yaw;
        rig.rotation.x = pitchOff;
        uniforms.uOpacity.value = hover ? 1.0 : 0.85;
        if (tagStart) projectLabel(startObj, camera, region, tagStart);
        if (tagMin) { const r = projectLabel(minObj, camera, region, tagMin); if (step < STEPS * 0.5) tagMin.style.opacity = '0'; else if (!r.visible) tagMin.style.opacity = '0'; }
      },
      dispose: () => {
        trail.dispose(); dotGeo.dispose(); dotMat.dispose(); plane.dispose(); wirePlane.dispose(); wire.geometry.dispose(); wireMat.dispose(); isoMat.dispose();
        disposeObject(scene);
      },
    });
    if (!region) return null;
    return { region, scene, camera, get progress() { return p; }, dispose: () => stage.unregister(region) };
  } catch (err) { console.warn('[scenes/algorithm-development] mount failed', err); return null; }
}

export default mount;
