(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const uiIcon = name => window.OffpeakIcons?.svg(name) || '';
  const samples = {
    classify: { label: 'Product classification', prompt: 'Classify these products by category:\n1. A stainless steel pour-over kettle.\n2. A lightweight trail running shoe.\n3. A compact mechanical keyboard.\n\nReturn a category for each product.', output: '1. Pour-over kettle → Kitchen & dining\n2. Trail running shoe → Sports & outdoors\n3. Mechanical keyboard → Electronics\n\nIllustrative response to the selected sample task.' },
    summarize: { label: 'Support summary', prompt: 'Summarize this support conversation in two sentences:\n\nCustomer: My package arrived with a damaged kettle.\nSupport: I can arrange a replacement at no extra cost.\nCustomer: A replacement would be great.\nSupport: It will ship tomorrow. You will receive tracking by email.', output: 'A customer reported a kettle damaged in transit. Support arranged a replacement at no extra cost, with shipping the following day and tracking sent by email.\n\nIllustrative response to the selected sample task.' },
    extract: { label: 'Information extraction', prompt: 'Extract the product, order ID, and requested action:\n\n“I ordered the compact mechanical keyboard in order OP-1048. One of the switches is faulty, and I would like a replacement.”\n\nReturn a compact JSON object.', output: '{\n  "product": "compact mechanical keyboard",\n  "order_id": "OP-1048",\n  "requested_action": "replacement"\n}\n\nIllustrative response to the selected sample task.' }
  };
  const model = { id: 'example-open-model', revision: 'demo', inputTokens: 1000, outputTokens: 200, inputRate: 200000, outputRate: 600000 };
  let available = 1000000;
  let reserved = 0;
  let quote = null;
  let requests = [];
  let running = false;
  let generation = 0;
  let toastTimer;
  let activeView = 'overview';
  const money = atoms => (atoms / 1000000).toFixed(6);
  const announce = message => { $('announcer').textContent = message; };
  const toast = message => { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3400); };
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  function navigate(view, focus = false) {
    activeView = ['overview','models','requests','receipts'].includes(view) ? view : 'overview';
    document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `view-${activeView}`; });
    document.querySelectorAll('[data-view]').forEach(button => {
      const selected = button.dataset.view === activeView;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    $('view-name').textContent = activeView[0].toUpperCase() + activeView.slice(1);
    history.replaceState(null, '', `#${activeView}`);
    if (focus) $('main-content').focus({preventScroll:true});
    window.scrollTo({top:0, behavior:'instant'});
  }

  function renderBalance() {
    $('balance-available').textContent = money(available);
    $('balance-reserved').textContent = money(reserved);
    $('completed-count').textContent = requests.filter(r => r.status === 'Completed').length;
    $('request-count').textContent = requests.length;
  }

  function invalidateQuote(message = 'Prompt changed — create a fresh quote.') {
    if (running) return;
    const existed = quote !== null;
    quote = null;
    $('run-request').disabled = true;
    $('quote-cap').textContent = '—';
    $('quote-timer').textContent = '—';
    $('quote-state').textContent = existed ? 'Quote invalidated' : 'Awaiting a quote';
    $('quote-state').className = 'neutral-status';
    $('quote-disclaimer').textContent = existed ? message : 'Create a quote to try the flow. No real funds or signatures.';
    $('create-quote').disabled = !$('prompt-input').value.trim();
    if (existed) announce(message);
  }

  function tickQuote() {
    if (!quote || running) return;
    const remaining = Math.max(0, Math.ceil((quote.expiresAt - Date.now()) / 1000));
    $('quote-timer').textContent = `00:${String(remaining).padStart(2,'0')}`;
    if (!remaining) {
      $('quote-state').textContent = 'Quote expired';
      $('quote-state').className = 'neutral-status expired';
      $('run-request').disabled = true;
      $('quote-disclaimer').textContent = 'Request a fresh quote to continue. No funds were reserved.';
      if (!quote.expired) { announce('Your quote expired. Request a fresh quote to continue.'); quote.expired = true; }
    }
  }

  function createQuote() {
    if (running || !$('prompt-input').value.trim()) return;
    const maxOutput = Number($('output-limit').value);
    const cap = Math.ceil((model.inputTokens * model.inputRate + maxOutput * model.outputRate) / 1000000);
    quote = { id: `demo-quote-${Date.now()}`, expiresAt: Date.now() + 30000, maxOutput, cap, task: $('sample-task').value, prompt: $('prompt-input').value, expired:false };
    $('quote-cap').textContent = money(cap);
    $('quote-state').textContent = 'Demo quote ready';
    $('quote-state').className = 'neutral-status ready';
    $('run-request').disabled = available < cap;
    $('quote-disclaimer').textContent = available < cap ? 'Insufficient demo balance. Reset the demo to start again.' : 'Valid for 30 seconds. Rates are illustrative; no real funds or signatures.';
    tickQuote();
    announce(`Demo quote ready. Maximum charge ${money(cap)} MOCK. Valid for 30 seconds.`);
    if (window.matchMedia('(max-width:900px)').matches) document.querySelector('.quote-panel').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'center'});
  }

  function lockComposer(lock) {
    ['sample-task','prompt-input','output-limit','create-quote'].forEach(id => { $(id).disabled = lock; });
    $('run-request').disabled = true;
  }

  function receiptFor(request) {
    return {
      schema: 'offpeak.demo.receipt.v1',
      illustrative_demo: true,
      notice: 'Example record only. Not a real model execution, payment, signed receipt, or on-chain commitment.',
      request_id: request.id,
      created_at: request.createdAt,
      model: model.id,
      model_revision: model.revision,
      asset: 'MOCK',
      mock_asset_decimals: 6,
      network: 'local-simulation',
      metering: 'Fixed illustrative fixture; prompt is not tokenized.',
      input_tokens: model.inputTokens,
      output_tokens: request.output,
      maximum_charge_atoms: String(request.cap),
      charged_atoms: String(request.charge),
      released_atoms: String(request.cap - request.charge),
      status: 'completed_simulation',
      operator_signature: null,
      chain_transaction: null,
      inclusion_proof: null
    };
  }
