/**
 * SpaceLabs — scenes/overview.js
 * The Company page: ONE transparent region, the TitleBlock object cell ([data-region="emblem"]),
 * painted with the shared ambient Earth (design.json threeDElements — "OVERVIEW TITLE BLOCK — AMBIENT
 * EARTH": Earth framed lower-right at exposure 0.55, the satellite orbiting, the static dim orbit guide,
 * no motif). Leadership, founders, mentors and team are DOM-only.
 *
 * mount(stage, opts) → { region, scene, camera, earth, satellite, dispose } | null
 *   - returns null on tier NONE (the page keeps its inline hairline SVG fallback)
 *   - never throws: any failure is logged and the DOM fallback stays visible
 *   - exposure eases from 0 to the target over the first ~1.6 s (a quiet entrance; HIGH/MID only)
 *   - region exposure dims slightly once the cell is more than half scrolled away (reads calmer behind the sub-nav)
 */
import { damp } from '../gl.js';
import { mountAmbient } from './index.js';

export function mount(stage, opts = {}) {
  if (!stage || stage.isNone()) return null;
  const el = opts.emblemEl || document.querySelector('[data-region="emblem"]');
  if (!el) return null;
  try {
    const target = opts.exposure ?? 0.55;
    const handle = mountAmbient(stage, el, { exposure: target, satellite: true, stars: true, spin: 2.6 });
    if (!handle || !handle.region) return null;

    const region = handle.region;
    const reduced = !!stage.reduced || stage.tier === 'LOW';
    // Entrance: start dark and ease up (skipped on LOW: a single steady frame is cheaper there).
    let cur = reduced ? target : 0;
    if (!reduced) region.exposure = 0;
    const prevFrame = region.spec.onFrame;
    region.spec.onFrame = (ctx) => {
      try { if (prevFrame) prevFrame(ctx); } catch (err) { /* the ambient scene logs its own errors */ }
      // Scroll-aware dimming: when less than 60 % of the cell is on screen, settle 25 % darker.
      const ratio = typeof region.ratio === 'number' ? region.ratio : 1;
      const want = ratio < 0.6 ? target * 0.75 : target;
      cur = reduced ? want : damp(cur, want, 2.2, ctx.dt);
      region.exposure = cur;
    };
    stage.markDirty && stage.markDirty();
    return handle;
  } catch (err) {
    console.warn('[scenes/overview] mount failed', err);
    return null;
  }
}

export default mount;
