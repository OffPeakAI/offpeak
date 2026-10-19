(() => {
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const header=document.querySelector('.faithful-header');
const menu=document.querySelector('.mobile-menu'),nav=document.querySelector('#main-menu');
const desktopMedia=matchMedia('(min-width:641px)');
const desktopNav=()=>desktopMedia.matches;
let navTimer=0;
let restoringNavFocus=false;
const navGroups=[...document.querySelectorAll('.nav-group')].map(group=>({
 group,
 trigger:group.querySelector('.nav-trigger'),
 disclosure:group.querySelector('.nav-disclosure'),
 panel:group.querySelector('.nav-dropdown')
})).filter(item=>item.trigger&&item.panel);

function setExpanded(item,expanded){
 item.trigger.setAttribute('aria-expanded',String(expanded));
 item.disclosure?.setAttribute('aria-expanded',String(expanded));
 if(item.disclosure)item.disclosure.setAttribute('aria-label',(expanded?'Hide ':'Show ')+item.disclosure.dataset.navLabel+' links');
 item.panel.hidden=!expanded;
 if(!expanded){item.panel._navOpening?.cancel();item.panel._navOpening=null;}
}
function closeMenus({restoreFocus=false}={}){
 clearTimeout(navTimer);navTimer=0;
 const focused=document.activeElement;
 const expanded=navGroups.filter(item=>!item.panel.hidden);
 const current=expanded.find(item=>item.group.contains(focused))||expanded[0];
 navGroups.forEach(item=>setExpanded(item,false));
 if(restoreFocus){
  restoringNavFocus=true;
  (desktopNav()?current?.trigger:current?.disclosure)?.focus({preventScroll:true});
  restoringNavFocus=false;
 }
}
function closeNavigation(){
 closeMenus();
 nav?.classList.remove('is-open');
 menu?.setAttribute('aria-expanded','false');
 menu?.setAttribute('aria-label','Open navigation');
 if(header)header.dataset.menuOpen='false';
}
function openMenu(item){
 clearTimeout(navTimer);navTimer=0;
 if(!item.panel.hidden)return;
 closeMenus();setExpanded(item,true);
 if(!reduced){
  const x=desktopNav()?'-50%':'0';
  item.panel._navOpening=item.panel.animate(
   [{opacity:0,translate:x+' 6px'},{opacity:1,translate:x+' 0'}],
   {duration:300,easing:'cubic-bezier(.33,1,.68,1)'}
  );
 }
}
navGroups.forEach(item=>{
 const {group,trigger,disclosure,panel}=item;
 // Label links always navigate; the separate disclosure expands the mobile list.
 disclosure?.addEventListener('click',()=>{if(panel.hidden)openMenu(item);else closeMenus()});
 group.addEventListener('pointerenter',event=>{
  if(event.pointerType==='touch'||!desktopNav())return;
  clearTimeout(navTimer);
  navTimer=setTimeout(()=>openMenu(item),navGroups.some(other=>!other.panel.hidden)?0:100);
 });
 group.addEventListener('pointerleave',event=>{
  if(event.pointerType==='touch'||!desktopNav())return;
  clearTimeout(navTimer);navTimer=setTimeout(closeMenus,250);
 });
 group.addEventListener('focusout',event=>{
  if(!desktopNav()||group.contains(event.relatedTarget))return;
  setExpanded(item,false);
 });
 trigger.addEventListener('focus',()=>{
  if(!restoringNavFocus&&desktopNav()&&trigger.matches(':focus-visible'))openMenu(item);
 });
 trigger.addEventListener('keydown',event=>{
  if(event.key==='ArrowDown'||event.key==='Tab'&&!event.shiftKey&&desktopNav()&&!panel.hidden){
   event.preventDefault();openMenu(item);panel.querySelector('a')?.focus({preventScroll:true});
  }
 });
 disclosure?.addEventListener('keydown',event=>{
  if(event.key==='ArrowDown'){event.preventDefault();openMenu(item);panel.querySelector('a')?.focus({preventScroll:true});}
 });
 if(panel.querySelectorAll('a').length>2){
  const preview=document.createElement('div');
  preview.className='faithful-menu-preview';preview.setAttribute('aria-hidden','true');
  const image=document.createElement('img');image.alt='';preview.append(image);
  panel.append(preview);panel.classList.add('has-preview');
  const available=[...document.querySelectorAll('.gallery-marquee__set img')].map(element=>element.getAttribute('src'));
  [...panel.querySelectorAll('a')].forEach((link,index)=>{
   const pick=()=>{
    image.src=available[index%available.length]||'/assets/reveal/offpeak-reveal-quote.svg';
    panel.querySelectorAll('a').forEach(other=>other.classList.toggle('is-picked',other===link));
   };
   if(index===0)pick();
   link.addEventListener('pointerenter',()=>{clearTimeout(preview._timer);preview._timer=setTimeout(pick,140)});
   link.addEventListener('focus',pick);
  });
 }
});
document.querySelectorAll('.faithful-links>.nav-link').forEach(link=>link.addEventListener('pointerenter',()=>{if(desktopNav())closeMenus()}));
menu?.addEventListener('click',()=>{
 const open=menu.getAttribute('aria-expanded')!=='true';
 menu.setAttribute('aria-expanded',String(open));
 menu.setAttribute('aria-label',open?'Close navigation':'Open navigation');
 if(header)header.dataset.menuOpen=String(open);
 nav?.classList.toggle('is-open',open);
 if(!open)closeMenus();
});
// Registered before the reference anchor glide: close the overlay first.
document.addEventListener('click',event=>{
 const target=event.target instanceof Element?event.target:null;
 if(!target)return;
 const link=target.closest('a[href]');
 const ordinary=event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey;
 if(link&&header?.contains(link)&&ordinary&&!event.defaultPrevented){closeNavigation();return;}
 if(!target.closest('.nav-group'))closeMenus();
 if(!desktopNav()&&menu?.getAttribute('aria-expanded')==='true'&&!nav?.contains(target)&&!menu.contains(target))closeNavigation();
});
document.addEventListener('keydown',event=>{
 if(event.key!=='Escape')return;
 const mobileOpen=menu?.getAttribute('aria-expanded')==='true';
 const dropdownOpen=navGroups.some(item=>!item.panel.hidden);
 if(!mobileOpen&&!dropdownOpen){clearTimeout(navTimer);return;}
 event.preventDefault();
 if(mobileOpen){closeNavigation();menu?.focus({preventScroll:true});}
 else closeMenus({restoreFocus:true});
});
desktopMedia.addEventListener('change',()=>{
 const focused=document.activeElement;
 const moveFocus=focused===menu||nav?.contains(focused);
 const trigger=focused?.closest('.nav-group')?.querySelector('.nav-trigger');
 closeNavigation();
 if(moveFocus)(desktopNav()?(trigger||nav?.querySelector('.nav-link')):menu)?.focus({preventScroll:true});
});
window.OffpeakNavigation={close:closeNavigation};
// Render each distinct native scene in the same design-space dimensions as the reference.
const scaleObserver=new ResizeObserver(entries=>entries.forEach(({target})=>{const child=target.querySelector('.offpeak-scene');if(child)child.style.transform=`scale(${target.clientWidth/(Number(child.dataset.sceneWidth)||640)})`}));
document.querySelectorAll('[data-scene]').forEach(frame=>{const template=document.getElementById(frame.dataset.scene);if(template){frame.append(template.content.cloneNode(true));scaleObserver.observe(frame);window.OffpeakScenes?.mount(frame)}});
document.querySelectorAll('[data-faq]').forEach(b=>{const answer=document.getElementById(b.getAttribute('aria-controls'));answer.className='faithful-faq-answer';answer.inert=true;b.querySelector('svg')?.classList.add('faq-plus');b.addEventListener('click',()=>{const open=b.getAttribute('aria-expanded')!=='true';document.querySelectorAll('[data-faq]').forEach(other=>{const region=document.getElementById(other.getAttribute('aria-controls'));const selected=other===b&&open;other.setAttribute('aria-expanded',String(selected));region.classList.toggle('is-open',selected);region.inert=!selected})})});
addEventListener('scroll',()=>header?.classList.toggle('is-scrolled',scrollY>32),{passive:true});
header?.classList.toggle('is-scrolled',scrollY>32);
})();
