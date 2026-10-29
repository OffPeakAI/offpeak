/* Compact front-facing request controls, synchronized with the conversation. */
(() => {
  'use strict';
  const steps=[
    {label:'Find power',verb:'Spare computing power',icon:'gpu'},
    {label:'See price',verb:'Know the cost',icon:'quote'},
    {label:'Set limit',verb:'Control your spending',icon:'cap'},
    {label:'Run AI',verb:'Pay for what you use',icon:'signal'},
    {label:'Keep receipt',verb:'Keep a private record',icon:'receipt'}
  ];
  const shapes={
    gpu:'<path d="M8 4v4m5-4v4m6-4v4m5-4v4M8 24v4m5-4v4m6-4v4m5-4v4M4 10h3m-3 6h3m-3 6h3m18-12h3m-3 6h3m-3 6h3" class="roadmap-icon-pin"/><rect x="7" y="7" width="18" height="18" rx="4" fill="url(#roadmap-gpu-metal)" stroke="#7b7b7b"/><rect x="11" y="11" width="10" height="10" rx="2" fill="#272727" stroke="#b0b0b0" stroke-width=".7"/><path d="M14 14v4m4-4v4" class="roadmap-icon-lime"/>',
    quote:'<rect x="6" y="4" width="20" height="24" rx="4" fill="url(#roadmap-quote-metal)" stroke="#888888"/><rect x="9" y="7" width="14" height="10" rx="2" fill="#262626"/><path d="M12 12h3m3 0h2" class="roadmap-icon-lime"/><path d="M10 21h6m-6 3h9" class="roadmap-icon-line"/><circle cx="22" cy="23" r="1.5" fill="#ccff00"/>',
    cap:'<path d="M11 14V10a5 5 0 0 1 10 0v4" fill="none" stroke="#a8a8a8" stroke-width="3"/><path d="M11 14V10a5 5 0 0 1 10 0v4" fill="none" stroke="#f2f2f2" stroke-width="1"/><rect x="7" y="13" width="18" height="15" rx="4" fill="url(#roadmap-cap-metal)" stroke="#7d7d7d"/><rect x="11" y="17" width="10" height="6" rx="2" fill="#262626"/><path d="M13 20h6" class="roadmap-icon-lime"/><circle cx="16" cy="25" r=".8" fill="#c9c9c9"/>',
    signal:'<rect x="4" y="6" width="24" height="21" rx="5" fill="url(#roadmap-signal-metal)" stroke="#838383"/><rect x="7" y="9" width="18" height="13" rx="3" fill="#252525" stroke="#a1a1a1" stroke-width=".6"/><path d="M9 16h3l2-4 3 8 2-5h4" class="roadmap-icon-lime roadmap-icon-signal"/><path d="M10 25h4m3 0h5" class="roadmap-icon-line"/>',
    receipt:'<path d="M8 4h16v24l-3-2-3 2-3-2-3 2-4-2Z" fill="url(#roadmap-receipt-paper)" stroke="#aaaaaa"/><path d="M11 9h10m-10 4h7m-7 4h10" fill="none" stroke="#818181" stroke-width="1.2" stroke-linecap="round"/><rect x="11" y="20" width="10" height="4" rx="1.5" fill="#353535"/><path d="m14 22 1 1 3-2" fill="none" stroke="#ccff00" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  function icon(type){
    return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><defs><linearGradient id="roadmap-${type}-metal" x2=".8" y2="1"><stop stop-color="#878787"/><stop offset=".48" stop-color="#5a5a5a"/><stop offset="1" stop-color="#343434"/></linearGradient><linearGradient id="roadmap-${type}-paper" x2=".8" y2="1"><stop stop-color="#fefefe"/><stop offset="1" stop-color="#e3e3e3"/></linearGradient></defs>${shapes[type]}</svg>`;
  }
  function mount(){
    const section=document.querySelector('#about[data-tech-conversation]');
    if(!section||section.dataset.techRoadmap)return;
    const footer=section.querySelector('.tech-footer'),originalGroup=footer?.querySelector('[role="group"]');
    if(!footer||!originalGroup)return;
    const originalButtons=[...originalGroup.querySelectorAll('[data-tech-step]')];
    if(originalButtons.length!==5)return;
    section.dataset.techRoadmap='true';originalGroup.classList.add('roadmap-original-controls');
    const roadmap=document.createElement('div');roadmap.className='tech-roadmap';roadmap.dataset.artReady='true';
    roadmap.innerHTML=`<div class="roadmap-stations" role="group" aria-label="Follow your AI request">${steps.map((s,i)=>`<button type="button" class="roadmap-station" data-roadmap-step="${i}" aria-controls="tech-topic-${i}" aria-pressed="${!i}" aria-label="${i+1}. ${s.label}: ${s.verb}" tabindex="${i?'-1':'0'}"><span class="roadmap-bubble" aria-hidden="true">${icon(s.icon)}<i class="roadmap-port"></i></span><span class="roadmap-name">${s.label}</span></button>`).join('')}</div><div class="roadmap-meta"><span class="roadmap-stage-label"><b data-roadmap-count>01 / 05</b><span class="roadmap-phase" data-roadmap-phase>Spare computing power</span></span><span class="roadmap-guide-slot"></span></div>`;
    footer.prepend(roadmap);
    const guide=footer.querySelector('a');
    if(guide){guide.textContent='More technical details ↗';roadmap.querySelector('.roadmap-guide-slot').appendChild(guide);}
    const buttons=[...roadmap.querySelectorAll('[data-roadmap-step]')];
    const phase=roadmap.querySelector('[data-roadmap-phase]'),count=roadmap.querySelector('[data-roadmap-count]');
    const reduced=matchMedia('(prefers-reduced-motion:reduce)');
    let selected=-1,visible=false;
    function synchronize(){
      const index=Math.max(0,Math.min(4,Number(section.dataset.techStep)||0));
      if(index!==selected){
        selected=index;
        buttons.forEach((button,i)=>{button.setAttribute('aria-pressed',String(i===index));button.tabIndex=i===index?0:-1;button.dataset.routeState=i<index?'passed':i===index?'current':'ahead';});
        count.textContent=`${String(index+1).padStart(2,'0')} / 05`;phase.textContent=steps[index].verb;roadmap.dataset.stage=String(index);
      }
      roadmap.dataset.running=String(visible&&!document.hidden&&!reduced.matches&&section.dataset.techPaused!=='true');
    }
    function activate(index,focus=false){
      index=Math.max(0,Math.min(4,index));
      if(focus)buttons[index].focus({preventScroll:true});
      originalButtons[index].click();
    }
    buttons.forEach((button,index)=>{
      button.addEventListener('click',()=>activate(index));
      button.addEventListener('keydown',event=>{
        let next;
        if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%5;
        else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index+4)%5;
        else if(event.key==='Home')next=0;
        else if(event.key==='End')next=4;
        else return;
        event.preventDefault();activate(next,true);
      });
    });
    new MutationObserver(synchronize).observe(section,{attributes:true,attributeFilter:['data-tech-step','data-tech-paused','data-tech-visible']});
    new IntersectionObserver(entries=>{visible=entries[entries.length-1].isIntersecting;synchronize();}).observe(roadmap);
    document.addEventListener('visibilitychange',synchronize);reduced.addEventListener('change',synchronize);
    synchronize();
    section._offpeakRoadmap={select:activate,getState:()=>({selected,visible,paused:reduced.matches||section.dataset.techPaused==='true',artReady:'true',actors:0})};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
