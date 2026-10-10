const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const menu=document.querySelector('.menu-toggle'),nav=document.querySelector('#main-menu');
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close navigation':'Open navigation');nav.classList.toggle('is-open',open)});
nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('is-open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Open navigation')}));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){const wasOpen=nav.classList.contains('is-open');nav.classList.remove('is-open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Open navigation');if(wasOpen)menu.focus();document.querySelectorAll('.off-card.is-pinned').forEach(c=>{c.classList.remove('is-pinned');c.querySelector('.iso-toggle').setAttribute('aria-pressed','false')})}});
document.querySelectorAll('[data-tilt]').forEach(card=>{
 const toggle=card.querySelector('.iso-toggle');
 toggle.addEventListener('click',()=>{const pin=toggle.getAttribute('aria-pressed')!=='true';toggle.setAttribute('aria-pressed',String(pin));card.classList.toggle('is-pinned',pin);card.style.transform=''});
 card.addEventListener('pointermove',e=>{if(reduce||e.pointerType==='touch'||card.classList.contains('is-pinned'))return;const r=card.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;card.style.setProperty('--mx',`${x*100}%`);card.style.setProperty('--my',`${y*100}%`);card.style.transform=`perspective(1100px) rotateX(${(0.5-y)*8}deg) rotateY(${(x-.5)*10}deg) scale(.984)`});
 card.addEventListener('pointerleave',()=>card.style.transform='');
});
// Reveal preserves layout and remains fully readable without JavaScript.
if(!reduce){const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.remove('off-hidden');io.unobserve(e.target)}}),{threshold:.08});document.querySelectorAll('[data-reveal]').forEach(e=>{e.classList.add('off-hidden');io.observe(e)})}
const about=document.querySelector('#about'),words=[...document.querySelectorAll('.about-word')],orbits=[...document.querySelectorAll('[data-orbit]')];
let scheduled=false;
function choreograph(){scheduled=false;const r=about.getBoundingClientRect(),travel=r.height-innerHeight,p=Math.max(0,Math.min(1,-r.top/travel)),vw=innerWidth;words.forEach((w,i)=>w.style.opacity=reduce?1:(p*1.9>i/words.length?1:.14));const positions=[[-.35,-.23],[.35,-.2],[-.4,.17],[.39,.2],[-.12,.35],[.13,-.37]];orbits.forEach((e,i)=>{const reveal=Math.max(0,Math.min(1,(p-.24)*4)),exit=Math.max(0,Math.min(1,(p-.83)*6));const x=positions[i][0]*Math.min(vw,1250),y=positions[i][1]*Math.min(innerHeight,1000);e.style.opacity=String(reduce?.2:reveal*(1-exit)*.85);e.style.transform=`translate(calc(-50% + ${x*(1.5-reveal*.5)}px),calc(-50% + ${y}px)) rotate(${[-9,10,-8,11,-4,5][i]}deg)`});document.querySelector('._statement_150lx_105').style.opacity=String(1-Math.max(0,(p-.7)*3));}
addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(choreograph)}},{passive:true});addEventListener('resize',choreograph);choreograph();
const rail=document.querySelector('#feature-rail'),slides=[...rail.querySelectorAll('figure')],dots=[...document.querySelectorAll('[data-slide]')];let active=0,paused=reduce;
function slide(i){active=i;const edge=parseFloat(getComputedStyle(rail).getPropertyValue('--rail-edge'))||24;rail.scrollTo({left:slides[i].offsetLeft-slides[0].offsetLeft,behavior:reduce?'instant':'smooth'});dots.forEach((b,j)=>{b.setAttribute('aria-current',String(i===j));b.firstElementChild.style.width=i===j?'24px':'8px'})}
dots.forEach((b,i)=>b.addEventListener('click',()=>{paused=true;updatePause();slide(i)}));
const pause=document.querySelector('[data-pause]');function updatePause(){pause.setAttribute('aria-label',paused?'Play capability carousel':'Pause capability carousel');pause.innerHTML=paused?'<span aria-hidden="true">▶</span>':'<span aria-hidden="true">Ⅱ</span>'}
pause.addEventListener('click',()=>{paused=!paused;updatePause()});updatePause();
setInterval(()=>{if(paused||document.hidden)return;const r=rail.getBoundingClientRect();if(r.top<innerHeight&&r.bottom>0&&!rail.matches(':hover')&&!rail.matches(':focus-within'))slide((active+1)%slides.length)},6500);
rail.addEventListener('pointerdown',()=>{paused=true;updatePause()},{passive:true});
// Background artwork follows reduced-motion and viewport visibility preferences.
const videoObserver=new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{if(reduce||!isIntersecting)target.pause();else target.play().catch(()=>{})}),{rootMargin:'100px'});
document.querySelectorAll('video').forEach(v=>{if(reduce)v.pause();videoObserver.observe(v)});
// Direct dragging complements the carousel controls on mouse and touch.
for(const el of [rail,document.querySelector('.gallery-marquee')]){
 let drag=null;
 el.addEventListener('pointerdown',e=>{if(e.target.closest('button')||e.button!==0)return;drag={x:e.clientX,y:e.clientY,left:el.scrollLeft,id:e.pointerId,moved:false};});
 el.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.abs(dx)>8&&Math.abs(dx)>Math.abs(dy)){drag.moved=true;el.setPointerCapture(e.pointerId);el.dataset.dragging='true'}if(drag.moved){e.preventDefault();el.scrollLeft=drag.left-dx}});
 el.addEventListener('click',e=>{if(drag?.moved){e.preventDefault();e.stopPropagation();drag=null}},true);
 const end=()=>{delete el.dataset.dragging;if(drag&&!drag.moved)drag=null};el.addEventListener('pointerup',end);el.addEventListener('pointercancel',()=>{drag=null;delete el.dataset.dragging});
}
