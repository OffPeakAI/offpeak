/* Local button lighting and a restrained press spring. CSS owns the material and transform. */
(() => {
  'use strict';
  if (window.OffpeakSurfaces) return;

  const selector = [
    '.faithful-button', '.hero-example-button', '.hero-example-close',
    '.opcity-hotspot', '.opcity-pause', '.opcity-district-tab', '.material-switch',
    '.material-controls button', '.pages-pill', '.pages-filter button',
    '.pages-rate-switch button', '.pages-flow-tabs button', '.pages-code-block button',
    '.docs-button', '.console-page .button', '.widget-copy', '[data-surface-interaction]'
  ].join(',');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const states = new WeakMap();
  const active = new Set();
  const hovered = new Set();
  const pointers = new Map();
  const keys = new Set();
  let frame = 0;
  let previous = 0;

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const disabled = element => element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]');
  const interactive = element => !element.closest('.material-ghost,[inert]');

  function paint(state) {
    const {element} = state;
    element.style.setProperty('--surface-x', `${state.x.toFixed(2)}%`);
    element.style.setProperty('--surface-y', `${state.y.toFixed(2)}%`);
    element.style.setProperty('--surface-rx', `${state.rx.toFixed(3)}deg`);
    element.style.setProperty('--surface-ry', `${state.ry.toFixed(3)}deg`);
    element.style.setProperty('--surface-press', state.press.toFixed(4));
  }

  function wake(state) {
    if (reduce.matches) {
      state.x = state.tx; state.y = state.ty;
      state.rx = 0; state.ry = 0;
      state.press = state.down ? 1 : 0; state.velocity = 0;
      paint(state);
      active.delete(state);
      return;
    }
    active.add(state);
    if (!frame && !document.hidden) {
      previous = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    frame = 0;
    const dt = previous ? clamp((now - previous) / 1000, .001, .032) : 1 / 60;
    previous = now;
    const follow = 1 - Math.exp(-18 * dt);
    for (const state of active) {
      if (!state.element.isConnected) { active.delete(state); continue; }
      state.x += (state.tx - state.x) * follow;
      state.y += (state.ty - state.y) * follow;
      state.rx += (state.trx - state.rx) * follow;
      state.ry += (state.try - state.ry) * follow;

      // Two short integration steps keep the release consistent at lower refresh rates.
      for (let i = 0; i < 2; i++) {
        const step = dt / 2;
        const force = ((state.down ? 1 : 0) - state.press) * 420 - state.velocity * 28;
        state.velocity += force * step;
        state.press = clamp(state.press + state.velocity * step, -.10, 1.04);
      }
      const settled = Math.abs(state.tx - state.x) < .025 && Math.abs(state.ty - state.y) < .025 &&
        Math.abs(state.trx - state.rx) < .006 && Math.abs(state.try - state.ry) < .006 &&
        Math.abs((state.down ? 1 : 0) - state.press) < .001 && Math.abs(state.velocity) < .012;
      if (settled) {
        state.x = state.tx; state.y = state.ty;
        state.rx = state.trx; state.ry = state.try;
        state.press = state.down ? 1 : 0; state.velocity = 0;
        active.delete(state);
      }
      paint(state);
    }
    if (active.size && !document.hidden && !reduce.matches) frame = requestAnimationFrame(tick);
  }

  function position(state, event, tilt) {
    const rect = state.element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    state.tx = clamp((event.clientX - rect.left) / rect.width * 100, 0, 100);
    state.ty = clamp((event.clientY - rect.top) / rect.height * 100, 0, 100);
    state.trx = tilt ? -(state.ty - 50) * .048 : 0;
    state.try = tilt ? (state.tx - 50) * .048 : 0;
    wake(state);
  }

  function center(state) {
    state.tx = 50; state.ty = 50; state.trx = 0; state.try = 0;
  }

  function setPressed(state, value) {
    state.down = value;
    state.element.classList.toggle('is-surface-pressed', value);
    wake(state);
  }

  function release(state) {
    state.pointerId = null;
    if (!state.hover) center(state);
    setPressed(state, false);
  }

  function setup(element) {
    if (states.has(element) || !interactive(element)) return;
    const state = {
      element, x: 50, y: 50, tx: 50, ty: 50, rx: 0, ry: 0, trx: 0, try: 0,
      press: 0, velocity: 0, down: false, hover: false, pointerId: null
    };
    states.set(element, state);
    element.dataset.surfaceReady = 'true';
    paint(state);

    element.addEventListener('pointerenter', event => {
      if (disabled(element) || event.pointerType === 'touch' || !fine.matches) return;
      state.hover = true;
      hovered.add(state);
      element.classList.add('is-surface-hover');
      position(state, event, !reduce.matches);
    }, {passive: true});
    element.addEventListener('pointermove', event => {
      if (state.hover && !disabled(element)) position(state, event, !reduce.matches && fine.matches);
    }, {passive: true});
    element.addEventListener('pointerleave', () => {
      state.hover = false;
      hovered.delete(state);
      element.classList.remove('is-surface-hover');
      center(state);
      wake(state);
    }, {passive: true});
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || disabled(element) || state.pointerId !== null) return;
      state.pointerId = event.pointerId;
      pointers.set(event.pointerId, state);
      position(state, event, state.hover && !reduce.matches);
      setPressed(state, true);
    }, {passive: true});
    element.addEventListener('keydown', event => {
      if (event.repeat || event.target !== element || disabled(element)) return;
      const spaceActivates = element.matches('button,[role="button"],input[type="button"],input[type="submit"]');
      if (event.key !== 'Enter' && !(event.key === ' ' && spaceActivates)) return;
      keys.add(state);
      center(state);
      setPressed(state, true);
    });
    element.addEventListener('blur', () => {
      if (!keys.delete(state)) return;
      release(state);
    });
  }

  function mount(root = document) {
    if (root.nodeType === 1 && root.matches(selector)) setup(root);
    if (root.querySelectorAll) root.querySelectorAll(selector).forEach(setup);
  }

  function pointerEnd(event) {
    const state = pointers.get(event.pointerId);
    if (!state) return;
    pointers.delete(event.pointerId);
    release(state);
  }
  window.addEventListener('pointerup', pointerEnd, {passive: true});
  window.addEventListener('pointercancel', pointerEnd, {passive: true});
  window.addEventListener('keyup', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    for (const state of keys) release(state);
    keys.clear();
  });

  function reset() {
    const resetStates = new Set([...active, ...hovered, ...pointers.values(), ...keys]);
    for (const state of resetStates) {
      state.hover = false; state.down = false; state.pointerId = null;
      state.press = 0; state.velocity = 0; state.rx = 0; state.ry = 0;
      state.x = 50; state.y = 50; center(state);
      state.element.classList.remove('is-surface-hover', 'is-surface-pressed');
      paint(state);
    }
    pointers.clear(); keys.clear(); hovered.clear(); active.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  reduce.addEventListener('change', reset);
  fine.addEventListener('change', reset);

  function start() {
    mount();
    // Only inspect inserted subtrees; attribute/style writes never re-trigger mounting.
    const observer = new MutationObserver(records => {
      const pending = new Set();
      let removed = false;
      for (const record of records) {
        if (record.removedNodes.length) removed = true;
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.isConnected && interactive(node)) pending.add(node);
        }
      }
      for (const node of pending) {
        if (![...pending].some(parent => parent !== node && parent.contains(node))) mount(node);
      }
      if (removed) {
        for (const state of new Set([...active, ...hovered, ...pointers.values(), ...keys])) {
          if (state.element.isConnected) continue;
          active.delete(state); hovered.delete(state); keys.delete(state);
          if (state.pointerId !== null) pointers.delete(state.pointerId);
        }
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
  }

  window.OffpeakSurfaces = {mount};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
