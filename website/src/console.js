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

  function downloadReceipt(id) {
    const request = requests.find(item => item.id === id && item.status === 'Completed');
    if (!request) { toast('Complete a demo request first.'); return; }
    const blob = new Blob([JSON.stringify(receiptFor(request), null, 2) + '\n'], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${request.id}-illustrative-receipt.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Illustrative receipt downloaded. No signature or chain proof is included.');
  }

  function renderHistory() {
    $('requests-empty').hidden = requests.length > 0;
    $('requests-table').innerHTML = requests.slice().reverse().map(request => `<tr><td>${escape(request.id)}<small>${escape(new Date(request.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</small></td><td>${escape(samples[request.task].label)}</td><td><span class="neutral-status ${request.status === 'Completed' ? 'completed' : ''}">${escape(request.status)}</span></td><td>${request.status === 'Completed' ? `1,000 in / ${request.output} out` : '—'}<small>Fixed demo metering</small></td><td>${request.status === 'Completed' ? money(request.charge) : '—'}<small>MOCK</small></td><td>${request.status === 'Completed' ? `<button class="table-action" data-download="${escape(request.id)}">Download ${uiIcon('arrowDown')}</button>` : 'Pending'}</td></tr>`).join('');
    const completed = requests.filter(request => request.status === 'Completed').reverse();
    $('receipts-empty').hidden = completed.length > 0;
    $('receipts-list').innerHTML = completed.map(request => `<article class="receipt-row"><div class="receipt-row-head"><div><h2>${escape(request.id)}</h2><p>${escape(samples[request.task].label)} · Example record · Not signed or anchored</p></div><button class="button button-outline" data-download="${escape(request.id)}">Download JSON ${uiIcon('arrowDown')}</button></div><div class="receipt-summary"><span>Demo charge<strong>${money(request.charge)} MOCK</strong></span><span>Returned to balance<strong>${money(request.cap-request.charge)} MOCK</strong></span><span>Proof status<strong>Not published · simulation</strong></span></div><details class="receipt-details"><summary>Inspect receipt fields</summary><pre>${escape(JSON.stringify(receiptFor(request),null,2))}</pre></details></article>`).join('');
    renderBalance();
  }

  async function runRequest() {
    if (running || !quote || quote.expiresAt <= Date.now()) { tickQuote(); return; }
    if (quote.prompt !== $('prompt-input').value || quote.maxOutput !== Number($('output-limit').value)) { invalidateQuote(); return; }
    if (available < quote.cap) return;
    const accepted = {...quote};
    const currentGeneration = generation;
    const request = {id:`demo-${String(requests.length+1).padStart(4,'0')}`, task:accepted.task, createdAt:new Date().toISOString(), status:'Reserved', cap:accepted.cap, output:Math.min(model.outputTokens,accepted.maxOutput), charge:0};
    requests.push(request);
    running = true;
    available -= request.cap; reserved += request.cap;
    lockComposer(true); renderHistory();
    $('quote-state').textContent = 'Maximum reserved';
    $('quote-timer').textContent = 'Accepted';
    $('quote-disclaimer').textContent = 'The demo quote is locked for this simulated request.';
    $('result-panel').hidden = false;
    $('result-footer').hidden = true;
    $('result-heading').textContent = 'Your request is on its way.';
    $('result-status').textContent = 'Reserved';
    $('result-status').className = 'neutral-status';
    $('result-output').textContent = `${money(request.cap)} MOCK reserved from your demo balance.\nNo real model, wallet, or payment is connected.`;
    $('stage-reserved').className = 'done'; $('stage-running').className = ''; $('stage-completed').className = '';
    announce('Demo maximum reserved. Simulating a model request.');
    const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
    await pause(750);
    if (currentGeneration !== generation) return;
    request.status = 'Running'; renderHistory();
    $('stage-running').className = 'done';
    $('result-status').textContent = 'Running';
    $('result-output').textContent = 'Simulating a response to your selected sample task…\nYour prompt stays in this browser.';
    await pause(1100);
    if (currentGeneration !== generation) return;
    request.charge = Math.ceil((model.inputTokens * model.inputRate + request.output * model.outputRate) / 1000000);
    request.status = 'Completed';
    reserved -= request.cap; available += request.cap-request.charge;
    running = false; quote = null; lockComposer(false); renderHistory();
    $('quote-state').textContent = 'Request completed';
    $('quote-state').className = 'neutral-status completed';
    $('quote-timer').textContent = 'Settled';
    $('quote-disclaimer').textContent = 'Demo charge settled. Create a fresh quote to run another sample.';
    $('stage-completed').className = 'done';
    $('result-heading').textContent = 'A response. A clear record.';
    $('result-status').textContent = 'Completed · demo';
    $('result-status').className = 'neutral-status completed';
    $('result-output').textContent = samples[request.task].output;
    $('result-charged').textContent = `${money(request.charge)} MOCK`;
    $('result-released').textContent = `${money(request.cap-request.charge)} MOCK`;
    $('result-footer').hidden = false;
    $('download-latest').dataset.request = request.id;
    announce(`Demo request complete. Charged ${money(request.charge)} MOCK. Released ${money(request.cap-request.charge)} MOCK. Example receipt ready.`);
    toast('Demo request complete. Your example receipt is ready.');
  }

  function reset() {
    generation++;
    available = 1000000; reserved = 0; quote = null; requests = []; running = false;
    $('sample-task').value = 'classify'; $('output-limit').value = '500'; $('prompt-input').value = samples.classify.prompt;
    lockComposer(false); invalidateQuote(); renderHistory();
    $('result-panel').hidden = true;
    navigate('overview'); toast('Demo reset. Your sample balance is 1.000000 MOCK.');
  }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelectorAll('[data-start-request]').forEach(button => button.addEventListener('click', () => {navigate('overview'); $('prompt-input').focus();}));
  $('try-example').addEventListener('click', () => {navigate('overview'); $('prompt-input').focus();});
  $('new-request').addEventListener('click', () => {navigate('overview'); $('prompt-input').focus();});
  $('sample-task').addEventListener('change', () => { $('prompt-input').value = samples[$('sample-task').value].prompt; invalidateQuote('Sample changed — create a fresh quote.'); });
  $('prompt-input').addEventListener('input', () => invalidateQuote());
  $('output-limit').addEventListener('change', () => invalidateQuote('Output limit changed — create a fresh quote.'));
  $('create-quote').addEventListener('click', createQuote);
  $('run-request').addEventListener('click', runRequest);
  $('reset-demo').addEventListener('click', reset);
  $('reset-demo-mobile').addEventListener('click', reset);
  $('download-latest').addEventListener('click', () => downloadReceipt($('download-latest').dataset.request));
  document.addEventListener('click', event => { const button = event.target.closest('[data-download]'); if (button) downloadReceipt(button.dataset.download); });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  setInterval(tickQuote, 250);
  renderHistory();
  navigate(location.hash.slice(1) || 'overview');
})();
