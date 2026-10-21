/* A scroll-led conversation about the proposed request lifecycle. */
(() => {
  'use strict';
  const section=document.querySelector('#about'); if(!section)return;
  const steps=[
    ['CAPACITY','What can I use OFFPEAK for?','Run AI without owning the hardware.','Use an open AI model to summarize, sort, or pull information from text. OFFPEAK is being built to run that work on spare computing power.','SPARE POWER → USEFUL WORK'],
    ['QUOTE','Why is it called off-peak?','Spare capacity can mean a better price.','When computing power is available, its price can change. You see the quote before each request. Savings depend on supply; they are not guaranteed.','SEE THE PRICE FIRST'],
    ['AUTHORIZE','Can it spend more than I allow?','You choose the most you will spend.','Set a limit and approve the request. That limit is the maximum it can charge. You do not give the AI an open-ended budget.','YOUR REQUEST. YOUR LIMIT.'],
    ['SETTLE','Do I pay the whole maximum?','Pay for the work that runs.','Your maximum is held while the request runs. After a successful response, measured usage is charged and the unused amount is released.','UNUSED AMOUNT → BACK TO YOU'],
    ['RECEIPT','What do I get afterward?','The answer, with a clear receipt.','You receive the AI response and a private record of usage and cost. The receipt explains the bill; it does not guarantee the answer is correct.','A RESULT + A BILLING RECORD']
  ];
  const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const compact=matchMedia('(max-width:360px), (max-width:600px) and (max-height:640px)');
  section.dataset.techConversation='true';
  section.innerHTML=`<div class="tech-stage"><header class="tech-heading"><span class="tech-eyebrow">THE IDEA BEHIND OFFPEAK</span><h2>Spare computing power.<br>Useful AI.</h2><p class="tech-intro">GPUs are the powerful chips that run AI. We put their spare capacity to work.</p></header><div class="tech-dialogue"><svg class="tech-connectors" viewBox="0 0 1000 440" preserveAspectRatio="none" aria-hidden="true"><path d="M300 165C390 165 400 220 465 220M535 220C610 220 625 270 700 270"/><path class="tech-signal" d="M300 165C390 165 400 220 465 220M535 220C610 220 625 270 700 270"/></svg><div class="tech-robot" aria-hidden="true"><div class="tech-robot-shadow"></div><img src="/assets/offpeak-white-mark.svg" alt=""><span class="tech-robot-pulse"></span><span class="tech-robot-caption">OFFPEAK / <b data-tech-mode>CAPACITY</b></span></div>${steps.map((s,i)=>`<div class="tech-pair${i===0?' is-current':''}" id="tech-topic-${i}" data-tech-pair="${i}"${i?' aria-hidden="true"':''}><article class="tech-bubble tech-question"><span class="tech-bubble-label">YOU / ${String(i+1).padStart(2,'0')}</span><h3>${s[1]}</h3><div class="tech-typing" aria-hidden="true"><i></i><i></i><i></i></div></article><article class="tech-bubble tech-answer"><span class="tech-bubble-label">OFFPEAK / ${s[0]}</span><h3>${s[2]}</h3><p>${s[3]}</p><span class="tech-code">${s[4]}</span></article></div>`).join('')}</div><footer class="tech-footer"><span>SCROLL TO FOLLOW THE REQUEST</span><div role="group" aria-label="Technology topics">${steps.map((s,i)=>`<button type="button" data-tech-step="${i}" aria-controls="tech-topic-${i}" aria-label="Explain ${s[0].toLowerCase()}" aria-pressed="${!i}"><i></i><span>${s[0]}</span></button>`).join('')}</div><a href="/docs/">Explore the technical guide ↗</a></footer></div>`;
  const stage = section.querySelector('.tech-stage');
  const robot = section.querySelector('.tech-robot');
  const pairs = [...section.querySelectorAll('.tech-pair')];
  const buttons = [...section.querySelectorAll('[data-tech-step]')];
  const motionButton = document.createElement('button');
  motionButton.type = 'button';
  motionButton.className = 'tech-motion-toggle';
  stage.append(motionButton);
  let raf = 0, current = -1, visible = false, paused = false;
  let targetX = 0, targetY = 0, x = 0, y = 0;
  let manual = reduced.matches || compact.matches ? 0 : -1;
  let transitionToken = 0, topicAnimations = [], touchOrigin = null;

  function motionState() {
    const staticMotion = paused || reduced.matches;
    section.dataset.techPaused = String(staticMotion);
    section.dataset.techVisible = String(visible && !document.hidden);
    motionButton.disabled = reduced.matches;
    motionButton.setAttribute('aria-pressed', String(staticMotion));
    const label = reduced.matches ? 'Motion disabled by reduced-motion preference' :
      paused ? 'Resume decorative motion' : 'Pause decorative motion';
    motionButton.setAttribute('aria-label', label);
    motionButton.title = label;
    motionButton.innerHTML = `<span aria-hidden="true">${staticMotion ? '▷' : 'Ⅱ'}</span><span>${reduced.matches ? 'Motion off' : paused ? 'Resume motion' : 'Pause motion'}</span>`;
    if ((!visible || document.hidden || staticMotion) && raf) {
      cancelAnimationFrame(raf); raf = 0;
    }
  }
  function showPair(index) {
    pairs.forEach((pair,i) => {
      pair.classList.toggle('is-current',i===index);
      pair.setAttribute('aria-hidden',String(i!==index));
      pair.inert=i!==index;
    });
  }
  function choose(index) {
    if (current === index) return;
    const previous=pairs.find(pair=>pair.classList.contains('is-current'));
    const outgoing=[...(previous?.querySelectorAll('.tech-bubble')||[])];
    const from=outgoing.map(node=>({opacity:getComputedStyle(node).opacity}));
    const animate=current>=0&&visible&&!document.hidden&&!paused&&!reduced.matches&&typeof Element.prototype.animate==='function';
    const token=++transitionToken;
    topicAnimations.forEach(animation=>animation.cancel());topicAnimations=[];
    current = index;
    section.dataset.techStep = String(index);
    const mode=section.querySelector('[data-tech-mode]');
    if(mode)mode.textContent=steps[index][0];
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    if(!animate)showPair(index);
    else {
      // Fade the old answer away before introducing the selected one: 720ms total.
      if(previous){previous.inert=true;previous.setAttribute('aria-hidden','true');}
      const exits=outgoing.map((node,i)=>node.animate([from[i],{opacity:0}],{duration:200,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'}));
      topicAnimations=exits;
      Promise.all(exits.map(animation=>animation.finished.catch(()=>{}))).then(()=>{
        if(token!==transitionToken)return;
        showPair(index);exits.forEach(animation=>animation.cancel());
        topicAnimations=[...pairs[index].querySelectorAll('.tech-bubble')].map(node=>node.animate([{opacity:0},{opacity:1}],{duration:520,easing:'cubic-bezier(.22,1,.36,1)'}));
        Promise.all(topicAnimations.map(animation=>animation.finished.catch(()=>{}))).then(()=>{if(token===transitionToken)topicAnimations=[];});
      });
    }
    robot.classList.remove('is-speaking');
    if (!paused && !reduced.matches && robot.dataset.gpuCompanion!=='true') {
      void robot.offsetWidth;
      robot.classList.add('is-speaking');
    }
  }
  function tick(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const rect = section.getBoundingClientRect();
    const progress = Math.max(0, Math.min(.999, -rect.top / Math.max(1, section.offsetHeight - innerHeight)));
    choose(manual >= 0 ? manual : Math.floor(progress * steps.length));
    if (!reduced.matches && !paused && robot.dataset.gpuCompanion!=='true') {
      x += (targetX - x) * .08; y += (targetY - y) * .08;
      robot.style.setProperty('--tech-rx', `${-y * 12}deg`);
      robot.style.setProperty('--tech-ry', `${x * 22}deg`);
      robot.style.setProperty('--tech-float', `${Math.sin(now / 1100) * 5}px`);
      raf = requestAnimationFrame(tick);
    }
  }
  function wake() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
  }
  motionButton.addEventListener('click', () => {
    if (reduced.matches) return;
    paused = !paused;
    motionState();
    wake();
  });
  buttons.forEach((button, index) => button.addEventListener('click', () => {
    manual=index;
    choose(index);
    if (!reduced.matches && !paused && !compact.matches) {
      const top = section.getBoundingClientRect().top + scrollY +
        (index + .3) / steps.length * (section.offsetHeight - innerHeight);
      if (window.OffpeakScroll) window.OffpeakScroll.scrollTo(top, {duration: .75});
      else scrollTo({top, behavior: 'smooth'});
    }
    wake();
  }));
  stage.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || paused || reduced.matches || robot.dataset.gpuCompanion==='true') return;
    const rect = stage.getBoundingClientRect();
    targetX = (event.clientX - rect.left) / rect.width * 2 - 1;
    targetY = (event.clientY - rect.top) / rect.height * 2 - 1;
  }, {passive: true});
  stage.addEventListener('pointerleave', () => { targetX = targetY = 0; }, {passive: true});
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    motionState();
    wake();
  }, {rootMargin: '100px'}).observe(section);
  // Selection survives its own smooth scroll and browser focus scrolling. A new
  // intentional scroll gesture hands control back to the scroll-led story.
  function releaseManual() {
    if(reduced.matches||paused||compact.matches)return;
    manual=-1;wake();
  }
  addEventListener('wheel',event=>{if(!event.ctrlKey&&Math.abs(event.deltaY)>0)releaseManual();},{passive:true});
  addEventListener('touchstart',event=>{touchOrigin=event.touches.length===1?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;},{passive:true});
  addEventListener('touchmove',event=>{
    if(!touchOrigin||event.touches.length!==1)return;
    const dx=Math.abs(event.touches[0].clientX-touchOrigin.x),dy=Math.abs(event.touches[0].clientY-touchOrigin.y);
    if(dy>10&&dy>dx){releaseManual();touchOrigin=null;}
  },{passive:true});
  addEventListener('touchend',()=>{touchOrigin=null;},{passive:true});
  addEventListener('touchcancel',()=>{touchOrigin=null;},{passive:true});
  addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey)return;
    const node=event.target instanceof Element?event.target:null;
    if(node?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
    const space=event.key===' '||event.key==='Spacebar';
    if(space&&node?.closest('button,summary,[role="button"]'))return;
    if(space||['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))releaseManual();
  });
  addEventListener('pointerdown',event=>{
    const root=document.documentElement;
    if(event.button===0&&((innerWidth>root.clientWidth&&event.clientX>=root.clientWidth)||(event.target===root&&event.clientX>=innerWidth-8)))releaseManual();
  },{passive:true});
  addEventListener('scroll',wake,{passive:true});
  document.addEventListener('visibilitychange', () => { motionState(); wake(); });
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      manual = Math.max(0, current);
      ++transitionToken;topicAnimations.forEach(animation=>animation.cancel());topicAnimations=[];showPair(manual);
      robot.style.setProperty('--tech-rx', '0deg');
      robot.style.setProperty('--tech-ry', '0deg');
      robot.style.setProperty('--tech-float', '0px');
    }
    motionState();
    wake();
  });
  compact.addEventListener('change', () => {
    manual = compact.matches || reduced.matches ? Math.max(0,current) : -1;
    wake();
  });
  choose(0);
  motionState();
  section._offpeakConversation={select:index=>buttons[Math.max(0,Math.min(4,index))].click(),getState:()=>({current,manual,paused,compact:compact.matches})};
})();
