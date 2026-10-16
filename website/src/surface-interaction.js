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
