/* Stable, front-facing card casings. Isometric geometry belongs to the artwork inside. */
(() => {
  'use strict';
  if(window.OffpeakIsometric)return;
  const selector='.material-card,.material-panel';
  const excluded='.console-page,.workflow-world,.material-stage,.isometric-depth';
  const cards=new WeakSet();
  const fine=matchMedia('(hover:hover) and (pointer:fine)');
  let scanFrame=0;
  const cameraProperties=['--iso-axis-x','--iso-axis-y','--iso-axis-z','--iso-angle','--iso-scale','--iso-depth','--iso-shadow'];
  function resetLight(card){
    card.style.removeProperty('--panel-light-x');
    card.style.removeProperty('--panel-light-y');
    delete card.dataset.isoHover;
  }
  function mount(card){
    if(cards.has(card)||card.closest(excluded)||card.parentElement?.closest(selector))return;
    cards.add(card);
    card.classList.add('isometric-card');
    // Clear legacy camera values without altering the reference's transform/translate animations.
    cameraProperties.forEach(name=>card.style.removeProperty(name));
    const depth=card.previousElementSibling;
    if(depth?.classList.contains('isometric-depth'))depth.remove();
    card.addEventListener('pointerenter',event=>{
      if(fine.matches&&event.pointerType!=='touch')card.dataset.isoHover='true';
    },{passive:true});
    card.addEventListener('pointermove',event=>{
      if(!fine.matches||event.pointerType==='touch'||card.dataset.materialActive==='true')return;
      const rect=card.getBoundingClientRect();
      if(!rect.width||!rect.height)return;
      const x=Math.max(0,Math.min(100,(event.clientX-rect.left)/rect.width*100));
      const y=Math.max(0,Math.min(100,(event.clientY-rect.top)/rect.height*100));
      // Only the local brushed-metal highlight follows the pointer. The plane never rotates.
      card.style.setProperty('--panel-light-x',x.toFixed(2)+'%');
      card.style.setProperty('--panel-light-y',y.toFixed(2)+'%');
    },{passive:true});
    card.addEventListener('pointerleave',()=>resetLight(card),{passive:true});
  }
  function scan(){scanFrame=0;document.querySelectorAll(selector).forEach(mount);}
  window.OffpeakIsometric={
    refresh:scan,
    getPose(card){return cards.has(card)?{x:0,y:0,z:0,scale:1}:null;},
    getFlatBox(card){return card.getBoundingClientRect();}
  };
  function start(){
    scan();
    new MutationObserver(records=>{
      const relevant=records.some(record=>{
        if(record.type==='attributes')return !record.target.closest?.(excluded)&&record.target.matches?.(selector)&&!cards.has(record.target);
        return [...record.addedNodes].some(node=>node.nodeType===1&&!node.closest(excluded)&&(node.matches(selector)||node.querySelector(selector)));
      });
      if(relevant&&!scanFrame)scanFrame=requestAnimationFrame(scan);
    }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
