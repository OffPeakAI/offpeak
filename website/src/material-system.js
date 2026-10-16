/* Flat OFFPEAK cards: hover lighting, click-through explanations, no page effects. */
(() => {
  'use strict';
  const frames = '#features .scene-frame[data-scene], #productivity .scene-frame[data-scene]';
  // Only bounded presentation cards receive a material. Links, forms and prose keep their semantics.
  const panelSelectors = '.gallery-box,#reviews figure,#developers a.bg-surface,[data-closing="panel"],#hero .hero-example-panel,.pages-price-card,.pages-workflow-detail,.pages-code-block,.docs-scope>div,.docs-case,.docs-note,.docs-code,.docs-table-wrap,.docs-example,.docs-proof-box,.docs-future,.console-page .summary-card,.console-page .panel';
  const surfaces = '.quote-document,.model-sheet,.endpoint-card,.availability-tile,.meter-card,.signature-sheet,.radar-widget,.assistant-prompt,.assistant-source,.assistant-followup,.assistant-output>div,.wallet-popover,.request-origin-card,.request-log-paper,.request-moving-card,.export-shadow-paper,.export-receipt-bar,.export-menu';
  const names = {
    'scene-feature-0':'capped quotes', 'scene-feature-1':'model revisions',
    'scene-feature-2':'model discovery', 'scene-feature-3':'capacity',
    'scene-feature-4':'usage metering', 'scene-feature-5':'billing receipts',
    'scene-productivity-0':'capacity insights', 'scene-productivity-1':'prompt to response',
    'scene-productivity-2':'wallet authorization', 'scene-productivity-3':'quote to request',
    'scene-productivity-4':'receipt export'
  };
  const interactive = 'a,button,input,select,textarea,summary,[contenteditable="true"],[role="button"]';
  const reduced = matchMedia('(prefers-reduced-motion:reduce)');
  const cards = new Map();
  let stage, portal, volume, controls, closeButton, active, explanation;
  let geometryFrame = 0, cleanupTimer = 0, scanFrame = 0;
  let sizeObserver;
  function createStage() {
    stage = document.createElement('div');
    stage.className = 'material-stage';
    stage.inert = true;
    stage.innerHTML = '<section class="material-portal" id="offpeak-card-explanation" role="dialog" aria-modal="false" aria-hidden="true"><div class="material-volume"></div><div class="material-controls"><button type="button" data-material-close aria-label="Back to the feature card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div></section>';
    document.body.append(stage);
    portal = stage.querySelector('.material-portal');
    volume = stage.querySelector('.material-volume');
    controls = stage.querySelector('.material-controls');
    closeButton = stage.querySelector('[data-material-close]');
    closeButton.addEventListener('click', () => dismiss(true));
    sizeObserver = new ResizeObserver(scheduleGeometry);
  }
  function clearExplanation() {
    explanation?.setActive?.(false);
    explanation?.destroy?.();
    explanation?.remove();
    explanation = null;
  }
  function syncGeometry() {
    geometryFrame = 0;
    if (!active) return;
    const rect = active.card.getBoundingClientRect();
    if (!active.card.isConnected || !rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) {
      dismiss(false); return;
    }
    portal.style.left = rect.left + 'px';
    portal.style.top = rect.top + 'px';
    portal.style.width = rect.width + 'px';
    portal.style.height = rect.height + 'px';
    portal.style.setProperty('--material-radius', getComputedStyle(active.card).borderRadius);
  }
  function scheduleGeometry() {
    if (active && !geometryFrame) geometryFrame = requestAnimationFrame(syncGeometry);
  }
  function activate(state) {
    if (active === state) { dismiss(true); return; }
    const factory = window.OffpeakCardExplainers?.create;
    if (typeof factory !== 'function') return;
    let next;
    // A missing/broken optional illustration module must leave the original card usable.
    try { next = factory(state.sceneId); } catch { return; }
    if (!(next instanceof HTMLElement)) return;
    if (active) dismiss(false, true);
    clearTimeout(cleanupTimer);
    clearExplanation();
    explanation = next;
    volume.replaceChildren(next);
    active = state;
    syncGeometry();
    if (!active) { clearExplanation(); return; }
    stage.inert = false;
    portal.setAttribute('aria-hidden', 'false');
    portal.setAttribute('aria-label', 'How it works: ' + state.name);
    state.button.setAttribute('aria-expanded', 'true');
    state.card.dataset.materialActive = 'true';
    state.wasInert = state.card.inert;
    state.card.inert = true;
    sizeObserver.observe(state.card);
    stage.classList.remove('is-open');
    void stage.offsetWidth;
    stage.classList.add('is-open');
    explanation.setActive?.(true);
    closeButton.focus({preventScroll:true});
  }
  function dismiss(restoreFocus = false, immediate = false) {
    clearTimeout(cleanupTimer);
    if (!active) {
      if (immediate) clearExplanation();
      return;
    }
    const previous = active;
    const focusInside = portal.contains(document.activeElement);
    active = null;
    sizeObserver.unobserve(previous.card);
    previous.card.inert = previous.wasInert;
    previous.card.removeAttribute('data-material-active');
    previous.button.setAttribute('aria-expanded', 'false');
    stage.classList.remove('is-open');
    // Stop all explainer loops at the start of the dissolve, including offscreen/hidden closes.
    explanation?.setActive?.(false);
    if (restoreFocus && focusInside && previous.button.isConnected) previous.button.focus({preventScroll:true});
    else if (focusInside) document.activeElement.blur();
    stage.inert = true;
    portal.setAttribute('aria-hidden', 'true');
    if (immediate || reduced.matches) clearExplanation();
    else cleanupTimer = setTimeout(() => { if (!active) clearExplanation(); }, 500);
  }
  function initCard(media) {
    const card = media.parentElement;
    if (!card || card.closest('.material-stage')) return;
    card.classList.add('material-card');
    card.dataset.materialCard = '';
    card.querySelectorAll(surfaces).forEach(surface => surface.setAttribute('data-material-surface', ''));
    const modelIcon = card.querySelector('.endpoint-model svg');
    if (modelIcon && !modelIcon.dataset.materialFace) {
      modelIcon.dataset.materialFace = 'true';
      modelIcon.innerHTML = '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="M7 2v3m10-3v3M7 19v3m10-3v3M1 10h2m18 0h2M1 15h2m18 0h2"/><path class="material-eye" d="M8 10v3m8-3v3"/>';
    }
    if (cards.has(card) || typeof window.OffpeakCardExplainers?.create !== 'function') return;
    const sceneId = media.dataset.scene;
    const name = names[sceneId];
    if (!name) return;
    card.classList.add('material-card-interactive');
    const feature = Boolean(card.closest('#features'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'material-explore';
    button.innerHTML = '<span>' + (feature ? 'Click for more' : 'Explore how') + '</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>';
    button.setAttribute('aria-label', 'Explore how it works: ' + name);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'offpeak-card-explanation');
    if (feature) {
      const glass = document.createElement('span');
      glass.className = 'material-hover-glass';
      glass.setAttribute('aria-hidden', 'true');
      card.append(glass);
    }
    card.append(button);
    const state = {card, button, sceneId, name, down:null, dragged:false, wasInert:false};
    cards.set(card, state);
    button.addEventListener('click', event => { event.stopPropagation(); activate(state); });
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      state.down = {x:event.clientX,y:event.clientY,id:event.pointerId};
      state.dragged = false;
    }, {passive:true});
    card.addEventListener('pointermove', event => {
      if (state.down?.id === event.pointerId && Math.hypot(event.clientX-state.down.x,event.clientY-state.down.y)>7) state.dragged = true;
    }, {passive:true});
    card.addEventListener('pointercancel', () => { state.down = null; state.dragged = true; }, {passive:true});
    card.addEventListener('click', event => {
      const dragged = state.dragged;
      state.down = null; state.dragged = false;
      if (dragged || event.defaultPrevented || event.target.closest(interactive)) return;
      activate(state);
    });
  }
  function scan() {
    scanFrame = 0;
    document.querySelectorAll(frames).forEach(initCard);
    document.querySelectorAll(panelSelectors).forEach(panel => {
      if (!panel.closest('.material-stage')) panel.classList.add('material-panel');
    });
    document.querySelectorAll('.offpeak-page .page-scene').forEach(scene => {
      const container = scene.closest('.gallery-box') || (scene.parentElement.classList.contains('bg-surface') ? scene.parentElement : scene);
      container.classList.add('material-panel');
      if (!container.matches('.gallery-box')) container.classList.add('material-panel-illustration');
    });
    document.querySelectorAll('#blog .article-object').forEach(image => image.parentElement.classList.add('material-panel', 'material-panel-illustration'));
    for (const card of cards.keys()) if (!card.isConnected) cards.delete(card);
  }
  function start() {
    createStage(); scan();
    new MutationObserver(mutations => {
      const candidates = panelSelectors + ',.scene-frame,.offpeak-scene,.page-scene,.article-object';
      if (scanFrame || !mutations.some(mutation => [...mutation.addedNodes].some(node => node.nodeType === 1 && !node.closest('.material-stage') && (node.matches(candidates) || node.querySelector(candidates))))) return;
      scanFrame = requestAnimationFrame(scan);
    }).observe(document.body, {childList:true,subtree:true});
    addEventListener('scroll', scheduleGeometry, {passive:true,capture:true});
    addEventListener('resize', scheduleGeometry, {passive:true});
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && active) { event.preventDefault(); dismiss(true); }
    });
    document.addEventListener('pointerdown', event => {
      if (active && !portal.contains(event.target) && !active.card.contains(event.target)) dismiss(false);
    }, {passive:true});
    document.addEventListener('focusin', event => {
      if (active && !portal.contains(event.target) && !active.card.contains(event.target)) dismiss(false);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) dismiss(false, true); });
    window.addEventListener('offpeak:card-explainers-ready', scan);
    window.OffpeakMaterial = {refresh:scan,close:()=>dismiss(true)};
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start();
})();
