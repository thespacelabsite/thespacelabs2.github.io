/* SpaceLabs — scenes/flight-software-development.js
 * SERVICE 04 — FLIGHT SOFTWARE · LAYER STACK emblem (title-block cell, [data-region="emblem"]).
 *
 * Five translucent planes (4 × 2.6) stacked on the vertical axis, each outlined by a hairline and carrying a
 * 256 × 160 CanvasTexture of faint procedural pseudo-code (random tokens, no real code). Scrolling the title
 * block fans the spacing 0.5 → 1.4; the ledger row nearest the viewport centre (li[data-layer]) lights the
 * matching layer's outline magenta; a 0.04 pulse sphere travels down and up the stack every 2 s. Idle only —
 * no transmission material on any tier, ~14 draw calls. Tier NONE: mount() returns null and the page keeps
 * its inline SVG fallback.
 */
import { THREE, COLORS, DEG, fatLine, radialTexture, projectLabel, bindScrub, damp, clamp, lerp, smoothstep, ease, disposeObject } from '../gl.js';

const LAYERS = ['HAL', 'RTOS', 'GNC CORE', 'MODES & FDIR', 'APPLICATIONS'];
const W = 4, D = 2.6;                 // plane width (x) and depth (z)
const SPACING_MIN = 0.5, SPACING_MAX = 1.4;

/* 256 × 160 pseudo-code texture: indented rows of rounded tokens, deterministic per seed */
function codeTexture(seed) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#12121A'; g.fillRect(0, 0, 256, 160);
  let s = (seed * 9301 + 49297) % 233280;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const rows = 13, lh = 160 / rows;
  let indent = 0;
  for (let r = 0; r < rows; r++) {
    if (rnd() < 0.16) { indent = Math.max(0, indent - 1); continue; }          // blank line
    const x0 = 12 + indent * 14;
    let x = x0;
    const n = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < n && x < 232; k++) {
      const w = 10 + Math.floor(rnd() * 36);
      const bright = rnd() < 0.22;
      g.fillStyle = bright ? 'rgba(244,244,247,0.82)' : 'rgba(160,160,174,0.55)';
      const tw = Math.min(w, 240 - x), th = Math.max(2, Math.round(lh * 0.34));
      const y = Math.round(r * lh + lh * 0.33);
      g.beginPath(); g.roundRect ? g.roundRect(x, y, tw, th, 1.5) : g.rect(x, y, tw, th); g.fill();
      x += w + 8;
    }
    const roll = rnd();
    if (roll < 0.3) indent = Math.min(3, indent + 1); else if (roll > 0.82) indent = Math.max(0, indent - 1);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

/* Tag placement: left-aligned a few px right of the projected layer edge, clamped inside the region and clear of
   the desktop chapter-nav column (same inset rule as gl.projectLabel), so a label is never clipped at the cell edge. */
let chapnavEl;
function placeTag(tag, p, region) {
  const rw = region.rect.w, rh = region.rect.h;
  if (tag._fsTxt !== tag.textContent || tag._fsRw !== rw) { tag._fsTxt = tag.textContent; tag._fsRw = rw; tag._fsW = tag.offsetWidth; tag._fsH = tag.offsetHeight; }
  if (chapnavEl === undefined) chapnavEl = document.querySelector('.chapnav');
  const pad = 12;
  const rightInset = chapnavEl && innerWidth >= 1024 ? Math.max(0, region.rect.x + rw - (innerWidth - 64)) : 0;
  const left = Math.max(pad, Math.min(p.x + 14, rw - rightInset - pad - tag._fsW));
  const top = Math.max(pad, Math.min(p.y - tag._fsH / 2, rh - pad - tag._fsH));
  tag.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
}

export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  const el = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!el) return null;
  try {
    const low = stage.tier === 'LOW';
    const revisit = document.documentElement.classList.contains('is-revisit');
    const introDur = revisit ? 0.8 : 1.4;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    const rig = new THREE.Group(); scene.add(rig);              // precesses slightly; camera stays fixed

    /* ---- layers */
    const planeGeo = new THREE.PlaneGeometry(W, D);
    const corners = [[-W / 2, 0, -D / 2], [W / 2, 0, -D / 2], [W / 2, 0, D / 2], [-W / 2, 0, D / 2]].map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const layers = LAYERS.map((name, i) => {
      const mat = new THREE.MeshBasicMaterial({ map: codeTexture(i + 3), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(planeGeo, mat); mesh.rotation.x = -Math.PI / 2; mesh.renderOrder = i;
      const edge = fatLine(corners, { color: COLORS.lineStrong, width: 1.2, opacity: 0, closed: true, low, depthWrite: false });
      edge.object.renderOrder = 10 + i;
      const holder = new THREE.Group(); holder.add(mesh, edge.object);
      const anchor = new THREE.Object3D(); anchor.position.set(W / 2, 0, -D / 2); holder.add(anchor);  // right-most (back-right) corner on screen → DOM tag
      rig.add(holder);
      return { name, i, holder, mesh, mat, edge, anchor, lit: 0, glint: 0, tag: el.querySelector(`[data-tag="l${i}"]`), tagLit: false };
    });

    /* ---- vertical track + pulse */
    const track = fatLine([new THREE.Vector3(0, -1.3, 0), new THREE.Vector3(0, 1.3, 0)], { color: COLORS.lineStrong, width: 1, opacity: 0.4, dashed: true, dashSize: 0.05, gapSize: 0.05, low, depthWrite: false });
    track.object.renderOrder = 20; rig.add(track.object);
    let trackH = -1;
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), new THREE.MeshBasicMaterial({ color: COLORS.accentHot }));
    pulse.renderOrder = 30; rig.add(pulse);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(64, [[0, 'rgba(255,63,198,0.85)'], [0.35, 'rgba(212,18,161,0.35)'], [1, 'rgba(212,18,161,0)']]),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0.9,
    }));
    halo.scale.setScalar(0.42); halo.renderOrder = 31; rig.add(halo);

    /* ---- camera framing (portrait cells on desktop and mobile; the stack sits left of centre to leave label room:
            `room` pulls the camera back and `target.x` pushes the stack left so the right-hand tags fit in the cell) */
    const camDir = new THREE.Vector3(0.9, 0.58, 1.3).normalize();
    const target = new THREE.Vector3(1.5, 0, 0);
    let aspect = 1, dist = 0, room = 1.2;
    const fit = (w, h) => {
      aspect = w / Math.max(1, h);
      room = w < 480 ? 1.12 : 1.3;
      camera.aspect = aspect; camera.fov = aspect < 0.75 ? 44 : aspect < 1.2 ? 36 : 30; camera.updateProjectionMatrix();
      dist = 0;                                                       // re-seed the dolly on the next frame
    };
    const placeCamera = (H, dt) => {
      const R = Math.sqrt(2 * 2 + 1.3 * 1.3 + (H / 2 + 0.45) * (H / 2 + 0.45)) * 1.04;
      const want = room * R / (Math.tan((camera.fov / 2) * DEG) * Math.min(1, aspect));
      dist = dist === 0 ? want : damp(dist, want, 3, dt);
      camera.position.copy(camDir).multiplyScalar(dist).add(target); camera.lookAt(target);
    };

    /* ---- scroll: fan the stack while the title block scrolls through (rect-based; the header carries no data-scrub) */
    const header = el.closest('.title') || el.parentElement;
    const scrub = bindScrub(header, { smooth: 0.8, useCore: false });

    /* ---- ledger rows → lit layer (nearest the viewport centre band), plus hover on fine pointers */
    const rows = Array.from(document.querySelectorAll('[data-layer]'));
    const ratios = new Map();
    let litIndex = -1, hoverIndex = -1, litRow = null;
    const pickRow = () => {
      let best = null, bestR = 0;
      for (const r of rows) { const v = ratios.get(r) || 0; if (v > bestR) { bestR = v; best = r; } }
      litIndex = best ? parseInt(best.dataset.layer, 10) : -1;
      if (best !== litRow) { if (litRow) litRow.classList.remove('is-lit'); if (best) best.classList.add('is-lit'); litRow = best; }
      stage.wake();
    };
    let io = null;
    try {
      io = new IntersectionObserver(entries => {
        for (const en of entries) ratios.set(en.target, en.isIntersecting ? Math.max(0.01, en.intersectionRatio) : 0);
        pickRow();
      }, { rootMargin: '-36% 0px -40% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
      rows.forEach(r => io.observe(r));
    } catch { io = null; }
    const onEnter = ev => { hoverIndex = parseInt(ev.currentTarget.dataset.layer, 10); stage.wake(); };
    const onLeave = () => { hoverIndex = -1; stage.wake(); };
    if (!stage.isTouch) rows.forEach(r => { r.addEventListener('pointerenter', onEnter); r.addEventListener('pointerleave', onLeave); });

    /* ---- frame state */
    const cLine = new THREE.Color(COLORS.lineStrong), cText = new THREE.Color(COLORS.text), cAcc = new THREE.Color(COLORS.accent), tmpC = new THREE.Color();
    const pA = new THREE.Vector3(), pB = new THREE.Vector3();
    let intro = 0, spacing = SPACING_MIN, yaw = 0, lastActive = -2;

    const region = stage.register(el, {
      scene, camera, clearColor: COLORS.void, exposure: 1.0, order: 1,
      lineMaterials: [track, ...layers.map(l => l.edge)].filter(l => l.isFat).map(l => l.material),
      onResize: fit,
      onFrame: ({ dt, t, pointer, hover, region }) => {
        intro = Math.min(1, intro + dt / introDur);
        const e = ease.reveal(intro);
        const p = scrub.update(dt);
        const want = lerp(SPACING_MIN, SPACING_MAX, p) + (hover ? 0.1 : 0) + 0.02 * Math.sin(t * 0.7);
        spacing = damp(spacing, want, 3.5, dt);
        const sp = spacing * (0.3 + 0.7 * e);
        const H = 4 * sp, y0 = -H / 2;

        yaw = damp(yaw, pointer.inside ? pointer.x * 0.16 : 0, 4, dt);
        rig.rotation.y = 0.06 * Math.sin(t * 0.22) + yaw;
        rig.rotation.x = 0.015 * Math.sin(t * 0.17);

        // pulse: down and up the stack every 2 s
        const ph = (t % 2) / 2, s = ph < 0.5 ? ph * 2 : 2 - ph * 2, se = smoothstep(0, 1, s);
        const py = lerp(y0 - 0.12, y0 + H + 0.12, se);
        pulse.position.y = py; halo.position.y = py;
        pulse.visible = halo.visible = intro > 0.4;
        halo.material.opacity = 0.9 * e;

        const active = hoverIndex >= 0 ? hoverIndex : litIndex;
        for (const L of layers) {
          const y = y0 + L.i * sp; L.holder.position.y = y;
          const near = 1 - clamp(Math.abs(py - y) / 0.22);
          L.glint = Math.max(L.glint * Math.exp(-dt * 3.5), near);
          L.lit = damp(L.lit, L.i === active ? 1 : 0, 7, dt);
          tmpC.copy(cLine).lerp(cText, L.glint * 0.55).lerp(cAcc, L.lit);
          L.edge.setColor(tmpC); L.edge.setOpacity((0.8 + 0.2 * L.lit) * e);
          if (L.edge.isFat) L.edge.material.linewidth = 1.2 + 0.7 * L.lit;
          L.mat.opacity = (0.46 + 0.22 * L.lit + 0.08 * L.glint) * e;
          if (L.tag) {
            placeTag(L.tag, projectLabel(L.anchor, camera, region, L.tag), region);
            if (intro < 0.35) L.tag.style.opacity = '0';
          }
        }
        if (active !== lastActive) {
          lastActive = active;
          for (const L of layers) if (L.tag) { const on = L.i === active; if (on !== L.tagLit) { L.tagLit = on; L.tag.classList.toggle('is-lit', on); } }
        }
        if (Math.abs(trackH - H) > 0.003) { trackH = H; track.setPoints([pA.set(0, y0 - 0.32, 0), pB.set(0, y0 + H + 0.32, 0)]); }
        track.setOpacity(0.4 * e);
        placeCamera(H, dt);
      },
      dispose: () => {
        try { scrub.kill(); } catch { /* noop */ }
        try { if (io) io.disconnect(); } catch { /* noop */ }
        rows.forEach(r => { r.removeEventListener('pointerenter', onEnter); r.removeEventListener('pointerleave', onLeave); r.classList.remove('is-lit'); });
        for (const L of layers) { try { L.edge.dispose(); L.mat.map && L.mat.map.dispose(); L.mat.dispose(); if (L.tag) { L.tag.style.opacity = '0'; L.tag.classList.remove('is-lit'); } } catch { /* noop */ } }
        try { track.dispose(); planeGeo.dispose(); pulse.geometry.dispose(); pulse.material.dispose(); halo.material.map && halo.material.map.dispose(); halo.material.dispose(); } catch { /* noop */ }
        disposeObject(scene);
      },
    });
    return region ? { region, scene, camera, layers, dispose: () => stage.unregister(region) } : null;
  } catch (err) {
    console.warn('[scenes/flight-software-development] mount failed', err);
    return null;
  }
}

export default mount;
