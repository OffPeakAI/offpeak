/* Four native camera shots of the existing Anatomy Figures, not a rendered video.
   Geometry stays intact; only its original moving refs and the artwork camera move. */
(() => {
  'use strict';
  if (window.OffpeakCTACinema) return;
  const selector = '#get-started [data-closing="panel"]';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover:hover) and (pointer:fine)');
  const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,v));
  const ease = t => t*t*(3-2*t);
  const duration = 6.4, blend = 1.05;
  const shots = [
    {label:'Capacity, up close',from:[1.06,-1.8,1],to:[1.22,1.6,-2.2],machines:[
      ['capacity',18,55,720,-14,530,false],['scanner',89,56,570,121,420,true]]},
    {label:'A request in motion',from:[1.17,2.1,1.6],to:[1.03,-2.2,-1],machines:[
      ['sorter',21,54,690,-12,480,false],['scanner',85,50,620,113,460,true]]},
    {label:'A record you keep',from:[1.11,-1.4,-.8],to:[1.23,1.4,1.2],machines:[
      ['capacity',11,62,550,-29,380,true],['receipt',81,55,730,110,515,false]]},
    {label:'The complete flow',from:[1.04,0,1.2],to:[.93,0,-.5],machines:[
      ['capacity',10,64,540,-24,355,false],['sorter',45,80,440,42,290,true],['receipt',88,59,550,119,365,false]]}
  ];
  const controllers = new Set();
  let payloadPromise;
  function payload() {
    return payloadPromise ||= fetch('/assets/nav-anatomy.json').then(r => {
      if (!r.ok) throw new Error('CTA machine geometry unavailable');
      return r.json();
    }).then(data => {
      if (!data.css || !['capacity','sorter','scanner','receipt'].every(key => data.figures?.[key]?.svg)) throw new Error('Invalid CTA geometry');
      return data;
    }).catch(error => { payloadPromise=null;throw error; });
  }
  function svgFigure(model,index) {
    const parsed = new DOMParser().parseFromString(model.svg,'image/svg+xml');
    if (parsed.querySelector('parsererror')) throw new Error('Invalid machine SVG');
    const svg = document.importNode(parsed.documentElement,true);
    svg.removeAttribute('role');svg.removeAttribute('aria-label');svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false');
    // The current kit has no IDs; prefix any future definitions to keep repeated shots independent.
    const ids = new Map([...svg.querySelectorAll('[id]')].map(node => [node.id,'cta-cinema-'+index+'-'+node.id]));
    for (const node of [svg,...svg.querySelectorAll('*')]) {
      if (ids.has(node.id)) node.id=ids.get(node.id);
      for (const attr of [...node.attributes]) {
        let value=attr.value;
        for (const [oldId,newId] of ids) value=value.split('url(#'+oldId+')').join('url(#'+newId+')').replace('#'+oldId,'#'+newId);
        if (value!==attr.value) node.setAttribute(attr.name,value);
      }
    }
    return svg;
  }
  async function mount(panel) {
    if (!panel || panel.dataset.ctaCinemaMounting || panel.classList.contains('has-cta-cinema')) return;
    panel.dataset.ctaCinemaMounting='true';
    try {
      const data = await payload();
      if (!panel.isConnected) return;
      if (!document.querySelector('style[data-nav-anatomy]')) {
        const style=document.createElement('style');style.dataset.navAnatomy='';style.textContent=data.css;document.head.append(style);
      }
      const cinema=document.createElement('div');cinema.className='cta-cinema';cinema.setAttribute('aria-hidden','true');
      const rendered=shots.map((shot,shotIndex) => {
        const layer=document.createElement('div');layer.className='cta-cinema-shot';
        const camera=document.createElement('div');camera.className='cta-cinema-camera';layer.append(camera);cinema.append(layer);
        const actors=[];
        shot.machines.forEach(([key,x,y,w,mx,mw,secondary],machineIndex) => {
          const node=document.createElement('div');node.className='cta-cinema-machine';node.dataset.cinemaSecondary=String(secondary);
          node.style.cssText=`--machine-x:${x}%;--machine-y:${y}%;--machine-w:min(${w}px,64vw);--machine-mobile-x:${mx}%;--machine-mobile-w:${mw}px;--machine-opacity:${secondary ? .79 : 1}`;
          const svg=svgFigure(data.figures[key],shotIndex+'-'+machineIndex);node.append(svg);camera.append(node);
          for (const motion of data.figures[key].motions || []) {
            const ref=svg.querySelector('[data-an-motion="'+motion.name+'"]');
            if (ref) actors.push({...motion,node:ref,offset:machineIndex*.65+shotIndex*.35});
          }
        });
        return {layer,camera,actors};
      });
      cinema.insertAdjacentHTML('beforeend','<div class="cta-cinema-wash"></div><div class="cta-cinema-light"></div><div class="cta-cinema-caption"><span>OFFPEAK /</span><b></b></div><div class="cta-cinema-progress"><i></i><i></i><i></i><i></i></div>');
      const caption=cinema.querySelector('.cta-cinema-caption b'),progress=[...cinema.querySelectorAll('.cta-cinema-progress>i')];
      const pause=document.createElement('button');pause.className='cta-cinema-pause';pause.type='button';
      pause.setAttribute('aria-label','Pause background motion');pause.setAttribute('aria-pressed','false');
      panel.prepend(cinema);panel.append(pause);panel.classList.add('has-cta-cinema');
      panel.querySelectorAll('.closing-mark .approved-logo').forEach(mark=>{mark.dataset.logoPaused='true';});
      let frame=0,last=0,lastPaint=0,clock=0,visible=false,paused=false,dead=false,captionIndex=-1;
      let pointerX=0,pointerY=0,smoothX=0,smoothY=0;
      function controls() {
        pause.hidden=reduced.matches;
        pause.setAttribute('aria-label',paused?'Play background motion':'Pause background motion');
        pause.setAttribute('aria-pressed',String(paused));
        pause.innerHTML=paused?'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 8 5-8 5Z"/></svg>':'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h2.5v10H4zm5.5 0H12v10H9.5z"/></svg>';
        panel.dataset.ctaCinemaPaused=String(paused||reduced.matches);
      }
      function paint(t) {
        const still=reduced.matches;
        const current=still?3:Math.floor(t/duration)%shots.length;
        const local=still?duration*.55:t%duration;
        const cross=still?0:ease(clamp((local-duration+blend)/blend));
        const next=(current+1)%shots.length;
        const targetCaption=cross>.5?next:current;
        if (captionIndex!==targetCaption) { captionIndex=targetCaption;caption.textContent=shots[targetCaption].label;panel.dataset.ctaCinemaShot=String(targetCaption+1); }
        rendered.forEach((shot,index) => {
          const opacity=index===current?1-cross:index===next?cross:0;
          shot.layer.style.opacity=opacity.toFixed(3);
          if (!opacity) return;
          const journey=ease(clamp((index===current?local:0)/duration));
          const recipe=shots[index],camera=recipe.from.map((from,i)=>from+(recipe.to[i]-from)*journey);
          shot.camera.style.transform=`translate(${(camera[1]+smoothX*.45).toFixed(3)}%,${(camera[2]+smoothY*.4).toFixed(3)}%) scale(${camera[0].toFixed(4)})`;
          for (const actor of shot.actors) {
            if (actor.kind==='rotate') actor.node.setAttribute('transform',`rotate(${((still?1.2:t+actor.offset)*actor.speed).toFixed(3)})`);
            else {
              const ratio=still ? .5 : .5-.5*Math.cos((t+actor.offset)*Math.PI*2/actor.period);
              const value=actor.from+(actor.to-actor.from)*ratio;
              actor.node.setAttribute('transform',`translate(${(actor.vector[0]*value).toFixed(3)} ${(actor.vector[1]*value).toFixed(3)})`);
            }
          }
        });
        progress.forEach((node,index)=>node.style.setProperty('--progress',still?(index===3?'1':'0'):index<current?'1':index===current?String(local/duration):'0'));
      }
      function running() { return !dead&&visible&&!document.hidden&&!paused&&!reduced.matches; }
      function stop() { if(frame)cancelAnimationFrame(frame);frame=0;last=0; }
      function tick(now) {
        frame=0;if(!running())return;
        const dt=last?Math.min((now-last)/1000,.065):0;last=now;clock+=dt;
        smoothX+=(pointerX-smoothX)*(1-Math.exp(-dt/.65));smoothY+=(pointerY-smoothY)*(1-Math.exp(-dt/.65));
        if(now-lastPaint>=1000/30){paint(clock);lastPaint=now;}
        frame=requestAnimationFrame(tick);
      }
      function wake() { if(running()&&!frame){last=0;frame=requestAnimationFrame(tick);}else if(!running())stop(); }
      function onMotionChange(){controls();smoothX=smoothY=pointerX=pointerY=0;paint(clock);wake();}
      function onVisibility(){wake();}
      function onMove(event){if(!fine.matches||!running())return;const box=panel.getBoundingClientRect();pointerX=clamp((event.clientX-box.left)/box.width)*2-1;pointerY=clamp((event.clientY-box.top)/box.height)*2-1;cinema.style.setProperty('--cinema-light-x',`${(pointerX+1)*50}%`);cinema.style.setProperty('--cinema-light-y',`${(pointerY+1)*50}%`);}
      function onLeave(){pointerX=pointerY=0;}
      pause.addEventListener('click',()=>{paused=!paused;controls();wake();});
      panel.addEventListener('pointermove',onMove,{passive:true});panel.addEventListener('pointerleave',onLeave);
      document.addEventListener('visibilitychange',onVisibility);reduced.addEventListener('change',onMotionChange);
      const observer=new IntersectionObserver(entries=>{visible=entries.at(-1).isIntersecting;wake();},{threshold:.03});observer.observe(panel);
      const controller={
        pause(){paused=true;controls();wake();},play(){paused=false;controls();wake();},
        getState(){return{visible,paused,reducedMotion:reduced.matches,running:running(),shot:captionIndex+1,clock};},
        destroy(){dead=true;stop();observer.disconnect();reduced.removeEventListener('change',onMotionChange);document.removeEventListener('visibilitychange',onVisibility);panel.removeEventListener('pointermove',onMove);panel.removeEventListener('pointerleave',onLeave);cinema.remove();pause.remove();panel.classList.remove('has-cta-cinema');delete panel.dataset.ctaCinemaMounting;delete panel.dataset.ctaCinemaPaused;delete panel.dataset.ctaCinemaShot;controllers.delete(controller);}
      };
      controllers.add(controller);controls();paint(0);wake();
    } catch(error) {
      delete panel.dataset.ctaCinemaMounting;
      // The original CTA and its static background remain usable if local artwork fails.
      console.warn('OFFPEAK CTA cinema:',error.message);
    }
  }
  function start(){document.querySelectorAll(selector).forEach(mount);}
  window.OffpeakCTACinema={refresh:start,getState:()=>[...controllers].map(item=>item.getState()),pause:()=>controllers.forEach(item=>item.pause()),play:()=>controllers.forEach(item=>item.play())};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
