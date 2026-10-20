/* Local hero interactions. The examples are arithmetic and records, never live inference. */
(() => {
  'use strict';

  const hero = document.getElementById('hero');
  if (!hero || hero.dataset.premiumMounted) return;
  const stage = hero.querySelector('.hero-premium-stage');
  if (!stage) return;
  hero.dataset.premiumMounted = 'true';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const iconPaths = {
    price: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Zm3 5h8M8 12h6"/>',
    cap: '<path d="M12 3 5 6v6c0 4 7 9 7 9s7-5 7-9V6l-7-3Z"/><path d="m8 12 3 3 5-6"/>',
    receipt: '<path d="M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h4"/>'
  };
  const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></svg>';
  const dock = document.createElement('div');
  dock.className = 'hero-example-dock';
  dock.innerHTML = '<section id="hero-product-example" class="hero-example-panel" role="region" aria-labelledby="hero-example-title" tabindex="-1" hidden></section>';
  stage.appendChild(dock);
  const panel = dock.firstElementChild;

  const announcer = document.createElement('div');
  announcer.className = 'hero-premium-announcer';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  stage.appendChild(announcer);

  let active = null;
  let lastTrigger = null;
  let closingTimer;
  let quoteExpiresAt = 0;
  let quoteExpiryAnnounced = false;
  let outputLimit = 500;
  const triggers = [...hero.querySelectorAll('[data-hero-example]')];

  const money = atoms => (atoms / 1000000).toFixed(6);
  const capFor = output => Math.ceil((1000 * 200000 + output * 600000) / 1000000);
  const announce = text => { announcer.textContent = text; };

  function header(type, title) {
    return `<div class="hero-example-head"><svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[type]}</svg><h2 id="hero-example-title">${title}</h2><span class="hero-example-badge">ILLUSTRATIVE</span><button class="hero-example-close" type="button" aria-label="Close product example"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div>`;
  }

  function renderExample(type) {
    if (type === 'price') {
      panel.innerHTML = header('price', 'A price before the request.') +
        '<p class="hero-example-caption">Maximum for this sample request</p>' +
        '<div class="hero-example-value">0.000500 <small>MOCK</small></div>' +
        '<div class="hero-example-row"><span>Input / maximum output</span><strong>1,000 / 500 tokens</strong></div>' +
        '<div class="hero-example-row"><span>Input / output rate per 1M</span><strong>0.20 / 0.60 MOCK</strong></div>' +
        '<div class="hero-example-actions"><button class="hero-example-button" type="button" data-refresh-quote>Refresh quote <span aria-hidden="true">↻</span></button><span class="hero-example-timer" data-quote-time>Valid for 30s</span></div>' +
        '<p class="hero-example-footnote">Sample rates. No request is sent and no funds are reserved.</p>';
      refreshQuote();
    } else if (type === 'cap') {
      panel.innerHTML = header('cap', 'A limit you choose.') +
        '<p class="hero-example-caption">Move the output limit. Watch the maximum change.</p>' +
        '<label class="hero-example-slider-label" for="hero-output-limit"><span>Maximum output tokens</span><output id="hero-limit-value" for="hero-output-limit">500</output></label>' +
        `<input class="hero-example-slider" id="hero-output-limit" type="range" min="100" max="1000" step="100" value="${outputLimit}" aria-describedby="hero-cap-note">` +
        '<div class="hero-example-rule"></div><div class="hero-example-row"><span>Maximum authorized</span><strong data-cap-value>0.000500 MOCK</strong></div>' +
        '<div class="hero-example-row"><span>Input in this example</span><strong>1,000 tokens</strong></div>' +
        '<p class="hero-example-footnote" id="hero-cap-note">Illustrative calculation with a mock token. No wallet or signature.</p>';
      updateCap();
    } else {
      panel.innerHTML = header('receipt', 'A record you can keep.') +
        '<p class="hero-example-caption">Inspect the charge. Take the example with you.</p>' +
        '<div class="hero-example-receipt"><div><span>request_id</span><b>demo-0001</b></div><div><span>charged</span><b>0.000320 MOCK</b></div><div><span>released</span><b>0.000180 MOCK</b></div></div>' +
        `<div class="hero-example-actions"><button class="hero-example-button" type="button" data-export-receipt>Export example JSON ${arrow}</button><span class="hero-example-status" data-export-status>Yours to inspect.</span></div>` +
        '<p class="hero-example-footnote">Example only. This record has no signature or on-chain proof.</p>';
    }
    panel.querySelector('.hero-example-close').addEventListener('click', () => closeExample(true));
    panel.querySelector('[data-refresh-quote]')?.addEventListener('click', () => {
      refreshQuote(); announce('New illustrative quote. Valid for 30 seconds.');
    });
    panel.querySelector('#hero-output-limit')?.addEventListener('input', updateCap);
    panel.querySelector('[data-export-receipt]')?.addEventListener('click', exportReceipt);
  }

  function refreshQuote() {
    quoteExpiresAt = Date.now() + 30000;
    quoteExpiryAnnounced = false;
    updateQuoteTime();
  }

  function updateQuoteTime() {
    const timer = panel.querySelector('[data-quote-time]');
    if (!timer) return;
    const remaining = Math.max(0, Math.ceil((quoteExpiresAt - Date.now()) / 1000));
    timer.textContent = remaining ? `Valid for ${remaining}s` : 'Quote expired';
    timer.classList.toggle('is-expired', remaining === 0);
    if (!remaining && !quoteExpiryAnnounced) {
      quoteExpiryAnnounced = true;
      announce('The illustrative quote expired. Refresh it for another 30 seconds.');
    }
  }

  function updateCap() {
    const slider = panel.querySelector('#hero-output-limit');
    if (!slider) return;
    outputLimit = Number(slider.value);
    panel.querySelector('#hero-limit-value').textContent = outputLimit.toLocaleString();
    panel.querySelector('[data-cap-value]').textContent = `${money(capFor(outputLimit))} MOCK`;
    slider.style.setProperty('--range-fill', `${(outputLimit - 100) / 900 * 100}%`);
    slider.setAttribute('aria-valuetext', `${outputLimit} output tokens; maximum ${money(capFor(outputLimit))} MOCK`);
  }

  function exportReceipt() {
    const receipt = {
      schema: 'offpeak.hero.example.v1',
      illustrative_demo: true,
      notice: 'An illustrative billing record. No real request, payment, signature, or on-chain proof.',
      request_id: 'demo-0001',
      model: 'example-open-model',
      asset: 'MOCK',
      mock_asset_decimals: 6,
      input_tokens: 1000,
      output_tokens: 200,
      maximum_charge_atoms: '500',
      charged_atoms: '320',
      released_atoms: '180',
      operator_signature: null,
      chain_transaction: null,
      inclusion_proof: null
    };
    const blob = new Blob([JSON.stringify(receipt, null, 2) + '\n'], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'offpeak-illustrative-receipt.json';
    link.hidden = true;
    hero.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    const status = panel.querySelector('[data-export-status]');
    if (status) status.textContent = 'Example exported.';
    announce('Illustrative receipt exported as JSON. It contains no signature or chain proof.');
  }
