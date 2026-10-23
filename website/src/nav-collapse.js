/* Progressive enhancement: faithful.js remains the owner of menu behavior. */
(() => {
  'use strict';
  if (window.OffpeakNavCollapse) return;

  const iconNames = {Home:'home',Solutions:'compute',Templates:'templates',Pricing:'pricing',Resources:'resources'};

  function mount() {
    const header = document.querySelector('.faithful-header');
    const nav = header?.querySelector('.faithful-links');
    if (!header || !nav || !window.OffpeakIcons) return;
    const controls = [...nav.querySelectorAll(':scope > .nav-link, :scope > .nav-group > .nav-trigger')];
    const panels = [...nav.querySelectorAll('.nav-dropdown')];
    const desktop = matchMedia('(min-width:641px)');
    let frame = 0;

    for (const control of controls) {
      const label = control.textContent.trim();
      if (!iconNames[label] || control.classList.contains('nav-collapse-control')) continue;
      const text = document.createElement('span');
      text.className = 'nav-collapse-label';
      text.textContent = label;
      text.setAttribute('aria-hidden','true');
      const icon = document.createElement('span');
      icon.className = 'nav-collapse-icon';
      icon.setAttribute('aria-hidden','true');
      icon.innerHTML = window.OffpeakIcons.svg(iconNames[label]);
      for (const child of [...control.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) child.remove();
      }
      const chevron = control.querySelector(':scope > svg');
      if (chevron) {
        chevron.classList.add('nav-collapse-chevron');
        chevron.setAttribute('aria-hidden','true');
        chevron.setAttribute('focusable','false');
      }
      control.prepend(icon,text);
      control.classList.add('nav-collapse-control');
      control.setAttribute('aria-label',label);
      if (control.matches('a')) control.title = label;
    }
    header.dataset.navCollapse = 'ready';

    function positionMenus() {
      frame = 0;
      if (!desktop.matches || document.hidden) return;
      const viewport = document.documentElement.clientWidth;
      for (const panel of panels) {
        const group = panel.closest('.nav-group');
        if (!group) continue;
        const rect = group.getBoundingClientRect();
        const width = Math.min(parseFloat(getComputedStyle(panel).width) || 290,viewport-24);
        const naturalLeft = rect.left + rect.width/2 - width/2;
        const clampedLeft = Math.max(12,Math.min(viewport-width-12,naturalLeft));
        panel.style.setProperty('--nav-menu-offset',(clampedLeft-naturalLeft).toFixed(2)+'px');
      }
    }
    function schedule() {
      if (!frame && !document.hidden) frame = requestAnimationFrame(positionMenus);
    }
    // Width changes include the CSS label collapse; no permanent animation loop is needed.
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(nav);
    const observer = new MutationObserver(schedule);
    observer.observe(header,{attributes:true,attributeFilter:['class']});
    for (const panel of panels) observer.observe(panel,{attributes:true,attributeFilter:['hidden']});
    addEventListener('resize',schedule,{passive:true});
    desktop.addEventListener('change',schedule);
    document.addEventListener('visibilitychange',schedule);
    positionMenus();
    window.OffpeakNavCollapse = {
      refresh:schedule,
      getState:() => ({desktop:desktop.matches,compact:header.classList.contains('is-scrolled'),controls:controls.length})
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',mount,{once:true});
  else mount();
})();
