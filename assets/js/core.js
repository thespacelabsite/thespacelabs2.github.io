/* ==========================================================================
   SpaceLabs — core.js  (ES module, no bundler)
   DOM behaviour layer: shutter, CommandBar, MobileOverlay, Lenis+ScrollTrigger
   wiring, reveals (.rv-* / data-*), scrub progress, ChapterNav, LocalTime,
   LaunchButton + crew-manifest easter egg, dialogs, motion toggle, debug.
   Degrades gracefully when GSAP / Lenis / SplitType fail to load.
   Public API: window.SL (also the default export) — see apiSummary.
   ========================================================================== */

const doc = document;
const root = doc.documentElement;
const win = window;
const qs = (s, c = doc) => c.querySelector(s);
const qsa = (s, c = doc) => Array.from(c.querySelectorAll(s));
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const expoOut = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
const power2Out = (t) => 1 - (1 - t) * (1 - t);
const NAV_OFFSET = 72;

/* ---------- storage (never throws) --------------------------------------- */
const store = {
  get(k, s = 'local') { try { return (s === 'session' ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
  set(k, v, s = 'local') { try { (s === 'session' ? sessionStorage : localStorage).setItem(k, v); } catch { /* private mode */ } },
  del(k, s = 'local') { try { (s === 'session' ? sessionStorage : localStorage).removeItem(k); } catch { /* noop */ } },
};

/* ---------- library guards ---------------------------------------------- */
const lib = {
  get gsap() { return typeof win.gsap !== 'undefined' ? win.gsap : null; },
  get ScrollTrigger() { return typeof win.ScrollTrigger !== 'undefined' ? win.ScrollTrigger : null; },
  get CustomEase() { return typeof win.CustomEase !== 'undefined' ? win.CustomEase : null; },
  get Lenis() { return typeof win.Lenis === 'function' ? win.Lenis : null; },
  get SplitType() { return typeof win.SplitType === 'function' ? win.SplitType : null; },
};

/* ---------- matchMedia branches ------------------------------------------ */
const mq = (q) => (win.matchMedia ? win.matchMedia(q) : { matches: false, addEventListener() {} });
const motionPref = store.get('sl-motion'); // 'on' | 'off' | null
const motion = {
  prefersReduced: mq('(prefers-reduced-motion: reduce)').matches,
  pref: motionPref,
  touch: mq('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !mq('(pointer: fine)').matches),
  fine: mq('(pointer: fine)').matches,
  hover: mq('(hover: hover)').matches,
  desktop: mq('(min-width: 1024px)').matches,
  reduced: false,
  on: true,
};
motion.reduced = motionPref === 'off' || (motion.prefersReduced && motionPref !== 'on');
motion.on = !motion.reduced;

/* ---------- events -------------------------------------------------------- */
const emit = (name, detail = {}) => { try { win.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* noop */ } };

/* ---------- public object -------------------------------------------------- */
const scrubs = new Map();     // el -> { progress, listeners:Set }
const splitRegistry = new Set();
let lenis = null;
let debugPanel = null;
const debugLines = new Map();

export const SL = {
  version: '20261030',
  motion,
  lib,
  get lenis() { return lenis; },
  ease: { reveal: 'expo.out', camera: 'power2.inOut', ignite: 'back.out(1.6)', settle: 'power2.out' },
  scrollTo, onScrub, offScrub, progress: getProgress, setProgress,
  split: splitElement, resplit: resplitAll, reveal: observeReveals,
  dialog: { open: openDialog, close: closeDialog },
  shutter: { out: shutterOut, lift: shutterLift },
  debug: { set: debugSet },
  emit,
  ready: null,
  init,
};
win.SL = SL;

/* ==========================================================================
   INIT
   ========================================================================== */
let booted = false;
export function init() {
  if (booted) return SL;
  booted = true;
  const steps = [
    ['flags', initFlags], ['shutter', initShutter], ['year', initYear], ['clock', initClock],
    ['gsap', initGsap], ['lenis', initLenis], ['nav', initCommandBar], ['overlay', initOverlay],
    ['anchors', initAnchors], ['scrubs', initScrubs], ['reveals', initReveals], ['chapnav', initChapterNav],
    ['parallax', initParallax], ['tilt', initTilt], ['dialogs', initDialogs], ['launch', initLaunch],
    ['motionToggle', initMotionToggle], ['resize', initResize], ['debug', initDebug], ['transitions', initTransitions],
  ];
  for (const [name, fn] of steps) {
    try { fn(); } catch (err) { console.warn(`[core] ${name} failed`, err); }
  }
  root.classList.add('is-core-ready');
  emit('sl:ready', { SL });
  return SL;
}
export default SL;

/* ==========================================================================
   1. FLAGS
   ========================================================================== */
function initFlags() {
  root.classList.remove('no-js');
  root.classList.add('js');
  root.classList.toggle('is-touch', motion.touch);
  root.classList.toggle('is-fine', motion.fine && !motion.touch);
  root.classList.toggle('is-reduced', motion.reduced);
  root.dataset.motion = motion.reduced ? 'off' : 'on';
  if (store.get('sl-visited', 'session')) root.classList.add('is-revisit');
  store.set('sl-visited', '1', 'session');
  const onFirstScroll = () => { if ((win.scrollY || 0) > 10) { root.classList.add('is-scrolled'); win.removeEventListener('scroll', onFirstScroll); } };
  win.addEventListener('scroll', onFirstScroll, { passive: true });
  onFirstScroll();
}

/* ==========================================================================
   2. SHUTTER (preloader + page transition)
   ========================================================================== */
let shutterEl = null;
function initShutter() {
  shutterEl = qs('.shutter');
  if (!shutterEl) return;
  const code = qs('.shutter__code', shutterEl);
  const stored = store.get('sl-shutter', 'session');
  if (stored) store.del('sl-shutter', 'session');
  if (code) code.textContent = stored || doc.body.dataset.code || code.textContent || 'SPACELABS';
  // bfcache: never replay
  win.addEventListener('pageshow', (e) => { if (e.persisted) shutterLift(true); });
  const hard = setTimeout(() => shutterLift(true), 800);
  fontsReady(400).then(() => { clearTimeout(hard); shutterLift(); });
}
function shutterLift(instant = false) {
  if (!shutterEl) return;
  shutterEl.classList.remove('is-armed', 'is-out');
  if (instant) shutterEl.style.transition = 'none';
  shutterEl.classList.add('is-done');
  shutterEl.setAttribute('aria-hidden', 'true');
  if (instant) requestAnimationFrame(() => { shutterEl.style.transition = ''; });
  emit('sl:shutter', { state: 'done' });
}
function shutterOut(code, href) {
  const run = () => {
    store.set('sl-shutter', code || 'SPACELABS', 'session');
    if (lenis) { try { lenis.stop(); } catch { /* noop */ } }
    if (!shutterEl) { win.location.assign(href); return; }
    const label = qs('.shutter__code', shutterEl);
    if (label) label.textContent = code || 'SPACELABS';
    shutterEl.classList.remove('is-done');
    shutterEl.classList.add('is-armed');
    // force style flush, then wipe up
    void shutterEl.offsetHeight;
    shutterEl.classList.remove('is-armed');
    shutterEl.classList.add('is-out');
    emit('sl:shutter', { state: 'out', code, href });
    setTimeout(() => win.location.assign(href), motion.reduced ? 150 : 450);
    // safety: if navigation is blocked, free the page
    setTimeout(() => shutterLift(true), 2500);
  };
  run();
}
function fontsReady(cap = 1500) {
  const fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
  return Promise.race([fonts.catch(() => {}), new Promise((r) => setTimeout(r, cap))]);
}

/* ==========================================================================
   3. YEAR · CLOCK (LocalTime)
   ========================================================================== */
function initYear() {
  const y = String(new Date().getFullYear());
  qsa('[data-year], #current-year').forEach((el) => { el.textContent = y; });
}
function initClock() {
  const clocks = qsa('.clock, [data-clock]');
  if (!clocks.length) return;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return; }
  const tick = () => {
    const now = new Date();
    let t = fmt.format(now).replace(/^24/, '00');
    const iso = now.toISOString();
    clocks.forEach((el) => {
      const prefix = el.dataset.clockPrefix ?? 'THIRUVANANTHAPURAM · ';
      const suffix = el.dataset.clockSuffix ?? ' IST';
      el.textContent = `${prefix}${t}${suffix}`;
      if (el.tagName === 'TIME') el.setAttribute('datetime', iso);
    });
  };
  tick();
  if (!motion.reduced) setInterval(tick, 1000);
}

/* ==========================================================================
   4. GSAP + LENIS WIRING (mandatory per spec)
   ========================================================================== */
function initGsap() {
  const g = lib.gsap;
  if (!g) return;
  if (lib.ScrollTrigger) {
    g.registerPlugin(lib.ScrollTrigger);
    lib.ScrollTrigger.config({ ignoreMobileResize: true });
  }
  if (lib.CustomEase) {
    try {
      g.registerPlugin(lib.CustomEase);
      lib.CustomEase.create('reveal', 'M0,0 C0.16,1 0.3,1 1,1');
      SL.ease.reveal = 'reveal';
    } catch { /* keep expo.out */ }
  }
}
function initLenis() {
  const L = lib.Lenis;
  if (!L || motion.reduced || motion.touch || !motion.fine) return;
  lenis = new L({ lerp: 0.09, wheelMultiplier: 1.0, smoothWheel: true, syncTouch: false });
  root.classList.add('has-lenis');
  const g = lib.gsap, ST = lib.ScrollTrigger;
  if (g && ST) {
    lenis.on('scroll', ST.update);
    g.ticker.add((t) => lenis.raf(t * 1000));
    g.ticker.lagSmoothing(0);
  } else {
    const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }
  // Lenis handles hash links itself only if told; we route through scrollTo()
}
function scrollTo(target, opts = {}) {
  const el = typeof target === 'string' ? (target === '#' || target === 'top' ? 0 : qs(target)) : target;
  if (el === null || el === undefined) return;
  const offset = opts.offset ?? -NAV_OFFSET;
  if (lenis) {
    lenis.scrollTo(el, { offset, duration: opts.duration ?? 1.2, easing: expoOut, lock: false, ...opts });
    return;
  }
  const top = typeof el === 'number' ? el : el.getBoundingClientRect().top + win.scrollY + offset;
  try { win.scrollTo({ top, behavior: motion.reduced ? 'auto' : 'smooth' }); } catch { win.scrollTo(0, top); }
}
const normPath = (p) => p.replace(/\/index\.html?$/i, '/');
function initAnchors() {
  doc.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    let url; try { url = new URL(a.href, location.href); } catch { return; }
    if (!url.hash || url.hash === '#' || url.origin !== location.origin || normPath(url.pathname) !== normPath(location.pathname)) return;
    const target = doc.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (!target) return;
    e.preventDefault();
    if (motion.touch || !lenis) {
      try { target.scrollIntoView({ behavior: motion.reduced ? 'auto' : 'smooth', block: 'start' }); } catch { target.scrollIntoView(); }
    } else scrollTo(target);
    try { history.pushState(null, '', url.hash); } catch { /* noop */ }
  });
}

/* ==========================================================================
   5. COMMANDBAR
   ========================================================================== */
function initCommandBar() {
  const cmd = qs('.cmd');
  if (!cmd) return;
  // scroll state (nav solid > 80, launch button visible > 600)
  const launch = qs('.launch');
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = win.scrollY || 0;
      cmd.classList.toggle('is-solid', y > 80);
      if (launch) launch.classList.toggle('is-visible', y > 600);
      ticking = false;
    });
  };
  win.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // active link from body[data-page]
  const page = (doc.body.dataset.page || 'index').toLowerCase();
  const here = `${page}.html`;
  qsa('.cmd a[href], .overlay a[href], .pad a[href]').forEach((a) => {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (href.includes('#') || href.startsWith('http') || href.startsWith('mailto') || href.startsWith('tel')) return;
    if (href === here || (page === 'index' && (href === '' || href === './' || href === 'index.html'))) {
      if (!a.closest('.cmd__brand') && !a.classList.contains('pad__brand')) a.setAttribute('aria-current', 'page');
    }
  });
  qsa('.cmd__item', cmd).forEach((item) => {
    const trig = qs('.cmd__trigger', item);
    if (trig && qs('[aria-current="page"]', item)) trig.classList.add('is-active');
  });

  // dropdowns
  const items = qsa('.cmd__item', cmd).filter((li) => qs('.cmd__trigger', li) && qs('.cmd__dd', li));
  let openItem = null, leaveTimer = 0;
  const setOpen = (item, open) => {
    const trig = qs('.cmd__trigger', item), dd = qs('.cmd__dd', item);
    trig.setAttribute('aria-expanded', open ? 'true' : 'false');
    dd.classList.toggle('is-open', open);
    if (open) { if (openItem && openItem !== item) setOpen(openItem, false); openItem = item; }
    else if (openItem === item) openItem = null;
  };
  items.forEach((item) => {
    const trig = qs('.cmd__trigger', item), dd = qs('.cmd__dd', item);
    trig.setAttribute('aria-haspopup', 'true');
    trig.addEventListener('click', (e) => { e.preventDefault(); setOpen(item, trig.getAttribute('aria-expanded') !== 'true'); });
    trig.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || ((e.key === 'Enter' || e.key === ' ') && trig.getAttribute('aria-expanded') !== 'true')) {
        e.preventDefault(); setOpen(item, true); const first = qs('a, button', dd); first && first.focus();
      }
    });
    dd.addEventListener('keydown', (e) => {
      const links = qsa('a, button', dd); const i = links.indexOf(doc.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (links[i + 1] || links[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (links[i - 1] || links[links.length - 1]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); links[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); links[links.length - 1].focus(); }
    });
    if (motion.hover && !motion.touch) {
      item.addEventListener('mouseenter', () => { clearTimeout(leaveTimer); setOpen(item, true); });
      item.addEventListener('mouseleave', () => { leaveTimer = setTimeout(() => setOpen(item, false), 120); });
    }
    item.addEventListener('focusout', (e) => { if (!item.contains(e.relatedTarget)) setOpen(item, false); });
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openItem) { const t = qs('.cmd__trigger', openItem); setOpen(openItem, false); t && t.focus(); }
  });
  doc.addEventListener('pointerdown', (e) => { if (openItem && !openItem.contains(e.target)) setOpen(openItem, false); });
}

/* ==========================================================================
   6. MOBILE OVERLAY (film index) — focus trap, Escape, scroll lock
   ========================================================================== */
let overlayRelease = null;
function initOverlay() {
  const overlay = qs('#overlay');
  const burger = qs('.cmd__burger');
  if (!overlay || !burger) return;
  qsa('.overlay__row', overlay).forEach((row, i) => row.style.setProperty('--i', i));
  let open = false, lastFocus = null;
  const setState = (next) => {
    if (next === open) return;
    open = next;
    overlay.classList.toggle('is-open', open);
    burger.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
    lockScroll(open);
    if (open) {
      lastFocus = doc.activeElement;
      overlayRelease = trapFocus(overlay);
      const first = qs('a, button', overlay); first && setTimeout(() => first.focus(), 50);
    } else {
      overlayRelease && overlayRelease(); overlayRelease = null;
      lastFocus && lastFocus.focus && lastFocus.focus();
    }
    emit('sl:overlay', { open });
  };
  overlay.setAttribute('aria-hidden', 'true');
  burger.addEventListener('click', () => setState(!open));
  overlay.addEventListener('click', (e) => {
    const el = e.target.closest('a[href], [data-overlay-close]');
    if (!el) return;
    if (el.hasAttribute('data-overlay-close')) { e.preventDefault(); setState(false); return; }
    setState(false); // any link closes the index; navigation / anchor scroll proceeds via the document handlers
  });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setState(false); });
  mq('(min-width: 1024px)').addEventListener?.('change', (e) => { if (e.matches) setState(false); });
}
function lockScroll(on) {
  if (lenis) { try { on ? lenis.stop() : lenis.start(); } catch { /* noop */ } }
  root.classList.toggle('is-locked', on);
}
function trapFocus(container) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const f = qsa(sel, container).filter((el) => el.offsetParent !== null || el === doc.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  doc.addEventListener('keydown', handler);
  return () => doc.removeEventListener('keydown', handler);
}

/* ==========================================================================
   7. SCRUB PROGRESS ([data-scrub] sections: hero + scrub stages)
   gl.js subscribes with SL.onScrub(el, fn) or window 'sl:scrub' events.
   ========================================================================== */
function initScrubs() {
  const sections = qsa('[data-scrub]');
  if (!sections.length) return;
  sections.forEach((el) => {
    const steps = qsa('.step[data-from], .beat[data-from]', el);
    const rec = { progress: 0, listeners: new Set(), steps, rail: qs('.scrub__rail', el) };
    scrubs.set(el, rec);
    if (motion.reduced) {
      const fixed = el.classList.contains('hero') ? 0 : parseFloat(el.dataset.scrubStatic || '0.6');
      applyProgress(el, fixed, true);
      steps.forEach((s) => s.classList.add('is-on'));
      return;
    }
    const g = lib.gsap, ST = lib.ScrollTrigger;
    if (g && ST) {
      const proxy = { p: 0 };
      g.to(proxy, {
        p: 1, ease: 'none',
        scrollTrigger: { trigger: el, start: 'top top', end: 'bottom bottom', scrub: 0.8, invalidateOnRefresh: true },
        onUpdate: () => applyProgress(el, proxy.p),
      });
      applyProgress(el, 0);
    } else {
      let raf = 0;
      const update = () => {
        raf = 0;
        const r = el.getBoundingClientRect();
        const total = r.height - win.innerHeight;
        const p = total > 0 ? clamp(-r.top / total) : 0;
        applyProgress(el, p);
      };
      const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
      win.addEventListener('scroll', onScroll, { passive: true });
      win.addEventListener('resize', onScroll);
      update();
    }
  });
}
function applyProgress(el, p, silent = false) {
  const rec = scrubs.get(el);
  if (!rec) return;
  const changed = Math.abs(p - (rec.progress ?? -1)) > 0.0002;
  rec.progress = p;
  // --p is written ONLY on the small rail that reads it: an inherited custom property on the scrub element
  // itself (e.g. the whole 300svh hero) forces a style recalc of its entire subtree on every scroll frame.
  if (rec.rail && changed) rec.rail.style.setProperty('--p', p.toFixed(4));
  rec.steps.forEach((s) => {
    const from = parseFloat(s.dataset.from || '0'), to = parseFloat(s.dataset.to || '1');
    s.classList.toggle('is-on', p >= from && p < to || (to >= 1 && p >= from));
  });
  if (silent) return;
  rec.listeners.forEach((fn) => { try { fn(p, el); } catch (err) { console.warn('[core] scrub listener', err); } });
  emit('sl:scrub', { el, progress: p, name: el.dataset.scrub || el.id || '' });
}
function onScrub(el, fn) {
  const target = typeof el === 'string' ? qs(el) : el;
  if (!target) return () => {};
  if (!scrubs.has(target)) scrubs.set(target, { progress: 0, listeners: new Set(), steps: [], rail: null });
  scrubs.get(target).listeners.add(fn);
  return () => offScrub(target, fn);
}
function offScrub(el, fn) { const rec = scrubs.get(el); rec && rec.listeners.delete(fn); }
function getProgress(el) { const t = typeof el === 'string' ? qs(el) : el; return scrubs.get(t)?.progress ?? 0; }
function setProgress(el, p) { const t = typeof el === 'string' ? qs(el) : el; t && applyProgress(t, clamp(p)); }

/* ==========================================================================
   8. REVEALS (IntersectionObserver; CSS transitions; JS adds .js-reveal)
   ========================================================================== */
const DATA_MAP = { fade: 'rv-fade', eyebrow: 'rv-eyebrow', rule: 'rv-rule', lines: 'rv-lines', frame: 'rv-frame', draw: 'rv-draw', marker: 'rv-marker', object: 'rv-object' };
let revealIO = null, countIO = null;
function initReveals() {
  // normalise data attributes → classes
  qsa('[data-reveal]').forEach((el) => { const c = DATA_MAP[el.dataset.reveal]; if (c) el.classList.add(c); });
  qsa('[data-split]').forEach((el) => el.classList.add('rv-lines'));
  qsa('[data-counter]').forEach((el) => { el.classList.add('rv-count'); if (!el.dataset.value) el.dataset.value = el.dataset.counter; });
  qsa('.marker.rv-eyebrow').forEach((el) => { el.classList.remove('rv-eyebrow'); el.classList.add('rv-marker'); });
  qsa('.frame').forEach((el) => { if (qs('img', el)) el.classList.add('rv-frame'); });
  qsa('.rv-group').forEach((g) => qsa(':scope > *', g).forEach((c, i) => c.style.setProperty('--i', i)));

  // chapter/footer rules
  const rules = qsa('.chapter, .pad');
  const ruleIO = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); ruleIO.unobserve(e.target); } }), { rootMargin: '0px 0px -4% 0px' });
  rules.forEach((el) => ruleIO.observe(el));

  // counters (60 % visible)
  countIO = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { countUp(e.target); countIO.unobserve(e.target); } }), { threshold: 0.6 });
  qsa('.rv-count').forEach((el) => { if (motion.reduced) printFinal(el); else countIO.observe(el); });

  // draw-on SVG strokes
  qsa('.rv-draw').forEach(prepareDraw);

  if (motion.reduced) return; // instant: nothing hidden

  revealIO = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('is-in');
    if (e.target.classList.contains('rv-draw') && !e.target.hasAttribute('data-scrub')) drawOnce(e.target);
    revealIO.unobserve(e.target);
  }), { rootMargin: '0px 0px -4% 0px', threshold: 0 }); // reveal as content enters: a deep margin left empty bands under already-visible eyebrows

  const all = qsa('.rv-fade, .rv-eyebrow, .rv-marker, .rv-rule, .rv-frame, .rv-draw, .rv-object');
  observeReveals(all);

  // headline lines: split after fonts (cap 1500 ms), then observe
  const lines = qsa('.rv-lines');
  if (lines.length) {
    lines.forEach((el) => el.classList.add('js-reveal'));
    fontsReady(1500).then(() => {
      lines.forEach((el) => { try { splitElement(el); } catch (err) { console.warn('[core] split', err); } });
      lines.forEach((el) => revealIO.observe(el));
    });
  }
}
function observeReveals(list) {
  const els = Array.isArray(list) ? list : (list instanceof Element ? qsa('.rv-fade, .rv-eyebrow, .rv-marker, .rv-rule, .rv-frame, .rv-draw, .rv-object', list) : qsa(list));
  if (motion.reduced || !revealIO) { els.forEach((el) => el.classList.add('is-in')); return; }
  els.forEach((el) => { if (el.classList.contains('is-in')) return; el.classList.add('js-reveal'); revealIO.observe(el); });
}
/* SplitType lines, masked line-lift, re-split on resize */
function splitElement(el) {
  const S = lib.SplitType;
  if (!S) return;
  if (el._split) { try { el._split.revert(); } catch { /* noop */ } }
  el.classList.remove('is-split');
  el._split = new S(el, { types: 'lines', lineClass: 'line' });
  qsa('.line', el).forEach((line, i) => {
    const inner = doc.createElement('span');
    inner.className = 'line__in';
    inner.style.setProperty('--i', i);
    while (line.firstChild) inner.appendChild(line.firstChild);
    line.appendChild(inner);
  });
  el.classList.add('is-split');
  splitRegistry.add(el);
}
let lastSplitWidth = win.innerWidth;
function resplitAll() {
  if (win.innerWidth === lastSplitWidth) return;
  lastSplitWidth = win.innerWidth;
  splitRegistry.forEach((el) => { try { splitElement(el); } catch { /* noop */ } });
}
/* counters */
function parseValue(el) {
  const raw = (el.dataset.value ?? el.textContent).trim();
  const m = raw.match(/^([^\d\-+]*?)([-+]?\d[\d,]*(?:\.\d+)?)(.*)$/);
  if (!m) return { numeric: false, raw };
  return { numeric: true, prefix: m[1], value: parseFloat(m[2].replace(/,/g, '')), suffix: m[3], raw };
}
function fmt(n, dec) { return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function printFinal(el) { const v = parseValue(el); el.textContent = v.numeric ? `${v.prefix}${fmt(v.value, +(el.dataset.decimals || 0))}${v.suffix}` : v.raw; }
function countUp(el) {
  const v = parseValue(el);
  const flash = () => { el.classList.add('is-hot'); setTimeout(() => el.classList.remove('is-hot'), 120); };
  if (!v.numeric) { // type-on at 30 ms/char
    const text = v.raw; let i = 0; el.textContent = '';
    const step = () => { i++; el.textContent = text.slice(0, i); if (i < text.length) setTimeout(step, 30); else flash(); };
    step(); return;
  }
  const dec = +(el.dataset.decimals || 0), dur = 1400, t0 = performance.now();
  const frame = (now) => {
    const t = clamp((now - t0) / dur);
    el.textContent = `${v.prefix}${fmt(v.value * power2Out(t), dec)}${v.suffix}`;
    if (t < 1) requestAnimationFrame(frame); else flash();
  };
  requestAnimationFrame(frame);
}
/* svg stroke draw-on */
function prepareDraw(svg) {
  const shapes = qsa('path, line, polyline, circle, ellipse', svg).filter((s) => !s.hasAttribute('data-nodraw'));
  shapes.forEach((s) => {
    let len = 0; try { len = s.getTotalLength(); } catch { return; }
    if (!len) return;
    s.dataset.len = len.toFixed(1);
    s.style.strokeDasharray = `${len}`;
    s.style.strokeDashoffset = motion.reduced ? '0' : `${len}`;
  });
  if (svg.hasAttribute('data-scrub') && !motion.reduced) {
    svg.classList.add('is-scrub');
    const nodes = qsa('[data-node]', svg);
    const update = () => {
      const r = (svg.closest('.ledger') || svg).getBoundingClientRect();
      const p = clamp((win.innerHeight * 0.8 - r.top) / r.height);
      shapes.forEach((s) => { s.style.strokeDashoffset = `${(1 - p) * parseFloat(s.dataset.len)}`; });
      nodes.forEach((n) => n.classList.toggle('is-lit', p >= parseFloat(n.dataset.node || '0')));
    };
    let raf = 0; const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    win.addEventListener('scroll', onScroll, { passive: true }); win.addEventListener('resize', onScroll); update();
  }
}
function drawOnce(svg) {
  qsa('[data-len]', svg).forEach((s, i) => { s.style.transitionDelay = `${i * 80}ms`; s.style.strokeDashoffset = '0'; });
  qsa('[data-node]', svg).forEach((n, i) => setTimeout(() => n.classList.add('is-lit'), 400 + i * 180));
}

/* ==========================================================================
   9. CHAPTER NAV (desktop ≥ 1024) — one dot per section[data-chapter][id]
   ========================================================================== */
function initChapterNav() {
  if (!motion.desktop) return;
  const chapters = qsa('section[data-chapter][id], .chapter[data-chapter][id]');
  if (chapters.length < 2) return;
  let nav = qs('.chapnav');
  if (!nav) { nav = doc.createElement('nav'); nav.className = 'chapnav'; nav.setAttribute('aria-label', 'Chapters'); doc.body.appendChild(nav); }
  nav.innerHTML = '';
  const dots = new Map();
  chapters.forEach((sec) => {
    const a = doc.createElement('a');
    a.className = 'chapnav__dot'; a.href = `#${sec.id}`;
    const label = sec.dataset.label || sec.id.toUpperCase();
    a.dataset.label = `${sec.dataset.chapter} — ${label}`;
    a.setAttribute('aria-label', `Chapter ${sec.dataset.chapter}: ${label}`);
    a.addEventListener('click', (e) => { e.preventDefault(); scrollTo(sec); });
    nav.appendChild(a); dots.set(sec, a);
  });
  const active = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { dots.forEach((d) => d.classList.remove('is-active')); dots.get(e.target).classList.add('is-active'); }
  }), { rootMargin: '-45% 0px -45% 0px' });
  chapters.forEach((c) => active.observe(c));
  const hero = qs('#hero'), foot = qs('footer');
  const seen = new Map();
  const hide = new IntersectionObserver((entries) => {
    entries.forEach((e) => seen.set(e.target, e.isIntersecting));
    nav.classList.toggle('is-hidden', Array.from(seen.values()).some(Boolean));
  }, { threshold: 0 });
  hero && hide.observe(hero); foot && hide.observe(foot);
}

/* ==========================================================================
   10. PARALLAX ([data-parallax="0.15"]) · TILT (.panel)
   ========================================================================== */
function initParallax() {
  const els = qsa('[data-parallax]');
  if (!els.length || motion.reduced || motion.touch) return;
  let raf = 0;
  const update = () => {
    raf = 0; const mid = win.innerHeight / 2;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > win.innerHeight + 200) return;
      const f = parseFloat(el.dataset.parallax || '0.15');
      el.style.transform = `translate3d(0, ${((r.top + r.height / 2 - mid) * -f).toFixed(1)}px, 0)`;
    });
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  win.addEventListener('scroll', onScroll, { passive: true }); win.addEventListener('resize', onScroll); update();
}
function initTilt() {
  const panels = qsa('.panel, [data-tilt]');
  if (!panels.length) return;
  if (motion.touch || motion.reduced || !motion.fine) {
    // touch: the in-view panel (≥ 60 %) is active
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.target.classList.toggle('is-active', e.isIntersecting)), { threshold: 0.6 });
    panels.forEach((p) => io.observe(p));
    return;
  }
  panels.forEach((p) => {
    const max = parseFloat(p.dataset.tilt || '4');
    p.addEventListener('pointermove', (e) => {
      const r = p.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      p.classList.remove('is-leaving');
      p.style.setProperty('--rx', `${(-y * max * 2).toFixed(2)}deg`);
      p.style.setProperty('--ry', `${(x * max * 2).toFixed(2)}deg`);
      p.dataset.px = x.toFixed(3); p.dataset.py = y.toFixed(3); // gl.js reads these for the rim light
    });
    p.addEventListener('pointerleave', () => { p.classList.add('is-leaving'); p.style.setProperty('--rx', '0deg'); p.style.setProperty('--ry', '0deg'); delete p.dataset.px; delete p.dataset.py; });
  });
}

/* ==========================================================================
   11. DIALOGS (native <dialog>, focus return, backdrop close)
   ========================================================================== */
const dialogTriggers = new WeakMap();
function initDialogs() {
  qsa('[data-dialog-open]').forEach((btn) => btn.addEventListener('click', (e) => {
    const d = qs(btn.dataset.dialogOpen); if (!d) return; e.preventDefault(); openDialog(d, btn);
  }));
  qsa('dialog.dialog').forEach((d) => {
    qsa('[data-dialog-close]', d).forEach((b) => b.addEventListener('click', () => closeDialog(d)));
    d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(d); });
    d.addEventListener('close', () => { lockScroll(false); const t = dialogTriggers.get(d); t && t.focus && t.focus(); emit('sl:dialog', { el: d, open: false }); });
  });
  // location.hash auto-open: <dialog data-hash="#id">
  qsa('dialog[data-hash]').forEach((d) => { if (location.hash && location.hash === d.dataset.hash) setTimeout(() => openDialog(d), 300); });
}
let dialogRelease = null;
function openDialog(d, trigger) {
  if (!d || d.open) return;
  dialogTriggers.set(d, trigger || doc.activeElement);
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  lockScroll(true);
  dialogRelease && dialogRelease();
  dialogRelease = trapFocus(d);
  const f = qs('.dialog__close, a, button', d); f && setTimeout(() => f.focus(), 30);
  emit('sl:dialog', { el: d, open: true });
}
function closeDialog(d) {
  if (!d) return;
  dialogRelease && dialogRelease(); dialogRelease = null;
  if (typeof d.close === 'function' && d.open) d.close(); else { d.removeAttribute('open'); d.dispatchEvent(new Event('close')); }
}

/* ==========================================================================
   12. LAUNCH BUTTON (back-to-top + 6 s long-press crew-manifest egg)
   ========================================================================== */
function initLaunch() {
  const btn = qs('.launch');
  if (!btn) return;
  const ring = qs('.launch__ring circle', btn);
  const label = qs('.launch__label', btn);
  const manifest = qs('#manifest') || qs('.dialog--manifest');
  const C = ring ? 2 * Math.PI * parseFloat(ring.getAttribute('r') || '26') : 163.36;
  if (ring) { ring.style.strokeDasharray = `${C}`; ring.style.strokeDashoffset = `${C}`; }
  let holding = false, fired = false, t0 = 0, raf = 0, sx = 0, sy = 0, ptrId = null, keyDown = false, launched = false;

  const setRing = (f) => { if (ring) ring.style.strokeDashoffset = `${C * (1 - clamp(f))}`; };
  const setLabel = (t) => { if (label) label.textContent = t; };
  const visibleAt = () => (store.get('sl-egg', 'session') ? 500 : 1500);

  const reset = () => {
    btn.classList.remove('is-holding', 'is-rumbling', 'is-hot', 'is-flash');
    setRing(0); setLabel('');
  };
  const tick = (now) => {
    if (!holding) return;
    const t = now - t0;
    if (t >= visibleAt()) btn.classList.add('is-holding');
    setRing(0.25 + 0.75 * clamp((t - 1500) / 4500));
    if (t >= 1500) setLabel(t >= 5000 ? 'T-1' : t >= 4000 ? 'T-2' : t >= 3000 ? 'T-3' : 'T-4');
    if (t >= 3000 && !motion.reduced) btn.classList.add('is-rumbling');
    if (t >= 5000) btn.classList.add('is-hot');
    if (t >= 6000) { fire(); return; }
    raf = requestAnimationFrame(tick);
  };
  const begin = (x, y) => {
    if (holding || launched) return;
    holding = true; fired = false; t0 = performance.now(); sx = x; sy = y;
    raf = requestAnimationFrame(tick);
  };
  const end = (cancel) => {
    if (!holding) return;
    holding = false; cancelAnimationFrame(raf);
    if (fired) return;
    const t = performance.now() - t0;
    reset();
    if (!cancel && t < 400) shortPress();
    // 400–1500 ms: deliberate partial hold → cancel silently; ≥ 1500 ms released early → cancel
  };
  const shortPress = () => {
    launched = true;
    emit('sl:launch', { kind: 'short' });
    if (!motion.reduced) btn.classList.add('is-launching');
    scrollTo(0, { duration: 1.1, offset: 0 });
    setTimeout(reenter, motion.reduced ? 100 : 1250);
  };
  const reenter = () => {
    btn.classList.remove('is-launching', 'is-rumbling', 'is-hot', 'is-flash', 'is-holding');
    btn.classList.add('is-reenter');
    void btn.offsetHeight;
    requestAnimationFrame(() => { btn.classList.remove('is-reenter'); launched = false; setLabel(''); setRing(0); });
  };
  const fire = () => {
    fired = true; holding = false; cancelAnimationFrame(raf);
    setLabel('T-0'); setRing(1);
    btn.classList.add('is-flash');
    requestAnimationFrame(() => requestAnimationFrame(() => btn.classList.remove('is-flash')));
    btn.classList.remove('is-rumbling');
    store.set('sl-egg', '1', 'session');
    launched = true;
    if (!motion.reduced) btn.classList.add('is-launching');
    emit('sl:launch', { kind: 'egg' });
    setTimeout(() => {
      btn.classList.remove('is-holding', 'is-hot');
      if (manifest) {
        openDialog(manifest, btn);
        manifest.addEventListener('close', () => setTimeout(reenter, 400), { once: true });
      } else setTimeout(reenter, 900);
    }, 150);
  };

  // pointer (mouse + touch + pen)
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    ptrId = e.pointerId;
    try { btn.setPointerCapture(e.pointerId); } catch { /* noop */ }
    begin(e.clientX, e.clientY);
  });
  const pointerEnd = (e) => { if (ptrId !== null && e.pointerId !== ptrId) return; ptrId = null; end(false); };
  const pointerCancel = (e) => { if (ptrId !== null && e.pointerId !== ptrId) return; ptrId = null; end(true); };
  btn.addEventListener('pointerup', pointerEnd);
  btn.addEventListener('pointercancel', pointerCancel);
  btn.addEventListener('pointerleave', () => { if (holding && ptrId !== null) { ptrId = null; end(true); } });
  btn.addEventListener('pointermove', (e) => { if (holding && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) { ptrId = null; end(true); } });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => e.preventDefault()); // handled by pointer/keys
  btn.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  // keyboard: held Space/Enter
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { end(true); return; }
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && !keyDown) { e.preventDefault(); keyDown = true; begin(0, 0); }
    else if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { keyDown = false; end(false); } });
  btn.addEventListener('blur', () => { keyDown = false; end(true); });
  win.addEventListener('blur', () => end(true));
}

/* ==========================================================================
   13. MOTION TOGGLE (persisted in localStorage 'sl-motion'; reloads)
   ========================================================================== */
function initMotionToggle() {
  const btns = qsa('[data-motion-toggle]');
  if (!btns.length) return;
  const on = !motion.reduced;
  btns.forEach((b) => {
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? 'Motion on' : 'Motion off';
    b.addEventListener('click', () => {
      const next = on ? 'off' : 'on';
      store.set('sl-motion', next);
      emit('sl:motion', { motion: next });
      store.set('sl-shutter', doc.body.dataset.code || 'SPACELABS', 'session');
      win.location.reload();
    });
  });
}

/* ==========================================================================
   14. RESIZE (one handler) · DEBUG READOUT · PAGE TRANSITIONS
   ========================================================================== */
function initResize() {
  let t1 = 0, t2 = 0;
  win.addEventListener('resize', () => {
    clearTimeout(t1); clearTimeout(t2);
    t1 = setTimeout(() => { emit('sl:resize', { w: win.innerWidth, h: win.innerHeight }); try { lib.ScrollTrigger && lib.ScrollTrigger.refresh(); } catch { /* noop */ } }, 150);
    t2 = setTimeout(resplitAll, 200);
  });
}
function initDebug() {
  if (!/[?&]debug=1/.test(location.search)) return;
  debugPanel = doc.createElement('div');
  debugPanel.className = 'debug'; debugPanel.id = 'debug'; debugPanel.setAttribute('aria-hidden', 'true');
  doc.body.appendChild(debugPanel);
  let frames = 0, last = performance.now();
  const loop = (now) => { frames++; if (now - last >= 1000) { debugSet('fps', frames); frames = 0; last = now; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  debugSet('core', SL.version); debugSet('motion', motion.reduced ? 'off' : 'on'); debugSet('lenis', lenis ? 'on' : 'off');
  debugSet('input', motion.touch ? 'touch' : 'fine');
}
function debugSet(key, value) {
  debugLines.set(key, value);
  if (!debugPanel) return;
  debugPanel.textContent = Array.from(debugLines, ([k, v]) => `${k.padEnd(9)} ${v}`).join('\n');
}
function initTransitions() {
  doc.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === '_blank' || a.hasAttribute('download') || a.dataset.noShutter !== undefined) return;
    let url; try { url = new URL(a.href, location.href); } catch { return; }
    if (!url.protocol.startsWith('http') || url.origin !== location.origin) return;
    if (!/\.html?$/i.test(url.pathname) && !url.pathname.endsWith('/')) return; // downloads (pdf etc.) → native
    if (normPath(url.pathname) === normPath(location.pathname)) return; // same page (hash or reload) → native
    e.preventDefault();
    const code = a.dataset.code || (a.textContent || '').trim().toUpperCase().slice(0, 40) || 'SPACELABS';
    shutterOut(code, url.href);
  });
}

/* ==========================================================================
   BOOT — last in the file so every module-level binding above is initialised
   (module scripts run after parsing, so init() usually runs synchronously here)
   ========================================================================== */
SL.ready = new Promise((resolve) => {
  const go = () => { try { init(); } finally { resolve(SL); } };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
});
