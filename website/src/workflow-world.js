/* Front-facing workflow instruments. Local examples, no accounts or funds. */
(() => {
  'use strict';
  if (window.OffpeakWorkflowWorld) return;
  const groups = [
    {id:'structure', name:'Structure', title:'Give text a structure.', note:'Turn source material into fields you can inspect. Keep unknowns explicit.', machine:'intake', metric:'SOURCE → FIELDS', tasks:[['classification','Product classification'],['extraction','Field extraction'],['normalization','Record normalization']]},
    {id:'writing', name:'Writing', title:'Make the useful part clear.', note:'Condense and rewrite supplied text. Keep the facts, exceptions, and original within reach.', machine:'press', metric:'SOURCE → DRAFT', tasks:[['summarization','Document summary'],['rewrite','Plain-language edit'],['bullets','Bullet-point conversion']]},
    {id:'operations', name:'Operations', title:'Move work to the right place.', note:'Sort incoming requests, organize a queue, and find recurring feedback. People keep the final decision.', machine:'router', metric:'ROUTE → REVIEW', tasks:[['routing','Support routing'],['queue','Queue digest'],['feedback','Feedback themes']]},
    {id:'discovery', name:'Discovery', title:'Find what the text contains.', note:'Collect named entities, select useful tags, and suggest keywords grounded in the source.', machine:'chip', metric:'TEXT → SIGNAL', tasks:[['tagging','Content tagging'],['entities','Entity collection'],['keywords','Keyword suggestions']]},
    {id:'review', name:'Review', title:'Look closely before accepting.', note:'Compare stated attributes, inspect possible duplicates, and review tone without losing the original.', machine:'compare', metric:'COMPARE → CHECK', tasks:[['comparison','Attribute comparison'],['duplicate','Duplicate review'],['tone','Tone review']]},
    {id:'delivery', name:'Delivery', title:'Prepare a reviewable result.', note:'Draft questions and headlines, then inspect structured fields. Every output remains an example to review.', machine:'terminal', metric:'DRAFT → VALIDATE', tasks:[['faq','FAQ drafting'],['headlines','Headline options'],['validation','Schema review']]}
  ];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = matchMedia('(max-width:700px)');
  const compact = matchMedia('(max-width:700px) and (max-height:640px)');
  const fine = matchMedia('(hover:hover) and (pointer:fine)');
  const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,v));
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let mounted = false;

  function solid({x=0,y=0,w=100,d=80,h=25,z=0,kind='',content='',delay=0,vents=true}) {
    // The instrument face stays square to the page. A small lower lip provides
    // tactile depth without a rotated camera or an enclosing scene card.
    const edge = kind.includes('ww-sheet') ? 2 : kind.includes('ww-tag') ? 3 : Math.min(8,Math.max(4,h/7));
    const hardware = vents && !kind.includes('ww-belt');
    const fasteners = hardware
      ? ['tl','tr','bl','br'].map(corner=>`<i class="ww-fastener ${corner}"></i>`).join('')
      : '';
    const ports = hardware ? '<span class="ww-service-ports"><i></i><i></i><i></i></span><i class="ww-case-seam"></i>' : '';
    const front = vents ? '<i class="ww-vent"></i><i class="ww-side-serial"></i>'+ports : '';
    return `<div class="ww-solid ${hardware?'ww-hardware ':''}${kind}" style="--x:${x}px;--y:${y}px;--w:${w}px;--d:${d}px;--edge:${edge}px;--delay:${delay}s"><div class="ww-face ww-front">${front}</div><div class="ww-face ww-top">${content}${fasteners}</div></div>`;
  }
  function sheet(x,y,title,z=25,w=103,d=72,delay=0) {
    return solid({x,y,w,d,h:4,z,kind:'ww-sheet ww-float',delay,vents:false,content:`<div class="ww-sheet-title">${title}</div><div class="ww-sheet-line"></div><div class="ww-sheet-line"></div><div class="ww-sheet-line"></div><span class="ww-sheet-check">✓</span><i class="ww-sheet-code"></i>`});
  }
  const screen = (label,title,extra='') => `<div class="ww-screen"><small>${label}</small><strong>${title}</strong>${extra||'<i class="ww-screen-line"></i><i class="ww-screen-line"></i><i class="ww-screen-line"></i>'}</div>`;
  const caption = text => `<div class="ww-machine-caption"><span>${text}</span><i></i></div>`;
  const tag = (x,y,text,z=30,w=90) => solid({x,y,w,d:30,h:7,z,kind:'ww-tag ww-float',vents:false,content:`<i class="ww-tag-dot"></i>${text}`});

  function connections(machine,index) {
    // Thin task-specific routes join mechanisms without outlining a district box.
    const routes = {
      intake:'M105 197V224H271V204M188 139H211V112H234',
      press:'M100 70V91M174 152H195V78H220M195 152H220M195 152V222H220',
      router:'M66 146H277M174 68V220M68 235H174H279',
      chip:'M176 141V57H82M176 141H274V54M176 141V216H65M176 141H280V221',
      compare:'M94 198V229H263V198M158 126H193',
      terminal:'M121 205V233M206 138H217V70H244M217 138H244M217 138V211H244'
    };
    const path = routes[machine];
    return `<svg class="ww-connections" viewBox="0 0 350 285" aria-hidden="true" style="--delay:${index*-1.2}s"><path class="ww-connection" d="${path}"/><path class="ww-connection-live" d="${path}"/></svg>`;
  }

  function architecture(group,index) {
    let body = '';
    if (group.machine === 'intake') {
      body += solid({x:24,y:86,w:164,d:116,h:48,z:17,content:'<div class="ww-fan"><i></i><span class="ww-fan-guard"></span></div><div class="ww-fan"><i></i><span class="ww-fan-guard"></span></div>'+caption('OPEN MODEL / DEMO')});
      body += solid({x:39,y:223,w:134,d:26,h:18,z:17,kind:'ww-belt',content:'<div class="ww-belt-arrow"><span>›</span><span>›</span><span>›</span></div>'});
      body += sheet(224,45,'SOURCE TEXT',27,101,74,-.7)+sheet(219,54,'SOURCE TEXT',37,101,74,-1.2)+sheet(214,63,'SOURCE TEXT',47,101,74,-1.7);
      body += solid({x:215,y:173,w:114,d:67,h:17,z:17,kind:'ww-result',content:screen('CATEGORY','HOME / LIGHT','<i class="ww-scan"></i>')});
    } else if (group.machine === 'press') {
      body += solid({x:26,y:91,w:148,d:122,h:62,z:17,content:screen('REVIEWABLE DRAFT','3 KEY POINTS','<i class="ww-screen-line"></i><i class="ww-screen-line"></i><i class="ww-screen-line"></i><i class="ww-scan"></i>')+caption('TEXT PRESS / DEMO')});
      body += solid({x:45,y:40,w:110,d:30,h:33,z:17,kind:'ww-belt',content:'<div class="ww-belt-arrow"><span>›</span><span>›</span></div>'});
      body += sheet(216,51,'ORIGINAL',29,109,52,-.5)+sheet(216,124,'CLEARER DRAFT',49,109,52,-1.5)+sheet(216,197,'KEEP THE CAVEAT',69,109,52,-2.5);
      body += tag(40,233,'HUMAN REVIEW',23,120);
    } else if (group.machine === 'router') {
      body += solid({x:118,y:89,w:112,d:116,h:62,z:17,kind:'ww-tower',content:'<div class="ww-holo"><i class="ww-radar-dot"></i><i class="ww-radar-dot"></i><i class="ww-radar-dot"></i></div>'+caption('ROUTING / DEMO')});
      body += solid({x:25,y:134,w:66,d:24,h:11,z:17,kind:'ww-belt',content:'<div class="ww-belt-arrow"><span>›</span><span>›</span></div>'});
      body += solid({x:254,y:134,w:70,d:24,h:11,z:17,kind:'ww-belt',content:'<div class="ww-belt-arrow"><span>›</span><span>›</span></div>'});
      body += tag(22,38,'QUEUED',24,82)+tag(134,38,'REVIEW',31,82)+tag(246,38,'READY',24,82);
      body += sheet(26,212,'FEEDBACK',23,86,44,-1)+sheet(238,212,'NEXT ACTION',23,86,44,-3);
    } else if (group.machine === 'chip') {
      body += solid({x:120,y:85,w:112,d:112,h:25,z:17,kind:'ww-chip',content:'<div class="ww-chip-pins"></div><div class="ww-chip-pins bottom"></div><div class="ww-chip-pins left"></div><div class="ww-chip-pins right"></div><div class="ww-chip-core">{ }</div>'});
      body += tag(26,42,'ORGANIZATION',36,104)+tag(224,38,'KEYWORDS',38,100)+tag(21,202,'SOURCE ID',32,94)+tag(234,207,'TAG / DOCS',32,94);
      body += solid({x:140,y:221,w:70,d:20,h:8,z:17,kind:'ww-belt',vents:false});
    } else if (group.machine === 'compare') {
      body += solid({x:32,y:68,w:126,d:130,h:52,z:17,kind:'ww-tower',content:screen('ORIGINAL / A','RECORD A','<i class="ww-screen-line"></i><i class="ww-screen-line"></i><i class="ww-scan"></i>')});
      body += solid({x:192,y:68,w:126,d:130,h:52,z:17,kind:'ww-tower',content:screen('ORIGINAL / B','RECORD B','<i class="ww-screen-line"></i><i class="ww-screen-line"></i><i class="ww-scan" style="--delay:-2s"></i>')});
      body += solid({x:156,y:114,w:38,d:23,h:10,z:37,kind:'ww-belt',content:'<div class="ww-belt-arrow"><span>↔</span></div>'});
      body += sheet(103,216,'KEEP BOTH ORIGINALS',33,144,43,-1.5);
    } else {
      body += solid({x:32,y:71,w:174,d:134,h:58,z:17,content:screen('STRUCTURED EXAMPLE','{ "review": true }','<div class="ww-meter-bars"><i style="--bar:50%;--delay:-.2s"></i><i style="--bar:74%;--delay:-.9s"></i><i style="--bar:62%;--delay:-1.5s"></i><i style="--bar:93%;--delay:-2.1s"></i><i style="--bar:80%;--delay:-2.7s"></i></div>')+caption('SCHEMA CHECK / DEMO')});
      body += sheet(229,45,'FAQ / DRAFT',29,96,50,-.6)+sheet(229,118,'HEADLINES',43,96,50,-1.6)+sheet(229,191,'FIELD REVIEW',57,96,50,-2.6);
      body += tag(47,233,'REVIEW BEFORE USE',22,145);
    }
    return `<div class="ww-district" data-world-district="${index}" style="--x:${index*450}px">${connections(group.machine,index)}<span class="ww-district-number">${group.name.toUpperCase()} / 03 FLOWS</span>${body}<div class="ww-district-label"><span>${group.metric}</span><b>0${index+1}</b></div></div>`;
  }

  function mount() {
    if (mounted) return;
    const section = document.querySelector('#templates');
    const fallback = section?.querySelector('.gallery-marquee');
    if (!section || !fallback) return;
    const world = document.createElement('div');
    world.className = 'workflow-world';
    world.dataset.paused = 'false'; world.dataset.visible = 'false';
    world.innerHTML = `<div class="ww-journey"><div class="ww-sticky"><div class="ww-topline"><span><i class="ww-led"></i>18 WORKFLOWS / ONE CONNECTED WORLD</span><button class="ww-pause" type="button" aria-pressed="false"><span aria-hidden="true">Ⅱ</span><span>Pause motion</span></button></div><div class="ww-viewport" aria-hidden="true"><div class="ww-camera"><div class="ww-map">${groups.map(architecture).join('')}</div></div></div><section class="ww-info" aria-labelledby="ww-title"><div class="ww-info-kicker"><span data-world-kicker>01 / STRUCTURE</span><span>ILLUSTRATIVE</span></div><h3 id="ww-title"></h3><p data-world-note></p><div class="ww-links"></div><small>No request sent. Review every output.</small></section><div class="ww-controls"><nav class="ww-tabs" aria-label="Workflow districts">${groups.map((g,i)=>`<button class="ww-tab" type="button" data-world-select="${i}" aria-pressed="${i===0}"><span>0${i+1}</span><span>${g.name}</span></button>`).join('')}</nav><span class="ww-scroll-note">SCROLL TO EXPLORE<br>OR CHOOSE A DISTRICT ↗</span></div><div class="ww-progress" aria-hidden="true"><i></i></div></div></div><details class="ww-all"><summary>Browse all 18 workflows</summary><nav class="ww-all-links" aria-label="All workflows">${groups.flatMap(g=>g.tasks).map(([id,title])=>`<a href="/templates/?workflow=${id}#workflow-detail">${escape(title)} ↗</a>`).join('')}</nav></details>`;
    fallback.before(world);
    const journey = world.querySelector('.ww-journey');
    const sticky = world.querySelector('.ww-sticky');
    const camera = world.querySelector('.ww-camera');
    const viewport = world.querySelector('.ww-viewport');
    const map = world.querySelector('.ww-map');
    const pauseButton = world.querySelector('.ww-pause');
    const tabs = [...world.querySelectorAll('[data-world-select]')];
    const districts = [...world.querySelectorAll('[data-world-district]')];
    let active = -1;
    let visible = false;
    let paused = false;
    let manual = null;
    let touchOrigin = null;
    let progress = 0;
    let raf = 0;
    let previous = 0;
    let pointerX = 0, pointerY = 0;
    let current = {x:0,y:0,zoom:1};
    let target = {...current};

    function setDistrict(index) {
      index = clamp(index,0,5);
      if (active === index) return;
      active = index;
      const group = groups[index];
      world.querySelector('[data-world-kicker]').textContent = `0${index+1} / ${group.name.toUpperCase()}`;
      world.querySelector('#ww-title').textContent = group.title;
      world.querySelector('[data-world-note]').textContent = group.note;
      world.querySelector('.ww-links').innerHTML = group.tasks.map(([id,title])=>`<a href="/templates/?workflow=${id}#workflow-detail"><span>${escape(title)}</span><span aria-hidden="true">↗</span></a>`).join('');
      tabs.forEach((tab,i)=>tab.setAttribute('aria-pressed',String(i===index)));
      districts.forEach((district,i)=>district.classList.toggle('is-current',i===index));
    }

    function waypoint(index) {
      const fit = Math.min(mobile.matches ? .96 : 1.8,
        viewport.clientWidth/374,viewport.clientHeight/305);
      return {x:-Math.max(0,index)*450,y:0,zoom:Math.max(.4,fit)};
    }
    function sampleCamera(value) {
      if (manual !== null) return waypoint(manual);
      if (reduce.matches || compact.matches) return waypoint(active < 0?0:active);
      const sequence = [0,0,1,2,3,4,5,5];
      const position = value*(sequence.length-1);
      const step = Math.min(sequence.length-2,Math.floor(position));
      // A short hold lets each district read before the next travel starts.
      let amount = clamp((position-step-.12)/.76);
      amount = amount*amount*(3-2*amount);
      const a = waypoint(sequence[step]); const b = waypoint(sequence[step+1]);
      const result = {};
      for (const key in a) result[key] = a[key]+(b[key]-a[key])*amount;
      const district = sequence[Math.min(7,Math.round(position))];
      if (district >= 0) setDistrict(district);
      return result;
    }
    function measureProgress() {
      const rect = journey.getBoundingClientRect();
      const top = parseFloat(getComputedStyle(sticky).top)||0;
      const distance = Math.max(1,journey.offsetHeight-sticky.offsetHeight);
      progress = clamp((top-rect.top)/distance);
      world.style.setProperty('--ww-progress',progress.toFixed(4));
    }
    function render(immediate=false) {
      target = sampleCamera(progress);
      if (!reduce.matches && !paused) { target.x+=pointerX*2; target.y+=pointerY*2; }
      if (immediate) current = {...target};
      // A restrained light follows the same local pointer as the camera, without extra loops.
      world.style.setProperty('--ww-light-x',`${(28+pointerX*14).toFixed(2)}%`);
      world.style.setProperty('--ww-light-y',`${(14+pointerY*10).toFixed(2)}%`);
      camera.style.setProperty('--ww-zoom',current.zoom.toFixed(4));
      map.style.setProperty('--ww-pan-x',`${current.x.toFixed(2)}px`);
      map.style.setProperty('--ww-pan-y',`${current.y.toFixed(2)}px`);
    }
    function tick(now) {
      raf = 0;
      if (!visible || document.hidden || paused || reduce.matches) return;
      const dt = previous?Math.min(.05,(now-previous)/1000):1/60;
      previous = now;
      measureProgress(); render();
      const blend = 1-Math.exp(-7*dt);
      let moving = false;
      for (const key in current) {
        current[key]+=(target[key]-current[key])*blend;
        if (Math.abs(target[key]-current[key])>(key==='zoom'?.0001:.025)) moving=true;
      }
      render();
      if (moving) raf=requestAnimationFrame(tick);
    }
    function wake() {
      if (raf || !visible || document.hidden || paused) return;
      if (reduce.matches) { measureProgress(); render(true); return; }
      previous=0; raf=requestAnimationFrame(tick);
    }
    function select(index) {
      manual=index; setDistrict(index);
      if (paused || reduce.matches) { measureProgress(); render(true); }
      else wake();
    }
    function setPaused(value) {
      paused=Boolean(value); world.dataset.paused=String(paused || reduce.matches);
      pauseButton.setAttribute('aria-pressed',String(paused));
      pauseButton.innerHTML=`<span aria-hidden="true">${paused?'▷':'Ⅱ'}</span><span>${paused?'Resume motion':'Pause motion'}</span>`;
      if (raf) cancelAnimationFrame(raf); raf=0;
      if (!paused) wake();
    }
    pauseButton.addEventListener('click',()=>setPaused(!paused));
    tabs.forEach((tab,index)=> {
      tab.addEventListener('click',()=>select(index));
      tab.addEventListener('keydown',event=> {
        let next;
        if(event.key==='ArrowRight')next=(index+1)%6;
        else if(event.key==='ArrowLeft')next=(index+5)%6;
        else if(event.key==='Home')next=0;
        else if(event.key==='End')next=5;
        else return;
        event.preventDefault();tabs[next].focus({preventScroll:true});select(next);
      });
    });
    sticky.addEventListener('pointermove',event=> {
      if (!fine.matches || event.pointerType==='touch' || reduce.matches || paused) return;
      const rect=sticky.getBoundingClientRect();
      pointerX=clamp((event.clientX-rect.left)/rect.width)*2-1;
      pointerY=clamp((event.clientY-rect.top)/rect.height)*2-1;wake();
    },{passive:true});
    sticky.addEventListener('pointerleave',()=>{pointerX=pointerY=0;wake();},{passive:true});
    // Focus, browser anchoring, and a smooth-scroll tail may move the page after
    // selecting a district. Only a new user scroll gesture releases that choice.
    function releaseManual() {
      if (manual === null) return;
      manual = null;
      wake();
    }
    window.addEventListener('wheel',event=> {
      if (!event.ctrlKey && Math.abs(event.deltaY) > 0) releaseManual();
    },{passive:true});
    window.addEventListener('touchstart',event=> {
      touchOrigin = event.touches.length === 1
        ? {x:event.touches[0].clientX,y:event.touches[0].clientY} : null;
    },{passive:true});
    window.addEventListener('touchmove',event=> {
      if (!touchOrigin || event.touches.length !== 1) return;
      const dx = Math.abs(event.touches[0].clientX-touchOrigin.x);
      const dy = Math.abs(event.touches[0].clientY-touchOrigin.y);
      if (dy > 10 && dy > dx) { releaseManual(); touchOrigin = null; }
    },{passive:true});
    const endTouch = () => { touchOrigin = null; };
    window.addEventListener('touchend',endTouch,{passive:true});
    window.addEventListener('touchcancel',endTouch,{passive:true});
    window.addEventListener('keydown',event=> {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const node = event.target instanceof Element ? event.target : null;
      if (node?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      const isSpace = event.key === ' ' || event.key === 'Spacebar';
      if (isSpace && node?.closest('button,summary,[role="button"],[role="checkbox"],[role="switch"]')) return;
      if (isSpace || ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key)) releaseManual();
    });
    window.addEventListener('pointerdown',event=> {
      // Native scrollbar dragging is intentional; ordinary focus clicks are not.
      const root = document.documentElement;
      const inGutter = window.innerWidth > root.clientWidth && event.clientX >= root.clientWidth;
      const overlayEdge = event.target === root && event.clientX >= window.innerWidth-8;
      if (event.button === 0 && (inGutter || overlayEdge)) releaseManual();
    },{passive:true});
    window.addEventListener('scroll',wake,{passive:true});
    new ResizeObserver(()=>{measureProgress(); if(paused||reduce.matches)render(true);else wake();}).observe(sticky);
    new IntersectionObserver(entries=> {
      visible=entries[0].isIntersecting;world.dataset.visible=String(visible);
      if(!visible && raf){cancelAnimationFrame(raf);raf=0;}
      else wake();
    },{threshold:0.01}).observe(sticky);
    document.addEventListener('visibilitychange',()=> {
      world.dataset.visible=String(visible&&!document.hidden);
      if(document.hidden && raf){cancelAnimationFrame(raf);raf=0;}else wake();
    });
    reduce.addEventListener('change',()=>{world.dataset.paused=String(paused||reduce.matches);measureProgress();render(true);wake();});
    mobile.addEventListener('change',()=>{measureProgress();render(true);wake();});
    compact.addEventListener('change',()=>{measureProgress();render(true);wake();});

    setDistrict(0); measureProgress(); render(true);
    world.dataset.paused=String(reduce.matches);
    // The full original gallery remains available if setup ever fails before this point.
    fallback.hidden=true;fallback.setAttribute('aria-hidden','true');fallback.style.display='none';
    section.dataset.workflowWorld='ready';mounted=true;
    window.OffpeakWorkflowWorld={selectDistrict:select,setPaused,getState:()=>({active,paused,progress,visible,workflows:18})};
  }

  function start() {
    try { mount(); } catch(error) { console.warn('Workflow world could not start; original gallery retained.',error); }
    if (!mounted) {
      const observer=new MutationObserver(()=>{try{mount();}catch(_){/* Keep the original gallery. */}if(mounted)observer.disconnect();});
      observer.observe(document.body,{childList:true,subtree:true});
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
