/* Frontend-only interactions for the OFFPEAK product-preview pages. */
const pageToast = document.createElement('div');
pageToast.className = 'pages-toast';
pageToast.setAttribute('role', 'status');
pageToast.setAttribute('aria-live', 'polite');
document.body.append(pageToast);
let toastTimer;
function announce(message) {
  pageToast.textContent = message;
  pageToast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => pageToast.classList.remove('is-visible'), 2600);
}
async function copyExample(value, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.cssText = 'position:fixed;left:-10000px;top:0';
      document.body.append(area);
      area.select();
      const success = document.execCommand('copy');
      area.remove();
      if (!success) throw new Error('Clipboard unavailable');
    }
    announce('Example copied.');
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1600);
    }
  } catch {
    announce('Clipboard unavailable. Select the visible example to copy it.');
  }
}
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => copyExample(button.dataset.copy, button)));

const galleryData = document.querySelector('#workflow-data');
if (galleryData) {
  const workflows = JSON.parse(galleryData.textContent);
  const detail = document.querySelector('#workflow-detail');
  const cards = [...document.querySelectorAll('[data-workflow]')];
  const filterButtons = [...document.querySelectorAll('[data-filter]')];
  function selectWorkflow(id, shouldFocus = false) {
    const workflow = workflows.find(item => item.id === id);
    if (!workflow) return;
    detail.hidden = false;
    detail.querySelector('[data-workflow-title]').textContent = workflow.title;
    detail.querySelector('[data-workflow-description]').textContent = workflow.description;
    detail.querySelector('[data-workflow-review]').textContent = workflow.review;
    detail.querySelector('#workflow-prompt').value = workflow.prompt;
    cards.forEach(card => card.setAttribute('aria-current', String(card.dataset.workflow === id)));
    if (shouldFocus) {
      const url = new URL(location.href);
      url.searchParams.set('workflow', id);
      url.hash = 'workflow-detail';
      history.pushState({workflow: id}, '', url);
      detail.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
      detail.focus({preventScroll: true});
    }
  }
  filterButtons.forEach(button => button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    filterButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    let count = 0;
    cards.forEach(card => { const show = filter === 'All' || card.dataset.category === filter; card.hidden = !show; if (show) count++; });
    document.querySelector('[data-filter-count]').textContent = `${count} workflow${count === 1 ? '' : 's'}`;
  }));
  cards.forEach(card => card.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    selectWorkflow(card.dataset.workflow, true);
  }));
  document.querySelector('[data-copy-prompt]').addEventListener('click', event => copyExample(detail.querySelector('#workflow-prompt').value, event.currentTarget));
  selectWorkflow(new URL(location.href).searchParams.get('workflow'));
  addEventListener('popstate', () => {
    const id = new URL(location.href).searchParams.get('workflow');
    if (id) selectWorkflow(id);
    else detail.hidden = true;
  });
}

const flowData = document.querySelector('#flow-data');
if (flowData) {
  const flow = JSON.parse(flowData.textContent);
  const tabs = [...document.querySelectorAll('[data-flow]')];
  let current = 'quote';
  function selectFlow(key) {
    if (!flow[key]) return;
    current = key;
    tabs.forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.flow === key));
      button.tabIndex = button.dataset.flow === key ? 0 : -1;
    });
    for (const field of ['title', 'description', 'code', 'state', 'result', 'limit']) document.querySelector(`[data-flow-${field}]`).textContent = flow[key][field];
    document.querySelector('#flow-panel').setAttribute('aria-labelledby', 'flow-tab-' + key);
  }
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => selectFlow(button.dataset.flow));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectFlow(tabs[next].dataset.flow);
      tabs[next].focus();
    });
  });
  document.querySelector('[data-copy-flow]').addEventListener('click', event => copyExample(flow[current].code, event.currentTarget));
  selectFlow('quote');
}

document.querySelectorAll('[data-usage]').forEach(button => button.addEventListener('click', () => {
  const output = Number(button.dataset.usage);
  const charge = (1000 * 200000 + output * 600000) / 1e12;
  document.querySelector('[data-example-charge]').textContent = charge.toFixed(6);
  document.querySelector('[data-example-release]').textContent = (0.000500 - charge).toFixed(6);
  document.querySelector('[data-example-output]').textContent = String(output);
  document.querySelectorAll('[data-usage]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));
