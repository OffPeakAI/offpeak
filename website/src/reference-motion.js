/* The reference's timings, momentum and scroll choreography applied to the adapted DOM. */
(() => {
'use strict';
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const {objects:poses,pose,clamp,lerp,smooth}=window.OffpeakReferenceMotion;
const glide='cubic-bezier(.33,1,.68,1)';

// Reference text choreography; the approved logo remains at its resting size.
if(!reduced && scrollY<10){
 const hero=document.querySelector('#hero');
 for(const [selector,delay] of [['title',1304],['wallpaper',1304],['subhead',1784],['walkthrough',1784],['cta',2264]]){
  const el=hero?.querySelector(`[data-intro="${selector}"]`);if(!el)continue;
  el.animate([{opacity:0,transform:selector==='cta'?'none':'translateY(24px)'},{opacity:1,transform:'none'}],{delay,duration:800,easing:glide,fill:'backwards'});
 }
}
// Sections retain the reference's grouping: 480ms between groups, 104ms within.
if(!reduced){document.querySelectorAll('main > section').forEach(section=>{
 const elements=[...section.querySelectorAll('[data-reveal]')];if(!elements.length)return;
 const groups=[...new Set(elements.map(e=>Number(e.dataset.reveal)||0))].sort();
 elements.forEach(e=>e.classList.add('await-reveal'));
 const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;observer.disconnect();
  groups.forEach((g,i)=>elements.filter(e=>(Number(e.dataset.reveal)||0)===g).forEach((e,j)=>{
   e.classList.remove('await-reveal');e.animate([{opacity:0,translate:'0 24px'},{opacity:1,translate:'0 0'}],{delay:i*480+j*104,duration:800,easing:glide,fill:'backwards'});
  }));
 },{rootMargin:'0px 0px -15% 0px',threshold:0});observer.observe(elements[0]);
})}

const about=document.querySelector('#about');
if(about && !about.dataset.techConversation){
 const stage=about.querySelector('._scene_150lx_23'),items=[...about.querySelectorAll('[data-reveal-object]')],words=[...about.querySelectorAll('.reveal-word')],logo=about.querySelector('.reveal-center-logo'),statement=about.querySelector('._statement_150lx_105');
 const cursor={x:0,y:0,strength:0},target={x:0,y:0,strength:0};let raf=0;
 const logoPose={start:{x:0,y:-21,rotate:0,scale:.2},end:{x:0,y:0,rotate:0,scale:1},mobileEnd:{x:0,y:0,rotate:0,scale:1},phase:1.35,drift:.68,swirl:2.2,turns:.62,pull:12,enterStart:.04,enterEnd:.62,fadeIn:false,rotationDrift:0};
 items.forEach((el,i)=>{const p=poses[i];el.style.setProperty('--media-width',p.width);el.style.setProperty('--media-mobile-width',p.mobileWidth);el.style.setProperty('--media-z-index',p.zIndex)});
 function render(t){
  const r=about.getBoundingClientRect(),scrollProgress=clamp(-r.top/Math.max(1,r.height-innerHeight)),progress=clamp((scrollProgress-.085)/(.9-.085));
  for(const key of ['x','y','strength'])cursor[key]+=(target[key]-cursor[key])*.08;
  const state={progress,scrollProgress,time:reduced?0:t/1000,viewportWidth:innerWidth,viewportHeight:innerHeight,pointerX:cursor.x,pointerY:cursor.y,pointerStrength:reduced?0:cursor.strength};
  const copyOut=smooth(.13,.4,progress),wordProgress=clamp(scrollProgress/.12);
  statement.style.opacity=String(1-copyOut);statement.style.transform=`translateY(${-24*copyOut}px)`;
  words.forEach((w,i)=>w.style.opacity=String(reduced?1:lerp(.14,1,clamp((wordProgress*(words.length+3)-i)/3))));
  items.forEach((el,i)=>Object.assign(el.style,pose(poses[i],state)));
  Object.assign(logo.style,pose(logoPose,state));
  if(!reduced)raf=requestAnimationFrame(render);
 }
 about.addEventListener('pointermove',e=>{const r=stage.getBoundingClientRect();target.x=e.clientX-r.left-r.width/2;target.y=e.clientY-r.top-r.height/2;target.strength=1});
 about.addEventListener('pointerleave',()=>target.strength=0);
 new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){if(!raf)render(performance.now())}else{cancelAnimationFrame(raf);raf=0}},{rootMargin:'100px'}).observe(about);
 if(reduced){addEventListener('scroll',()=>render(0),{passive:true});render(0)}
}

// Exact reference rail mechanics: .32s velocity decay, .4 smoothing, 5px drag threshold.
const rail=document.querySelector('#feature-rail');
if(rail){
 const slides=[...rail.querySelectorAll('figure')],dots=[...document.querySelectorAll('[data-slide]')],pauses=[...document.querySelectorAll('[data-carousel-pause]')];
 let index=0,playing=!reduced,inView=false,elapsed=0,last=0,inertia=0,drag=null,targetIndex=null,raf=0,hover=false;
 const offset=i=>slides[i].offsetLeft-slides[0].offsetLeft;
 const nearest=()=>slides.reduce((best,el,i)=>Math.abs(offset(i)-rail.scrollLeft)<Math.abs(offset(best)-rail.scrollLeft)?i:best,0);
 const canPlay=()=>playing&&inView&&!document.hidden&&!hover&&!rail.matches(':focus-within')&&!document.querySelector('.material-stage.is-open')&&!drag&&!inertia;
 function paintProgress(){const progress=dots[index]?.querySelector('.carousel-progress');progress?.style.setProperty('transform',`scaleX(${playing?clamp(elapsed/6000):1})`);}
 function syncPlayback(){
  if(canPlay()){if(!raf){last=performance.now();raf=requestAnimationFrame(frame);}}
  else if(raf){cancelAnimationFrame(raf);raf=0;}
 }
 function controls(){
  dots.forEach(b=>{const yes=Number(b.dataset.slide)===index;b.setAttribute('aria-current',String(yes));const pill=b.firstElementChild;pill.style.width=yes?'24px':'8px';pill.innerHTML=yes?'<i class="carousel-progress"></i>':'';});
  pauses.forEach(b=>{b.setAttribute('aria-label',playing?'Pause capability carousel':'Play capability carousel');b.innerHTML=playing?'Ⅱ':'▶';});
  paintProgress();syncPlayback();
 }
 function show(i){index=i;targetIndex=i;elapsed=0;controls();rail.scrollTo({left:offset(i),behavior:reduced?'instant':'smooth'});}
 dots.forEach(b=>b.addEventListener('click',()=>show(Number(b.dataset.slide))));
 pauses.forEach(b=>b.addEventListener('click',()=>{elapsed=0;playing=!playing;controls();}));
 rail.addEventListener('scroll',()=>{if(targetIndex!==null&&Math.abs(rail.scrollLeft-offset(targetIndex))>1)return;targetIndex=null;const n=nearest();if(n!==index){index=n;elapsed=0;controls();}},{passive:true});
 function snap(){rail.scrollTo({left:offset(nearest()),behavior:reduced?'instant':'smooth'});delete rail.dataset.dragging;syncPlayback();}
 function stopInertia(){if(inertia)cancelAnimationFrame(inertia);inertia=0;drag=null;delete rail.dataset.dragging;}
 rail.addEventListener('pointerdown',e=>{
  targetIndex=null;if(e.pointerType!=='mouse'||e.button!==0)return;
  stopInertia();drag={id:e.pointerId,x:e.clientX,lastX:e.clientX,left:rail.scrollLeft,time:e.timeStamp,v:0,moved:false};rail.dataset.dragging='';syncPlayback();
 });
 addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const d=e.clientX-drag.x,dt=Math.max((e.timeStamp-drag.time)/1000,1/240);drag.moved||=Math.abs(d)>5;rail.scrollLeft=drag.left-d;drag.v=drag.v*.6-(e.clientX-drag.lastX)/dt*.4;drag.lastX=e.clientX;drag.time=e.timeStamp;});
 function release(e){
  if(!drag||drag.id!==e.pointerId)return;
  let v=e.timeStamp-drag.time>90?0:drag.v;const moved=drag.moved;drag=null;
  if(!moved||reduced||e.type==='pointercancel'||!inView||document.hidden){snap();return;}
  let t=performance.now();
  function coast(now){
   inertia=0;if(!inView||document.hidden){delete rail.dataset.dragging;return;}
   const dt=Math.min((now-t)/1000,.05);t=now;const old=rail.scrollLeft;rail.scrollLeft+=v*dt;v*=Math.exp(-dt/.32);
   if(Math.abs(v)<20||old===rail.scrollLeft){snap();return;}
   inertia=requestAnimationFrame(coast);
  }
  inertia=requestAnimationFrame(coast);
 }
 addEventListener('pointerup',release);addEventListener('pointercancel',release);rail.addEventListener('dragstart',e=>e.preventDefault());
 rail.addEventListener('wheel',()=>targetIndex=null,{passive:true});
 rail.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hover=true;syncPlayback();}});
 rail.addEventListener('pointerleave',()=>{hover=false;syncPlayback();});
 document.addEventListener('focusin',syncPlayback);
 document.addEventListener('focusout',()=>queueMicrotask(syncPlayback));
 document.addEventListener('click',()=>queueMicrotask(syncPlayback));
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopInertia();syncPlayback();});
 new IntersectionObserver(entries=>{inView=entries.some(e=>e.intersectionRatio>=.5);if(!inView)stopInertia();syncPlayback();},{threshold:[0,.5]}).observe(rail);
 function frame(t){
  raf=0;if(!canPlay())return;
  const dt=Math.min(Math.max(t-last,0),100);last=t;elapsed+=dt;
  if(elapsed>=6000)show((index+1)%slides.length);
  paintProgress();if(canPlay()&&!raf)raf=requestAnimationFrame(frame);
 }
 controls();
}
// Original marquee: 8 seconds per card; hover/drag release follows a .45s ease.
const gallery=document.querySelector('.gallery-marquee'),track=gallery?.querySelector('.gallery-marquee__track');
const workflowOwnsGallery=document.querySelector('script[src="/assets/workflow-world.js"]')||gallery?.closest('[data-workflow-world]');
if(track&&!workflowOwnsGallery){
 let width=0,position=0,velocity=0,drag=null,hover=false,focus=false,last=0,active=false,moved=false,raf=0;
 const count=track.querySelector('.gallery-marquee__set').children.length;
 const pace=()=>reduced||hover||focus?0:width/(count*8);
 const canRun=()=>active&&!document.hidden&&!gallery.hidden&&gallery.style.display!=='none'&&!drag&&(pace()>0||Math.abs(velocity)>.1);
 function paint(){if(!width)return;if(!focus||drag)position=(position%width+width)%width;track.style.transform=`translate3d(${-width-position}px,0,0)`;}
 function wake(){if(canRun()){if(!raf){last=performance.now();raf=requestAnimationFrame(tick);}}else if(raf){cancelAnimationFrame(raf);raf=0;}}
 new ResizeObserver(()=>{const next=track.offsetWidth/3;position=width?position*next/width:0;width=next;paint();wake();}).observe(track);track.style.animation='none';
 new IntersectionObserver(entries=>{active=entries.some(e=>e.isIntersecting);wake();}).observe(gallery);
 new MutationObserver(wake).observe(gallery,{attributes:true,attributeFilter:['hidden','style']});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)drag=null;wake();});
 gallery.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hover=true;wake();}});
 gallery.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'){hover=false;wake();}});
 gallery.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;drag={id:e.pointerId,x:e.clientX,lastX:e.clientX,position,time:e.timeStamp,v:0};moved=false;velocity=0;wake();});
 addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const d=e.clientX-drag.x,dt=Math.max((e.timeStamp-drag.time)/1000,1/240);moved||=Math.abs(d)>5;position=drag.position-d;paint();drag.position=position+d;drag.v=drag.v*.6-(e.clientX-drag.lastX)/dt*.4;drag.lastX=e.clientX;drag.time=e.timeStamp;});
 function end(e){if(!drag||drag.id!==e.pointerId)return;velocity=reduced||e.type==='pointercancel'||e.timeStamp-drag.time>90?0:drag.v;drag=null;wake();}
 addEventListener('pointerup',end);addEventListener('pointercancel',end);
 gallery.addEventListener('click',e=>{if(moved){e.preventDefault();e.stopPropagation();moved=false;}},true);gallery.addEventListener('dragstart',e=>e.preventDefault());
 gallery.addEventListener('wheel',e=>{if(Math.abs(e.deltaX)<=Math.abs(e.deltaY))return;e.preventDefault();position+=e.deltaX*(e.deltaMode===1?16:1);velocity=0;paint();wake();},{passive:false});
 gallery.addEventListener('focusin',e=>{if(!e.target.matches(':focus-visible'))return;focus=true;velocity=0;const r=gallery.getBoundingClientRect(),b=e.target.getBoundingClientRect(),x=b.left-r.left;position+=x-Math.min(Math.max(x,24),Math.max(24,r.width-b.width-24));paint();wake();});
 gallery.addEventListener('focusout',e=>{if(!gallery.contains(e.relatedTarget)){focus=false;wake();}});
 function tick(t){
  raf=0;if(!canRun())return;
  const dt=Math.min((t-last)/1000,.05);last=t;
  const target=pace();velocity+=(target-velocity)*(1-Math.exp(-dt/.45));
  if(!target&&Math.abs(velocity)<=.1)velocity=0;
  position+=velocity*dt;paint();if(canRun())raf=requestAnimationFrame(tick);
 }
}
// One validated same-page anchor handler, after faithful.js has closed its menus.
let anchorFrame=0;
let anchorNavigation=0;
function hashTarget(hash){
 if(!hash||hash==='#')return null;
 try{return document.getElementById(decodeURIComponent(hash.slice(1)))}catch{return null}
}
function anchorTop(target){
 const header=document.querySelector('.faithful-header');
 const headerGap=(header?.getBoundingClientRect().height||0)+12;
 const margin=parseFloat(getComputedStyle(target).scrollMarginTop)||0;
 const padding=parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)||0;
 // A numeric Lenis destination avoids applying CSS margin/padding a second time.
 const clearance=Math.max(headerGap,margin+padding);
 return Math.max(0,target.getBoundingClientRect().top+scrollY-clearance);
}
function focusAnchor(target){
 const temporary=!target.hasAttribute('tabindex');
 if(temporary)target.setAttribute('tabindex','-1');
 target.focus({preventScroll:true});
 if(temporary)target.addEventListener('blur',()=>target.removeAttribute('tabindex'),{once:true});
}
function glideAnchor(target,{immediate=false,keyboard=false}={}){
 const navigation=++anchorNavigation;
 const quiet=matchMedia('(prefers-reduced-motion:reduce)').matches;
 const complete=()=>{if(keyboard&&navigation===anchorNavigation)focusAnchor(target)};
 const top=anchorTop(target);
 if(window.OffpeakScroll){
  window.OffpeakScroll.scrollTo(top,{duration:.8,immediate:immediate||quiet,force:true,onComplete:complete});
 }else{
  window.scrollTo({top,behavior:immediate||quiet?'instant':'smooth'});
  // preventScroll preserves the requested native glide while moving keyboard focus.
  complete();
 }
}
document.addEventListener('click',event=>{
 if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const element=event.target instanceof Element?event.target:null;
 const link=element?.closest('a[href]');
 if(!link||link.hasAttribute('download')||link.target&&link.target!=='_self')return;
 let url;
 try{url=new URL(link.href,location.href)}catch{return}
 if(url.origin!==location.origin||url.pathname!==location.pathname||url.search!==location.search)return;
 const target=hashTarget(url.hash);
 if(!target)return;
 event.preventDefault();
 if(url.hash!==location.hash)history.pushState(null,'',url.pathname+url.search+url.hash);
 glideAnchor(target,{keyboard:event.detail===0});
});
function scheduleHashJump(){
 cancelAnimationFrame(anchorFrame);
 anchorFrame=requestAnimationFrame(()=>{
  anchorFrame=0;
  const target=hashTarget(location.hash);
  if(target){window.OffpeakNavigation?.close();glideAnchor(target,{immediate:true});}
  else window.OffpeakScroll?.reset();
 });
}
if(location.hash){
 if(document.readyState==='complete')scheduleHashJump();
 else addEventListener('load',scheduleHashJump,{once:true});
}
addEventListener('hashchange',scheduleHashJump);
addEventListener('popstate',scheduleHashJump);
})();
