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

  function availabilityRenderer(root) {
    const tile = q(root, '.availability-tile');
    const first = q(root, '.capacity-state-available');
    const second = q(root, '.capacity-state-limited');
    const slots = [...root.querySelectorAll('.availability-glyph i')];
    const states = ['Available', 'Limited', 'Unavailable', 'Available'];
    const fills = [1, .55, .12, 1];
    function label(element, value) {
      if (!element || element.dataset.sourceLabel === value) return;
      element.dataset.sourceLabel = value;
      const dot = element.querySelector('.scene-dot');
      element.replaceChildren();
      if (dot) element.appendChild(dot);
      element.appendChild(document.createTextNode(value));
    }
    return t => {
      const step = Math.floor(t / 1500) % 4;
      const local = t % 1500;
      const blend = phase(local, 850, 1450, ease.fluid);
      const leave = phase(local, 1050, 1150, ease.release);
      const enter = phase(local, 1150, 1350, ease.arrive);
      label(first, states[step]);
      label(second, states[(step + 1) % 4]);
      show(first, 1 - leave);
      show(second, enter, 4 * (1 - enter));
      set(tile, 'transform', `scale(${round(1 - .025 * Math.sin(Math.PI * blend))})`);
      const available = mix(fills[step], fills[(step + 1) % 4], blend);
      slots.forEach((slot, i) => {
        set(slot, 'opacity', round(.14 + .65 * clamp(available * 9 - i)));
        set(slot, 'transform', 'none');
      });
    };
  }

  // Original tt() waveform envelope; original nt() scroll speed et=.04 px/ms.
  function waveformAmplitude(index) {
    const envelope = .35 + .65 * Math.abs(Math.sin(index * .21 + .6)) ** .8 * (.55 + .45 * Math.abs(Math.sin(index * .057 + 1.3)));
    let noise = Math.sin(index * 12.9898) * 43758.5453;
    noise -= Math.floor(noise);
    return Math.min(1, envelope * (.55 + .45 * noise));
  }
  function meterRenderer(root) {
    const wave = q(root, '.meter-wave');
    const settlement = q(root, '.meter-settlement');
    const note = q(root, '.meter-note');
    const count = q(root, '[data-token-count]');
    if (count) count.removeAttribute('data-token-count'); // The legacy 120ms interval yields ownership.
    let path;
    if (wave) {
      [...wave.children].forEach(child => set(child, 'display', 'none'));
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 300 40');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'display:block;width:100%;height:60px;fill:currentColor;stroke:none;color:inherit;';
      path = document.createElementNS(svgNS, 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('stroke', 'none');
      svg.appendChild(path);
      wave.appendChild(svg);
    }
    return (t, clock) => {
      const offset = clock * .04;
      const start = Math.floor(offset / 3);
      let d = '';
      for (let index = start; index <= start + 100; index++) {
        const x = index * 3 - offset;
        if (x < -1 || x > 298) continue;
        const height = Math.max(2, 36 * waveformAmplitude(index));
        d += `M${x.toFixed(2)} ${(20 - height / 2).toFixed(2)}h1v${height.toFixed(2)}h-1z`;
      }
      if (path) path.setAttribute('d', d);
      const transcript = phase(t, 1650, 2250, ease.arrive) - phase(t, 5200, 5600, ease.release);
      show(settlement, transcript, 6 * (1 - transcript));
      show(note, transcript, 6 * (1 - transcript));
      show(q(root, '.meter-status-running'), 1 - transcript);
      show(q(root, '.meter-status-done'), transcript);
      if (count) count.textContent = String(Math.round(200 * phase(t, 0, 2250)));
    };
  }

  function signatureRenderer(root) {
    const line = q(root, '.signature-line');
    const underline = q(root, '.signature-understroke');
    const tick = q(root, '.signature-tick');
    const pen = q(root, '.signature-pen');
    let length = 760; let underlineLength = 260;
    try { length = line.getTotalLength(); underlineLength = underline.getTotalLength(); } catch (_) { /* SVG may be disconnected during insertion. */ }
    set(line, 'stroke-dasharray', `${length} ${length}`);
    set(underline, 'stroke-dasharray', `${underlineLength} ${underlineLength}`);
    return t => {
      const secondHalf = t >= 3000;
      const local = t % 3000;
      const brush = phase(local, 200, 1900, ease.stroke);
      const highlighter = phase(local, 1300, 2700);
      const erase = phase(local, 100, 2700, ease.stroke);
      set(line, 'stroke-dashoffset', round(length * (secondHalf ? 0 : 1 - brush)));
      set(line, 'opacity', 1);
      set(line, 'clip-path', secondHalf ? `inset(0 0 0 ${round(erase * 100)}%)` : 'none');
      set(underline, 'stroke-dashoffset', round(underlineLength * (secondHalf ? 0 : 1 - highlighter)));
      set(underline, 'opacity', .65);
      set(underline, 'clip-path', secondHalf ? `inset(0 0 0 ${round(erase * 100)}%)` : 'none');
      show(tick, secondHalf ? 1 - erase : phase(local, 1900, 2200, ease.arrive));
      set(tick, 'stroke-dashoffset', 0);
      if (line && pen && !secondHalf) {
        const point = line.getPointAtLength(length * brush);
        // Source gesture timings; coordinates follow this receipt's actual path, not a guessed diagonal.
        set(pen, 'left', `${round(84 + 30 + point.x - 22)}px`);
        set(pen, 'top', `${round(79 + 279 + point.y - 112)}px`);
        set(pen, 'transform', `rotate(${round(3 * Math.sin((t / 2600 + .1) * Math.PI * 4))}deg)`);
        set(pen, 'opacity', 1 - phase(local, 2200, 2700, ease.release));
      } else hide(pen);
    };
  }

  function radarRenderer(root) {
    const chart = q(root, '.radar-visual');
    const table = q(root, '.radar-table');
    const chartLabel = q(root, '.radar-mode-chart');
    const tableLabel = q(root, '.radar-mode-table');
    set(q(root, '.radar-area'), 'transform', 'none');
    return t => {
      const step = Math.floor(t / 3000) % 3;
      const local = t % 3000;
      const blend = phase(local, 1500, 3000, ease.fluid);
      // Only two visual actors exist here. The original third (priorities) is a documented gap.
      const currentChart = step === 1 ? 1 : 0;
      const nextChart = (step + 1) % 3 === 1 ? 1 : 0;
      const amount = mix(currentChart, nextChart, blend);
      show(chart, amount, (1 - amount) * -8);
      show(chartLabel, amount);
      show(table, 1 - amount, amount * 8);
      show(tableLabel, 1 - amount);
    };
  }

  function assistantRenderer(root) {
    const ask = q(root, '.assistant-followup');
    const thinking = q(root, '.assistant-thinking');
    const output = [...root.querySelectorAll('.assistant-output>div')];
    const done = q(root, '.assistant-complete');
    return t => {
      const out = 1 - phase(t, 7500, 7900, ease.release);
      const question = phase(t, 600, 800, ease.arrive) * out;
      const waiting = phase(t, 600, 800, ease.arrive) - phase(t, 2200, 2300, ease.release);
      const tool = phase(t, 2200, 2400, ease.arrive) * out;
      const complete = phase(t, 4400, 4550, ease.arrive) * tool;
      show(ask, question, 4 * (1 - question));
      show(thinking, waiting, 4 * (1 - waiting));
      output.forEach(card => show(card, tool, 4 * (1 - tool)));
      show(done, complete, 4 * (1 - complete));
    };
  }

  function walletRenderer(root) {
    const popover = q(root, '.wallet-popover');
    const form = q(root, '.wallet-authorization');
    const approved = q(root, '.wallet-approved');
    const icon = q(root, '.wallet-approved>span');
    const check = q(root, '.wallet-approved svg path');
    const label = q(root, '.wallet-approved h3');
    const details = [...root.querySelectorAll('.wallet-approved p,.wallet-approved small')];
    hide(q(root, '.wallet-cursor'));
    show(popover, 1);
    set(check, 'stroke-dasharray', '25 25');
    return t => {
      const list = 1 - phase(t, 900, 1100, ease.release) + phase(t, 2800, 3060, ease.arrive);
      const done = 1 - phase(t, 2700, 2900, ease.release);
      const pop = phase(t, 1000, 1260, ease.arrive);
      const draw = phase(t, 1130, 1390, ease.arrive);
      const text = phase(t, 1150, 1410, ease.arrive);
      show(form, list);
      show(approved, pop * done);
      show(icon, pop, 0, .82 + .18 * pop);
      set(check, 'stroke-dashoffset', round(25 * (1 - draw)));
      show(label, text, 6 * (1 - text));
      details.forEach(element => show(element, text, 6 * (1 - text)));
    };
  }

  function requestRenderer(root) {
    const card = q(root, '.request-moving-card');
    const origin = q(root, '.request-origin-card');
    const target = q(root, '.request-drop-target');
    const inserted = q(root, '.request-inserted');
    const line = q(root, '.request-drop-line');
    const detail = q(root, '.request-log-lines');
    const note = q(root, '.request-log-note');
    const oldCursor = q(card || root, '.scene-cursor');
    let cursor;
    if (oldCursor) {
      cursor = oldCursor.cloneNode(true);
      cursor.classList.add('choreography-cursor');
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.setProperty('animation', 'none', 'important');
      root.appendChild(cursor);
      hide(oldCursor);
    }
    let destination = {x: 524, y: 240};
    function measure() {
      if (!target) return;
      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const scale = rootRect.width / 960;
      if (scale) destination = {x: (targetRect.left - rootRect.left) / scale, y: (targetRect.top - rootRect.top) / scale};
    }
    measure();
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(root);
    return t => {
      const approach = phase(t, 450, 1050, ease.arrive);
      const pick = phase(t, 1250, 1420, ease.arrive);
      const drag = phase(t, 1300, 2450, ease.sweep);
      const drop = phase(t, 2560, 2860, ease.arrive);
      const land = phase(t, 2560, 2900, ease.arrive);
      const previewOut = phase(t, 2560, 2820, ease.release);
      const lineOut = phase(t, 2560, 2760, ease.release);
      const pointer = phase(t, 350, 600, ease.arrive) - phase(t, 2900, 3250, ease.release);
      const open = phase(t, 2560, 2960, ease.arrive) - phase(t, 5000, 5500, ease.release);
      const text = phase(t, 2640, 2960, ease.arrive) - phase(t, 4850, 5100, ease.release);
      const x = mix(96, destination.x, drag);
      const y = mix(240, destination.y, drag) - 36 * Math.sin(Math.PI * drag);
      set(card, 'transform', `translate(${round(x)}px,${round(y - 2 * (pick - land))}px)`);
      set(card, 'opacity', round(pick * (1 - drop)));
      set(origin, 'opacity', round(1 - .6 * pick));
      show(inserted, open, 6 * (1 - open));
      show(detail, text, 6 * (1 - text));
      show(note, text, 6 * (1 - text));
      set(line, 'opacity', round(pick * (1 - lineOut)));
      set(line, 'transform', `scaleX(${round(drag)})`);
      if (cursor) {
        const pointerX = pick === 0 ? mix(330, 236, approach) : x + 140;
        const pointerY = pick === 0 ? mix(470, 270, approach) : y + 30;
        set(cursor, 'left', `${round(pointerX - 3)}px`);
        set(cursor, 'top', `${round(pointerY - 3)}px`);
        set(cursor, 'opacity', pointer * (1 - .15 * previewOut));
        set(cursor, 'transform', 'none');
      }
    };
  }

  function exportRenderer(root) {
    const download = q(root, '.export-download-icon');
    const check = q(root, '.export-check-icon');
    const tooltip = q(root, '.export-tooltip');
    const button = q(root, '.export-button');
    hide(q(root, '.export-menu'));
    hide(q(root, '.export-cursor'));
    return t => {
      const copied = phase(t, 1200, 1350, ease.ease) - phase(t, 3500, 3650, ease.ease);
      const pop = phase(t, 1200, 1450, ease.arrive);
      const tip = phase(t, 1300, 1500, ease.arrive) - phase(t, 3200, 3400, ease.release);
      show(download, 1 - copied, 0, 1 - .15 * copied);
      show(check, copied, 0, .82 + .18 * pop);
      // Tooltip positioning uses right/bottom in the retained OFFPEAK scene, not an extra flyout.
      show(tooltip, tip, 4 * (1 - tip));
      set(button, 'filter', `brightness(${round(1 - .025 * copied)})`);
    };
  }

  const factories = {
    quote: quoteRenderer, models: modelsRenderer, endpoint: endpointRenderer,
    availability: availabilityRenderer, meter: meterRenderer, signature: signatureRenderer,
    radar: radarRenderer, assistant: assistantRenderer, wallet: walletRenderer,
    'request-log': requestRenderer, export: exportRenderer
  };

  function tick(time) {
    raf = 0;
    const delta = Math.min(100, Math.max(0, time - (lastTime || time)));
    lastTime = time;
    let anyVisible = false;
    for (const state of scenes) {
      if (!state.root.isConnected) { scenes.delete(state); continue; }
      if (!state.visible) continue;
      anyVisible = true;
      state.elapsed += delta;
      state.render(state.elapsed % state.loopMs, state.elapsed);
    }
    if (anyVisible && !reduce.matches && !document.hidden) raf = requestAnimationFrame(tick);
  }
  function resume() {
    if (raf || reduce.matches || document.hidden) return;
    lastTime = 0;
    raf = requestAnimationFrame(tick);
  }
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      for (const state of scenes) if (state.root === entry.target) state.visible = entry.isIntersecting;
    }
    resume();
  }) : null;

  function mount(root = document) {
    const targets = root.matches?.('.offpeak-scene') ? [root] : [...root.querySelectorAll('.offpeak-scene')];
    for (const element of targets) {
      if (mounted.has(element)) continue;
      const kind = element.dataset.scene;
      if (!factories[kind]) continue;
      mounted.add(element);
      // Replace the earlier approximate looping layer, without replacing material/style files.
      for (const child of element.querySelectorAll('*')) child.style.setProperty('animation', 'none', 'important');
      const config = audit[kind];
      const state = {root: element, visible: !observer, elapsed: config.stillMs, loopMs: config.loopMs, render: factories[kind](element)};
      element.dataset.choreographySource = config.source;
      state.render(config.stillMs, config.stillMs);
      scenes.add(state);
      if (observer) observer.observe(element);
    }
    resume();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
    resume();
  });
  reduce.addEventListener('change', () => {
    if (reduce.matches) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const state of scenes) {
        const config = audit[state.root.dataset.scene];
        state.render(config.stillMs, config.stillMs);
      }
    } else resume();
  });

  window.OffpeakChoreography = {mount, audit};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(), {once: true});
  else mount();
})();
