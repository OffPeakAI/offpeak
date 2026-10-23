/* Anatomy Figures: prebuilt real geometry, ref-only live motion, original navigation timing. */
(() => {
  'use strict';
  if(window.OffpeakNavIsometric)return;
  const still=matchMedia('(prefers-reduced-motion:reduce)'),desktop=matchMedia('(min-width:641px)');
  const states=new Set(),mounted=new WeakSet();
  let payload=null,loading=null,frame=0,last=0;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  function context(link){
    if(!link)return{key:'capacity',variant:0};
    const url=new URL(link.href,location.href),route=url.pathname.replace(/\/$/,''),work=url.searchParams.get('workflow');
    if(work==='classification')return{key:'sorter',variant:1};
    if(work==='extraction')return{key:'scanner',variant:1};
    const mapped={'/founders':['capacity',0],'/designers':['scanner',0],'/content-creators':['receipt',0],'/templates':['sorter',0],'/mcp':['sorter',2],'/blog':['receipt',1],'/docs':['scanner',2]};
    const sections={'#about':['capacity',0],'#features':['capacity',1],'#productivity':['scanner',1],'#templates':['sorter',0],'#research-case':['capacity',2],'#faq':['receipt',2],'#roadmap':['capacity',1]};
    const [key,variant]=sections[url.hash]||mapped[route]||['capacity',0];
    return{key,variant};
  }
  function isLive(s){return !!s.figure&&s.inView&&!s.panel.hidden&&desktop.matches&&!document.hidden;}
  function pose(s,dt){
    const calm=still.matches;
    if(!calm)s.clock+=dt;
    for(const motion of s.motion){
      if(motion.kind==='rotate'){
        // Rotation is inside the kit's topMatrix, in the fan's true horizontal plane.
        const angle=calm?18+s.variant*14:s.clock*motion.speed;
        motion.node.setAttribute('transform','rotate('+angle.toFixed(3)+')');
      }else{
        const fraction=calm?[.27,.5,.72][s.variant%3]:(s.interaction>performance.now()?s.pointer:.5-.5*Math.cos(s.clock*Math.PI*2/motion.period+s.variant*.7));
        const target=motion.from+(motion.to-motion.from)*fraction;
        motion.value=calm?target:motion.value+(target-motion.value)*(1-Math.exp(-dt/.24));
        motion.node.setAttribute('transform','translate('+(motion.vector[0]*motion.value).toFixed(3)+' '+(motion.vector[1]*motion.value).toFixed(3)+')');
      }
    }
  }
  function tick(now){
    frame=0;const dt=last?Math.min((now-last)/1000,1/30):1/60;last=now;let running=false;
    for(const s of states){if(!isLive(s))continue;pose(s,dt);running=true;}
    if(running&&!still.matches)frame=requestAnimationFrame(tick);
  }
  function wake(){if(!frame&&!document.hidden&&desktop.matches){last=0;frame=requestAnimationFrame(tick);}}
  function load(){
    if(!loading)loading=fetch('/assets/nav-anatomy.json').then(r=>{if(!r.ok)throw new Error('Anatomy figure data unavailable');return r.json();}).then(data=>{
      if(!data.figures||!data.css)throw new Error('Invalid Anatomy figure data');
      payload=data;
      if(!document.querySelector('style[data-nav-anatomy]')){const css=document.createElement('style');css.dataset.navAnatomy='';css.textContent=data.css;document.head.append(css);}
      for(const s of states)sync(s);return data;
    }).catch(()=>{loading=null;return null;});
    return loading;
  }
  function sync(s){
    const selected=s.panel.querySelector('a.is-picked')||s.panel.querySelector('a');
    const choice=context(selected),label=(selected?.querySelector('b')?.textContent||selected?.textContent||'').trim();
    s.caption.textContent=label;
    if(!payload)return;
    const model=payload.figures[choice.key];if(!model)return;
    if(s.key===choice.key){s.variant=choice.variant;pose(s,still.matches?0:1/60);wake();return;}
    const previous=s.figure,figure=document.createElement('div');figure.className='nav-anatomy-figure';figure.innerHTML=model.svg;
    figure.dataset.machine=choice.key;s.stage.append(figure);s.figure=figure;s.key=choice.key;s.variant=choice.variant;s.clock=.5;
    s.motion=model.motions.map(m=>({...m,node:figure.querySelector('[data-an-motion="'+m.name+'"]'),value:(m.from+m.to)/2||0})).filter(m=>m.node);
    s.preview.classList.add('has-anatomy-figure');
    pose(s,0);
    if(previous){previous.classList.add('is-leaving');setTimeout(()=>previous.remove(),still.matches?0:240);}
    if(!still.matches)figure.animate([{opacity:0,translate:'0 3px'},{opacity:1,translate:'0 0'}],{duration:300,easing:'cubic-bezier(.22,1,.36,1)'});
    wake();
  }
  function mount(preview){
    if(mounted.has(preview))return;
    const image=preview.querySelector('img'),panel=preview.closest('.nav-dropdown');if(!image||!panel)return;
    mounted.add(preview);preview.classList.add('nav-isometric-preview');
    const stage=document.createElement('div');stage.className='nav-anatomy-stage';
    const caption=document.createElement('span');caption.className='nav-iso-caption';preview.append(stage,caption);
    const s={preview,panel,image,stage,caption,figure:null,key:'',variant:0,motion:[],clock:0,inView:false,pointer:.5,interaction:0};states.add(s);
    // faithful.js keeps its image ref and original 140ms selection delay.
    new MutationObserver(()=>sync(s)).observe(image,{attributes:true,attributeFilter:['src']});
    new MutationObserver(()=>{if(!panel.hidden){load();sync(s);}wake();}).observe(panel,{attributes:true,attributeFilter:['hidden']});
    new IntersectionObserver(entries=>{s.inView=entries[entries.length-1].isIntersecting;wake();},{threshold:0}).observe(preview);
    panel.addEventListener('pointermove',event=>{
      if(still.matches||event.pointerType==='touch')return;
      const rect=panel.getBoundingClientRect();s.pointer=clamp((event.clientX-rect.left)/rect.width,0,1);s.interaction=performance.now()+1200;wake();
    },{passive:true});
    panel.addEventListener('pointerleave',()=>{s.interaction=0;wake();},{passive:true});
    sync(s);
  }
  function scan(){document.querySelectorAll('.faithful-menu-preview').forEach(mount);}
  function start(){
    scan();
    new MutationObserver(records=>{if(records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&(node.matches('.faithful-menu-preview')||node.querySelector('.faithful-menu-preview')))))scan();}).observe(document.body,{childList:true,subtree:true});
    if(desktop.matches)load();
    document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else wake();});
    still.addEventListener('change',()=>{for(const s of states)if(s.figure)pose(s,0);wake();});
    desktop.addEventListener('change',()=>{if(desktop.matches)load();wake();});
  }
  window.OffpeakNavIsometric={refresh:scan};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
