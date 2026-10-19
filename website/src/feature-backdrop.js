/* One scroll-scheduled paint for a local backdrop; no independent animation loop. */
(() => {
  'use strict';
  if(window.OffpeakFeatureBackdrop)return;

  function mount(){
    const section=document.getElementById('productivity');
    const content=section?.querySelector(':scope > .mx-auto');
    if(!section||!content||section.dataset.featureBackdrop==='ready')return;

    const layer=document.createElement('div');
    layer.className='feature-backdrop';
    layer.setAttribute('aria-hidden','true');
    const grid=document.createElement('div');
    grid.className='feature-backdrop-grid';
    layer.append(grid);
    section.prepend(layer);
    content.classList.add('feature-backdrop-content');
    section.dataset.featureBackdrop='ready';

    const reduced=matchMedia('(prefers-reduced-motion:reduce)');
    const mobile=matchMedia('(max-width:700px)');
    let visible=false,frame=0,lastOffset=0,destroyed=false;

    function setOffset(value){
      if(Math.abs(value-lastOffset)<.04)return;
      lastOffset=value;
      section.style.setProperty('--feature-grid-y',`${value.toFixed(2)}px`);
    }
    function paint(){
      frame=0;
      if(destroyed||!visible||document.hidden||reduced.matches)return;
      const rect=section.getBoundingClientRect();
      const viewport=window.innerHeight;
      const travel=(viewport/2-(rect.top+rect.height/2))/Math.max(1,(viewport+rect.height)/2);
      const progress=Math.max(-1,Math.min(1,travel));
      setOffset(progress*(mobile.matches?20:32));
    }
    function schedule(){
      if(!frame&&!destroyed&&visible&&!document.hidden&&!reduced.matches)frame=requestAnimationFrame(paint);
    }
    function visibility(){
      section.dataset.featureBackdropVisible=String(visible&&!document.hidden);
      if((!visible||document.hidden)&&frame){cancelAnimationFrame(frame);frame=0;}
      else schedule();
    }
    function preference(){
      if(reduced.matches){
        if(frame)cancelAnimationFrame(frame);
        frame=0;setOffset(0);
      }else schedule();
    }

    const intersection=new IntersectionObserver(entries=>{
      visible=entries[entries.length-1].isIntersecting;
      visibility();
    },{rootMargin:'100px 0px'});
    intersection.observe(section);
    const resize=new ResizeObserver(schedule);
    resize.observe(section);
    // Lenis drives native window scroll events, so this shares its existing clock.
    window.addEventListener('scroll',schedule,{passive:true});
    window.addEventListener('resize',schedule,{passive:true});
    document.addEventListener('visibilitychange',visibility);
    reduced.addEventListener('change',preference);
    mobile.addEventListener('change',schedule);

    window.OffpeakFeatureBackdrop={
      getState:()=>({visible,offset:lastOffset,reduced:reduced.matches,scheduled:Boolean(frame)}),
      destroy(){
        destroyed=true;
        if(frame)cancelAnimationFrame(frame);
        intersection.disconnect();resize.disconnect();
        window.removeEventListener('scroll',schedule);
        window.removeEventListener('resize',schedule);
        document.removeEventListener('visibilitychange',visibility);
        reduced.removeEventListener('change',preference);
        mobile.removeEventListener('change',schedule);
        layer.remove();content.classList.remove('feature-backdrop-content');
        delete section.dataset.featureBackdrop;
        delete section.dataset.featureBackdropVisible;
        section.style.removeProperty('--feature-grid-y');
        delete window.OffpeakFeatureBackdrop;
      }
    };
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
