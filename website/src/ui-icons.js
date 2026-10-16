/* OFFPEAK interface symbols: frontal vectors with a light satin finish. */
(() => {
  'use strict';
  if (window.OffpeakIcons) return;

  const art = Object.freeze({
    home: `<path d="M3.5 10.6 12 3.5l8.5 7.1v9a.9.9 0 0 1-.9.9H4.4a.9.9 0 0 1-.9-.9Z" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <path d="M5 11.2 12 5.4l7 5.8" fill="none" stroke="#fff" stroke-width="1.1"/>
      <path d="M9.1 20.1v-6.7a.8.8 0 0 1 .8-.8h4.2a.8.8 0 0 1 .8.8v6.7Z" fill="currentColor"/>
      <path d="M10.7 14.3h2.6" stroke="#ccff00" stroke-width="1.1" stroke-linecap="round"/>`,
    compute: `<path d="M8 2.8v3m4-3v3m4-3v3M8 18.2v3m4-3v3m4-3v3M2.8 8h3m-3 4h3m-3 4h3m12.4-8h3m-3 4h3m-3 4h3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
      <rect x="5.4" y="5.4" width="13.2" height="13.2" rx="2.4" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.2" fill="currentColor"/>
      <rect x="10.6" y="10.6" width="2.8" height="2.8" rx=".45" fill="#ccff00"/>`,
    templates: `<rect x="3" y="3.5" width="18" height="17" rx="2.3" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <path d="M5.3 5.8h13.4v3H5.3Z" fill="currentColor"/>
      <rect x="5.3" y="10.8" width="5.2" height="7.3" rx=".7" fill="currentColor" opacity=".82"/>
      <path d="M12.7 11.5h5.7m-5.7 3h5.7m-5.7 3h3.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      <circle cx="7" cy="7.3" r=".65" fill="#ccff00"/>`,
    pricing: `<path d="M3.2 4.6A1.4 1.4 0 0 1 4.6 3.2h7.1a1.8 1.8 0 0 1 1.3.5l8.1 8.1a1.2 1.2 0 0 1 0 1.7l-7.6 7.6a1.2 1.2 0 0 1-1.7 0L3.7 13a1.8 1.8 0 0 1-.5-1.3Z" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <circle cx="7.3" cy="7.3" r="1.55" fill="currentColor"/>
      <path d="m10.1 13.1 3.7-3.7m-.8 6.6 3.7-3.7" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
      <circle cx="13" cy="11.7" r="1" fill="#ccff00"/>`,
    resources: `<path d="M2.7 4.8c3.2-1 6.3-.4 9.3 1.6 3-2 6.1-2.6 9.3-1.6v14.4c-3.2-1-6.3-.4-9.3 1.6-3-2-6.1-2.6-9.3-1.6Z" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <path d="M12 6.4v14.4M5.5 8.3c1.3-.1 2.5.2 3.7.9m-3.7 2.5c1.3-.1 2.5.2 3.7.9m5.6-3.4c1.2-.7 2.4-1 3.7-.9m-3.7 4.3c1.2-.7 2.4-1 3.7-.9m-3.7 4.3c1.2-.7 2.4-1 3.7-.9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
      <path d="M5.5 14.8h3.4v1.7H5.5Z" fill="currentColor"/>`,
    overview: `<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="2.5" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <rect x="5.6" y="5.6" width="5.2" height="12.8" rx=".8" fill="currentColor"/>
      <rect x="13" y="5.6" width="5.4" height="4.6" rx=".8" fill="currentColor" opacity=".8"/>
      <path d="M13.2 13.4h5m-5 3.7h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      <path d="M7.3 8.2h1.8" stroke="#ccff00" stroke-width="1.1" stroke-linecap="round"/>`,
    models: `<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <path d="m8 15 4-7 4 7H8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <circle cx="12" cy="8" r="2.1" fill="currentColor"/><circle cx="8" cy="15" r="2.1" fill="currentColor"/><circle cx="16" cy="15" r="2.1" fill="currentColor"/>
      <circle cx="12" cy="8" r=".75" fill="#ccff00"/>`,
    requests: `<rect x="3.2" y="4" width="17.6" height="16" rx="2.5" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <path d="M6.6 8.2h9.9m-2.8-2.3 2.8 2.3-2.8 2.3m3.7 5.3H7.5m2.8-2.3-2.8 2.3 2.8 2.3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>`,
    receipts: `<path d="M5 2.8h14v18.4l-2.3-1.4-2.3 1.4-2.4-1.4-2.4 1.4-2.3-1.4L5 21.2Z" fill="url(#satin)" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M8.2 6.6h7.6m-7.6 3.5h7.6m-7.6 3.5h3.2" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      <path d="m13.1 15.7 1.4 1.4 2.7-3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
    info: `<circle cx="12" cy="12" r="9" fill="url(#satin)" stroke="currentColor" stroke-width="1.1"/>
      <circle cx="12" cy="7.6" r="1.1" fill="currentColor"/>
      <path d="M12 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
    check: `<path d="m5 12.2 4.4 4.5L19 7.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    shield: `<path d="M12 2.8c2.6 2 5.5 2.9 8 3v5.5c0 4.5-3.4 7.9-8 10-4.6-2.1-8-5.5-8-10V5.8c2.5-.1 5.4-1 8-3Z" fill="url(#satin)" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="m8.2 11.8 2.5 2.6 5.1-5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    arrowDown: '<path d="M12 4v15m-6-6 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    arrowUpRight: '<path d="M6 18 18 6M6.5 6H18v11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    arrowRight: '<path d="M4 12h15m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    arrowLeft: '<path d="M20 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    reset: '<path d="M4.3 9.2A8 8 0 1 1 4.8 16M4 4v5.5h5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronDown: '<path d="m6.5 9.3 5.5 5.4 5.5-5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    play: '<path d="M7 4.9c0-.7.8-1.1 1.4-.8l11 7.1c.6.4.6 1.2 0 1.6l-11 7.1c-.6.3-1.4-.1-1.4-.8Z" fill="currentColor"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>'
  });

  let serial = 0;
  function svg(name) {
    const key = Object.prototype.hasOwnProperty.call(art,name) ? name : 'info';
    const id = 'offpeak-ui-satin-' + (++serial);
    const graphic = art[key].replaceAll('url(#satin)','url(#' + id + ')');
    const defs = graphic.includes('url(#') ? '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ffffff"/><stop offset=".55" stop-color="#f2f2ee"/><stop offset="1" stop-color="#dfe0da"/></linearGradient></defs>' : '';
    return '<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="none">' + defs + '<g fill="none" stroke="none" stroke-width="0">' + graphic + '</g></svg>';
  }

  function mount(root = document) {
    const nodes = [...(root.querySelectorAll?.('[data-ui-icon]') || [])];
    if (root.matches?.('[data-ui-icon]')) nodes.unshift(root);
    for (const node of nodes) {
      const name = node.getAttribute('data-ui-icon') || 'info';
      if (node.dataset.uiIconReady === name && node.querySelector(':scope > .ui-icon')) continue;
      node.innerHTML = svg(name);
      node.dataset.uiIconReady = name;
    }
  }

  // Consumers in later deferred scripts can call svg() before DOMContentLoaded.
  window.OffpeakIcons = Object.freeze({svg,mount});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',() => mount(),{once:true});
  else mount();
})();
