/* Causal card-depth enhancement. No libraries, telemetry, or network requests. */
(() => {
  'use strict';
  const baseline = new URLSearchParams(location.search).has('baseline');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const states = new Map();
  const cube = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/></svg>';

  function initCard(card, media) {
    if (card.hasAttribute('data-iso-card')) return;
    card.setAttribute('data-iso-card', '');
    card.setAttribute('data-iso-active', 'false');
    const name = media.getAttribute('aria-label') || 'Card';
    const toggle = document.createElement('button');
    toggle.className = 'iso-view-toggle';
    toggle.type = 'button';
    toggle.innerHTML = cube;
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-label', `Isometric view: ${name}`);
    toggle.title = 'Pin isometric view';
    card.append(toggle);
    const state = { pinned: false, hovering: false, frame: 0, x: .5, y: .5 };
    states.set(card, state);

    function render() {
      card.dataset.isoActive = String(state.pinned || state.hovering);
      toggle.setAttribute('aria-pressed', String(state.pinned));
      toggle.title = state.pinned ? 'Return to flat view' : 'Pin isometric view';
    }
    function resetAngles() {
      card.style.removeProperty('--iso-rx');
      card.style.removeProperty('--iso-ry');
      card.style.removeProperty('--iso-x');
      card.style.removeProperty('--iso-y');
    }
    card.addEventListener('pointerenter', (event) => {
      if (!finePointer.matches || event.pointerType === 'touch' || reduced.matches) return;
      state.hovering = true;
      render();
    });
    card.addEventListener('pointermove', (event) => {
      if (!state.hovering || reduced.matches) return;
      const rect = card.getBoundingClientRect();
      state.x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      state.y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      if (state.frame) return;
      state.frame = requestAnimationFrame(() => {
        state.frame = 0;
        card.style.setProperty('--iso-rx', `${11 + (1 - state.y) * 8}deg`);
        card.style.setProperty('--iso-ry', `${-23 + state.x * 10}deg`);
        card.style.setProperty('--iso-x', `${state.x * 100}%`);
        card.style.setProperty('--iso-y', `${state.y * 100}%`);
      });
    });
    card.addEventListener('pointerleave', () => {
      state.hovering = false;
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
      resetAngles();
      render();
    });
    toggle.addEventListener('click', () => {
      state.pinned = !state.pinned;
      state.hovering = false;
      resetAngles();
      render();
    });
    toggle.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      state.pinned = false;
      state.hovering = false;
      resetAngles();
      render();
    });
  }

  function scan() {
    // Top-level media only; nested SVGs belong to the original animation.
    document.querySelectorAll('#features .anim-scope, #productivity .anim-scope').forEach((scope) => {
      const media = scope.parentElement;
      if (media?.getAttribute('role') === 'img') initCard(media.parentElement, media);
    });
    for (const [card, state] of states) {
      if (!card.isConnected) {
        if (state.frame) cancelAnimationFrame(state.frame);
        states.delete(card);
      }
    }
  }

  if (baseline) return;
  let scheduled = false;
  const observer = new MutationObserver((mutations) => {
    // Only new layout/media trees need initialization, not animation text updates.
    if (scheduled || !mutations.some(m => [...m.addedNodes].some(n => n.nodeType === 1 &&
      (n.matches('.anim-scope, main, section') || n.querySelector('.anim-scope'))))) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(); });
  });
  function start() {
    scan();
    observer.observe(document.body, { childList: true, subtree: true });
  }
  // Wait for the original React tree to finish hydration before enhancing it.
  if (window.causalPageReady) start();
  else window.addEventListener('causal:ready', start, { once: true });
})();
