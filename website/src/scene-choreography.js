/*
 * Native timing port from reference/assets/animations-BoMe2xBV.js.
 * These are the source's clocks, segment boundaries and cubic-bezier functions,
 * applied to OFFPEAK's existing actors. This is not the original React renderer.
 * Material differences are documented in OffpeakChoreography.audit below.
 */
(() => {
  'use strict';
  if (window.OffpeakChoreography) return;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const scenes = new Set();
  const mounted = new WeakSet();
  const svgNS = 'http://www.w3.org/2000/svg';
  let raf = 0;
  let lastTime = 0;

  // Original p(), h(), g() interpolation, with the same 28-iteration solver.
  function bezier(x1, y1, x2, y2) {
    const axis = (p, a, b) => 3 * (1 - p) ** 2 * p * a + 3 * (1 - p) * p ** 2 * b + p ** 3;
    return value => {
      let low = 0; let high = 1; let p = value;
      for (let i = 0; i < 28; i++) {
        const x = axis(p, x1, x2);
        if (Math.abs(x - value) < .00001) break;
        if (x < value) low = p; else high = p;
        p = (low + high) / 2;
      }
      return axis(p, y1, y2);
    };
  }
  const ease = {
    linear: t => t,
    arrive: bezier(.22, 1, .36, 1),
    release: bezier(.45, 0, .55, 1),
    fluid: bezier(.65, 0, .35, 1),
    stroke: bezier(.3, 0, .7, 1),
    sweep: bezier(.45, 0, .2, 1),
    ease: bezier(.25, .1, .25, 1)
  };
  const phase = (time, start, end, curve = ease.linear) => time <= start ? 0 : time >= end ? 1 : curve((time - start) / (end - start));
  const mix = (a, b, progress) => a + (b - a) * progress;
  const clamp = value => Math.max(0, Math.min(1, value));
  const q = (root, selector) => root.querySelector(selector);
  const round = value => Math.round(value * 1000) / 1000;
  function set(element, property, value) {
    if (element) element.style.setProperty(property, String(value));
  }
  function show(element, opacity, dy = 0, scale = 1) {
    if (!element) return;
    set(element, 'opacity', round(clamp(opacity)));
    set(element, 'transform', `translateY(${round(dy)}px) scale(${round(scale)})`);
  }
  function hide(element) { if (element) set(element, 'opacity', 0); }

  const audit = {
    quote: {source: 'de / fe', loopMs: 6000, stillMs: 3500, port: 'selection, menu, active weight; the OFFPEAK quote replaces the original text editor; source has no visible cursor'},
    models: {source: 'xe / Se', loopMs: 5200, stillMs: 2500, port: 'glass, caption and reveal timings; the image/caption surface is a model profile, with no source-equivalent photo crop'},
    endpoint: {source: 'Ae / je', loopMs: 5600, stillMs: 3200, port: 'placeholder, typed identifier, title, banner, details and expanding height; content and final proportions remain OFFPEAK'},
    availability: {source: 'Ue / We', loopMs: 6000, stillMs: 400, port: '1500ms state boundaries, staggered label fades and 2.5% breath; source four-color OKLab interpolation is intentionally not copied into product statuses'},
    meter: {source: 'nt / rt', loopMs: 6000, stillMs: 3000, port: 'exact deterministic moving waveform, 40 source px/s, shimmer/transcript reveal clocks; usage replaces voice transcription'},
    signature: {source: 'St / Dt', loopMs: 6000, stillMs: 2200, port: 'brush 200–1900ms and highlighter 1300–2700ms on a 3000ms half-cycle; pen follows actual receipt path; missing second drawing slot and independent eraser/highlighter actors'},
    radar: {source: 'ci / li', loopMs: 9000, stillMs: 3800, port: 'three 3000ms holds/morph windows; current DOM has only chart/table, so original habits/skills/priorities geometry morph is not reproduced'},
    assistant: {source: 'Zi / Qi', loopMs: 9000, stillMs: 6800, port: 'ask, thinking, tool, done, exit boundaries; source animated cell character has no corresponding OFFPEAK DOM actor'},
    wallet: {source: 'la / da', loopMs: 3600, stillMs: 2000, port: 'list-to-success fade, pop, check draw and label entrance; source Chrome destination picker is an authorization preview here'},
    'request-log': {source: 'ga / Na', loopMs: 6000, stillMs: 2300, port: 'approach/pick/carry/drop/land/open/text sequence, 36px carry arc, independent cursor; destination coordinates adapt to the retained OFFPEAK layout'},
    export: {source: 'Ra / za', loopMs: 4400, stillMs: 2400, port: 'copy/check/tint/pop/tooltip timings; receipt export icon substitutes for the original share-link icon, no invented export-menu sequence'}
  };

  function quoteRenderer(root) {
    const selected = q(root, '.quote-selection');
    const menu = q(root, '.quote-context');
    const amount = q(root, '.quote-selected strong');
    hide(q(root, '.quote-cursor'));
    return t => {
      const selection = phase(t, 400, 1150, ease.sweep);
      const fade = phase(t, 4600, 5000, ease.release);
      const reveal = phase(t, 1150, 1650, ease.arrive) - phase(t, 4450, 4800, ease.release);
      const weight = phase(t, 2400, 2900, ease.arrive) - phase(t, 4700, 5300, ease.release);
      set(selected, 'transform', `scaleX(${round(selection)})`);
      set(selected, 'opacity', round(.8 * (1 - fade)));
      show(menu, Math.min(1, reveal * 1.6), 0, .94 + .06 * reveal);
      set(menu, 'clip-path', `inset(0 0 ${round((1 - reveal) * 100)}% 0 round 12px)`);
      set(amount, 'font-weight', round(400 + 200 * weight));
    };
  }

  function modelsRenderer(root) {
    const glass = q(root, '.model-reveal');
    const contents = glass ? [...glass.children] : [];
    // A single machined module replaces the old decorative paper stack.
    set(q(root, '.model-sheet-back'), 'display', 'none');
    set(q(root, '.model-sheet-middle'), 'display', 'none');
    set(q(root, '.model-orbits'), 'transform', 'none');
    return t => {
      const reveal = phase(t, 500, 1300, ease.arrive) - phase(t, 3900, 4500, ease.release);
      const text = phase(t, 850, 1450, ease.arrive) - phase(t, 3700, 3950, ease.release);
      show(glass, reveal, (1 - reveal) * 8, .97 + .03 * reveal);
      for (const child of contents) show(child, text, 4 * (1 - text));
    };
  }

  function endpointRenderer(root) {
    const card = q(root, '.endpoint-card');
    const address = q(root, '.endpoint-address-text');
    const unfold = q(root, '.endpoint-unfold');
    const preview = q(root, '.endpoint-preview');
    const details = q(root, '.endpoint-description');
    const title = q(root, '.endpoint-description h3');
    const copy = q(root, '.endpoint-description p');
    const code = q(root, '.endpoint-code');
    const identifier = 'example-open-model';
    hide(q(root, '.endpoint-cursor'));
    if (address) {
      address.textContent = '';
      set(address, 'animation', 'none');
      set(address, 'clip-path', 'none');
    }
    return t => {
      const placeholder = 1 - phase(t, 500, 800, ease.release) + phase(t, 4750, 5100, ease.arrive);
      const typed = phase(t, 550, 950, ease.arrive) - phase(t, 1600, 1700, ease.release);
      const heading = phase(t, 1150, 1550, ease.arrive) - phase(t, 4600, 4950, ease.release);
      const banner = phase(t, 1650, 2450, ease.arrive) - phase(t, 4150, 4650, ease.release);
      const extras = phase(t, 1900, 2600, ease.arrive) - phase(t, 4050, 4450, ease.release);
      if (address) {
        const content = placeholder > .5 ? 'Choose a model' : heading > .5 ? 'Example open model' : identifier;
        if (address.textContent !== content) address.textContent = content;
        set(address, 'opacity', Math.max(placeholder, typed, heading));
        set(address, 'clip-path', heading > .5 || placeholder > .5 ? 'none' : `inset(0 ${round((1 - typed) * 100)}% 0 0)`);
      }
      const height = 148 * banner + 180 * extras;
      set(unfold, 'height', `${round(height)}px`);
      set(unfold, 'opacity', 1);
      set(card, 'transform', `translateY(${round(320 - 145 - (79 + height) / 2)}px)`);
      show(preview, banner, -8 * (1 - banner));
      set(preview, 'height', `${round(148 * banner)}px`);
      set(preview, 'overflow', 'hidden');
      set(details, 'height', `${round(180 * extras)}px`);
      set(details, 'overflow', 'hidden');
      show(details, extras, -6 * (1 - extras));
      show(title, heading);
      show(copy, extras);
      show(code, extras);
    };
  }
