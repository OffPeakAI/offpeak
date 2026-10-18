(function(){
  'use strict';
  const NS='http://www.w3.org/2000/svg',TAU=Math.PI*2,NEON='#CCFF00';
  const camera={x:2.25,yx:-.2,yy:.9,z:1.35,ox:800,oy:435};
  const p=(x,y,z=0)=>[camera.ox+x*camera.x+y*camera.yx,camera.oy+y*camera.yy-z*camera.z];
  const fmt=n=>Math.round(n*100)/100,pts=a=>a.map(q=>q.map(fmt).join(',')).join(' ');
  const mod=(a,b)=>((a%b)+b)%b;
  const path=(d,color='#8B9588',w=1,extra='')=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
  const rect=(x,y,w,h,fill,r=0)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
  const ellipse=(x,y,rx,ry,fill,extra='')=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
  const poly=(a,fill,stroke='#6E796E')=>`<polygon points="${pts(a)}" fill="${fill}" stroke="${stroke}" stroke-width=".65" stroke-linejoin="round"/>`;
  const top=(x,y,z,w,d,fill)=>poly([p(x,y,z),p(x+w,y,z),p(x+w,y+d,z),p(x,y+d,z)],fill);
  const box=(x,y,z,w,d,h,c={})=>poly([p(x,y+d,z),p(x+w,y+d,z),p(x+w,y+d,z+h),p(x,y+d,z+h)],c.front||'#AEB9A4')+poly([p(x+w,y,z),p(x+w,y+d,z),p(x+w,y+d,z+h),p(x+w,y,z+h)],c.side||'#778771')+top(x,y,z+h,w,d,c.top||'#E6EDDB');
  const plane=(x,y,z,body)=>{const q=p(x,y,z);return `<g transform="matrix(${camera.x} 0 0 ${camera.z} ${q[0]} ${q[1]})">${body}</g>`};
  const roof=(x,y,z,body)=>{const q=p(x,y,z);return `<g transform="matrix(${camera.x} 0 ${camera.yx} ${camera.yy} ${q[0]} ${q[1]})">${body}</g>`};
  const circle=(x,y,r,fill,extra='')=>ellipse(x,y,r,r,fill,extra);
  const svgNode=(markup,parent)=>{const g=document.createElementNS(NS,'g');g.innerHTML=markup;parent?.appendChild(g);return g;};
  const attr=(el,key,value)=>el.setAttribute(key,String(value));
  const translate=(el,x,y)=>attr(el,'transform',`translate(${fmt(x)} ${fmt(y)})`);
  const ring=[[-329,-253],[317,-253],[317,223],[-329,223],[-329,-253]],inner=[[-105,-224],[109,-224],[109,193],[-105,193],[-105,-224]];
  function route(points,v){let lens=points.slice(1).map((q,i)=>Math.hypot(q[0]-points[i][0],q[1]-points[i][1]));let d=mod(v,1)*lens.reduce((a,b)=>a+b,0);for(let i=0;i<lens.length;i++){if(d<=lens[i]){const a=points[i],b=points[i+1],t=d/lens[i];return{x:a[0]+(b[0]-a[0])*t,y:a[1]+(b[1]-a[1])*t,dx:Math.sign(b[0]-a[0]),dy:Math.sign(b[1]-a[1])}}d-=lens[i]}return{x:points[0][0],y:points[0][1],dx:1,dy:0}}
  const entries={
    capacity:{title:'Spare capacity',chip:'Open models · GPU supply',text:'Idle GPUs become available to serve open models. The city’s cooling towers represent that shared pool of compute.',icon:'▥'},
    quote:{title:'A quote that stays put',chip:'Quote · Accept · Run',text:'Review a capacity-based quote before a call. Accept it to hold that rate for the request.',icon:'◴'},
    authorization:{title:'You authorize each call',chip:'Wallet signature · Spend cap',text:'A signed authorization sets the permitted spend for one call. The gate represents that boundary.',icon:'⌘'},
    inference:{title:'Inference in motion',chip:'Prompt · Model · Response',text:'An accepted request reaches the model. The workshop turns input into a response through a familiar API.',icon:'⌁'},
    meter:{title:'Pay for what runs',chip:'Meter · Charge · Release',text:'Metered usage determines the charge. Unused authorized balance returns through the release path.',icon:'▤'},
    receipt:{title:'A private record',chip:'Receipt · Signature · Inclusion',text:'Keep a signed receipt for the call. Batch inclusion checks connect that record to a published root.',icon:'≡'}
  };
  const iconMarkup={capacity:'<rect x="4" y="5" width="5" height="14" rx="1"/><rect x="11" y="3" width="5" height="16" rx="1"/><path d="M6 8h1m6-2h1M6 12h1m6-2h1M6 16h1m6-2h1"/>',quote:'<path d="M4 17a8 8 0 0 1 16 0M12 16l4-8"/><circle cx="12" cy="16" r="1"/>',authorization:'<circle cx="8" cy="10" r="4"/><path d="M12 10h8m-3 0v4m-4-4v3"/>',inference:'<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/>',meter:'<path d="M5 18V12m5 6V8m5 10V5m5 13V10"/>',receipt:'<path d="M6 3h9l4 4v14l-3-2-3 2-3-2-3 2V3Z"/><path d="M10 8h5m-5 4h5m-5 4h3"/>'};
  const icon=id=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${iconMarkup[id]}</svg>`;
  // These are a deterministic demonstration, never an external feed or a product promise.
  const metrics={
    capacity:[['GPU utilization',67.4,8.6,'%',1],['Available capacity',32.6,-8.6,'%',1],['Model throughput',812,124,'tok/s',0]],
    quote:[['Quotes per second',24.8,5.2,'/s',1],['Quote response',58,12,'ms',0],['Acceptance rate',86.2,5.8,'%',1]],
    authorization:[['Authorizations',22.4,4.1,'/s',1],['Validation time',18,4,'ms',0],['Cap utilization',62.1,9.8,'%',1]],
    inference:[['Token throughput',812,124,'tok/s',0],['Time to first token',124,26,'ms',0],['Concurrent calls',18,5,'calls',0]],
    meter:[['Metered throughput',796,118,'tok/s',0],['Meter lag',12,3,'ms',0],['Balance released',18.4,4.6,'%',1]],
    receipt:[['Signing throughput',21.6,4.2,'/s',1],['Proof verification',42,8,'ms',0],['Batch utilization',74.2,13.8,'%',1]]
  };
  let assetPromise;
  async function assets(){return assetPromise||(assetPromise=Promise.all([fetch('/assets/offpeak-city-live.svg').then(r=>{if(!r.ok)throw new Error('City artwork unavailable');return r.text()}),fetch('/assets/offpeak-city-live-state.json').then(r=>{if(!r.ok)throw new Error('City motion unavailable');return r.json()})]));}

  async function mount(host){
    if(!host)return null;if(host._offpeakCity)return host._offpeakCity;
    host.classList.add('offpeak-city-host');host.setAttribute('aria-busy','true');host.dataset.cityView='front';host.dataset.cityAnalytics='illustrative';
    const [source,state]=await assets();if(!host.isConnected)return null;if(state.camera)Object.assign(camera,state.camera);
    const doc=new DOMParser().parseFromString(source,'image/svg+xml');if(doc.querySelector('parsererror'))throw new Error('City SVG failed to parse');
    const graphic=document.importNode(doc.documentElement,true);graphic.classList.add('opcity-art');graphic.setAttribute('aria-hidden','true');graphic.setAttribute('preserveAspectRatio','none');graphic.removeAttribute('width');graphic.removeAttribute('height');
    const stage=document.createElement('div');stage.className='opcity-stage';
    const viewport=document.createElement('div');viewport.className='opcity-viewport';viewport.appendChild(graphic);stage.appendChild(viewport);
    const readouts=document.createElement('div');readouts.className='opcity-readouts';readouts.setAttribute('aria-hidden','true');viewport.appendChild(readouts);
    const points=document.createElement('div');points.className='opcity-hotspots';points.setAttribute('role','group');points.setAttribute('aria-label','Explore the six districts');viewport.appendChild(points);
    const info=document.createElement('div');info.className='opcity-info';info.setAttribute('aria-live','polite');info.innerHTML='<span class="opcity-kicker">Illustrative analytics</span><p class="opcity-hint">Choose a district to explore its activity.</p>';stage.appendChild(info);
    const analyticsSummary=document.createElement('output');analyticsSummary.className='opcity-sr-only';analyticsSummary.setAttribute('aria-label','Illustrative city analytics');stage.appendChild(analyticsSummary);
    const pause=document.createElement('button');pause.type='button';pause.className='opcity-pause';pause.innerHTML='<span class="opcity-pause-symbol" aria-hidden="true">Ⅱ</span><span>Pause motion</span>';stage.appendChild(pause);
    const footer=document.createElement('div');footer.className='opcity-footer';footer.append(info,pause);
    const mobileNav=document.createElement('div');mobileNav.className='opcity-mobile-nav';mobileNav.setAttribute('role','group');mobileNav.setAttribute('aria-label','City analytics district');
    host.replaceChildren(stage,mobileNav,footer);host.setAttribute('aria-busy','false');host.dataset.cityReady='true';
    const details=graphic.querySelector('[data-city-details]'),trafficLayer=graphic.querySelector('[data-city-traffic]'),air=graphic.querySelector('[data-city-air]'),fields=graphic.querySelector('[data-city-fields]');
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');let paused=reduced.matches,visible=true,selected='capacity',focus=null,clock=0,last=performance.now(),lastDraw=0,raf=0,dead=false;
    const pointer={active:false,x:800,y:360,sx:800,sy:360};
    const districtState=new Map(state.districts.map(d=>{const q=p(d.x,d.y,d.z);return[d.id,{...d,cx:q[0],cy:q[1],energy:0}]}));
    let analyticsTick=-1;
    const instruments=[...graphic.querySelectorAll('[data-city-instrument]')].map((g,i)=>{const reading=document.createElement('div');reading.className='opcity-reading';reading.style.left=`${(120+i*500)/state.width*100}%`;reading.innerHTML='<span class="opcity-reading-label"></span><span class="opcity-reading-row"><b class="opcity-reading-value"></b><small class="opcity-reading-unit"></small></span>';readouts.appendChild(reading);g.querySelectorAll('[data-metric-label],[data-metric-value],[data-metric-unit]').forEach(n=>n.style.visibility='hidden');return{node:g,label:reading.querySelector('.opcity-reading-label'),value:reading.querySelector('.opcity-reading-value'),unit:reading.querySelector('.opcity-reading-unit'),line:g.querySelector('[data-metric-line]'),fill:g.querySelector('[data-metric-fill]'),dot:g.querySelector('[data-metric-dot]')};});
    function sample(metric,t,index){return metric[1]+metric[2]*(.74*Math.sin(t*TAU/20+index*.55)+.26*Math.sin(t*TAU/10+index*.9));}
    function analytics(t,force=false){const tick=Math.floor(t);if(!force&&tick===analyticsTick)return;analyticsTick=tick;const set=metrics[selected||'capacity'],summary=[];host.dataset.cityMetricSet=selected||'capacity';instruments.forEach((a,i)=>{const m=set[i],phaseIndex=selected==='capacity'&&i===1?0:i,value=sample(m,tick,phaseIndex),formatted=value.toFixed(m[4]);a.label.textContent=m[0];a.value.textContent=formatted;a.unit.textContent=m[3];const span=Math.abs(m[2])||1,trace=Array.from({length:27},(_,k)=>[145+k*7.1,34-(sample(m,tick-20+k*20/26,phaseIndex)-m[1])/span*10]);attr(a.line,'points',pts(trace));attr(a.fill,'d',`M${trace.map(q=>q.map(fmt).join(' ')).join('L')}L329.6 45H145Z`);attr(a.dot,'cy',trace.at(-1)[1]);attr(a.dot,'cx',trace.at(-1)[0]);summary.push(`${m[0]} ${formatted} ${m[3]}`);});analyticsSummary.textContent=`Illustrative ${selected||'capacity'} activity: ${summary.join('; ')}.`;}
    function select(id){if(!entries[id])return;selected=id;for(const b of host.querySelectorAll('button[data-district]'))b.setAttribute('aria-pressed',String(b.dataset.district===id));const e=entries[id];info.innerHTML=`<span class="opcity-kicker">Illustrative analytics · ${e.chip}</span><h3>${e.title}</h3><p>${e.text}</p>`;info.classList.add('is-selected');host.dataset.citySelected=id;analytics(clock,true);wake();}
    for(const d of districtState.values()){
      const b=document.createElement('button');b.type='button';b.className='opcity-hotspot';b.dataset.district=d.id;b.style.left=`${d.cx/state.width*100}%`;b.style.top=`${d.cy/state.height*100}%`;b.setAttribute('aria-label',`${entries[d.id].title}: show illustrative analytics`);b.setAttribute('aria-pressed','false');b.innerHTML=`${icon(d.id)}<span>${({capacity:'Capacity',quote:'Quotes',authorization:'Authorize',inference:'Inference',meter:'Metering',receipt:'Receipts'})[d.id]}</span>`;
      b.addEventListener('click',()=>select(d.id));b.addEventListener('pointerenter',()=>{focus=d.id;wake()});b.addEventListener('pointerleave',()=>focus=null);b.addEventListener('focus',()=>{focus=d.id;wake()});b.addEventListener('blur',()=>focus=null);points.appendChild(b);d.button=b;
      const mobileButton=b.cloneNode(true);mobileButton.className='opcity-district-tab';mobileButton.removeAttribute('style');mobileButton.addEventListener('click',()=>select(d.id));mobileNav.appendChild(mobileButton);
      d.halo=svgNode(ellipse(d.cx,d.cy-4,72,33,'url(#city-neon-field)','opacity="0"'),fields).firstChild;
    }
    const currentEnergy=id=>districtState.get(id)?.energy||0;
    const fanActors=state.fans.map(f=>{
      let blades='';for(let i=0;i<5;i++)blades+=`<path d="M0 0C${f.r*.15} ${-f.r*.7} ${f.r*.9} ${-f.r*.9} ${f.r*.78} ${-f.r*.28}Q${f.r*.36} ${f.r*.2} 0 0" fill="#8D9B84" transform="rotate(${i*72})"/>`;
      const g=svgNode(roof(f.x,f.y,f.z,`<g data-spin>${blades}</g>${circle(0,0,2.2,'#E2EAD8')}${circle(0,0,f.r,'none','stroke="#CCFF00" stroke-width=".75" opacity=".25" data-ring=""')}`),details);
      return {...f,spin:g.querySelector('[data-spin]'),ring:g.querySelector('[data-ring]'),angle:f.phase*180};
    });
    const ledActors=state.leds.map(l=>({...l,node:svgNode(plane(l.x,l.y,l.z,rect(0,0,l.w,2.3,NEON,.4)),details).querySelector('rect')}));
    const eyes=[...graphic.querySelectorAll('[data-city-eyes]')].map(e=>({id:e.dataset.cityEyes,lights:[...e.querySelectorAll('rect')].slice(1)}));
    const cars=[];
    const carShape=(w,d,train)=>box(-w/2,-d/2,3,w,d,5,{top:train?'#DAEBC1':'#EFF2E7',front:'#88977D',side:'#586C4E'})+top(-w*.29,-d*.29,8.2,w*.58,d*.58,'#354231')+top(-w*.14,-d*.14,8.3,w*.28,d*.28,train?NEON:'#D0E29F');
    for(let i=0;i<19;i++){const train=i>=14,len=train?23:15;const g=svgNode(`<g data-axis="x">${carShape(len,7,train)}</g><g data-axis="y">${carShape(7,len,train)}</g>`,trafficLayer);cars.push({node:g,x:g.children[0],y:g.children[1],i,train});}
    const routeList=[[[-281,-45],[257,-45],[257,23]],[[-136,-209],[-136,199]],[[85,-209],[85,199]],[[-277,205],[283,205]]];
    const pulses=[];routeList.forEach((r,j)=>{svgNode(`<polyline points="${pts(r.map(q=>p(...q,2.8)))}" fill="none" stroke="#CCFF00" stroke-width=".6" opacity=".20"/>`,trafficLayer);for(let i=0;i<5;i++)pulses.push({r,j,i,node:svgNode(ellipse(0,0,3,1.3,NEON)+ellipse(0,0,6,2.5,NEON,'opacity=".14"'),trafficLayer)});});
    const people=[];for(let i=0;i<18;i++)people.push({i,node:svgNode(ellipse(0,1,2,1,'#53614E','opacity=".13"')+path('M0 0V-5',i%3?'#93A284':'#526846',1.3)+circle(0,-6,1.2,'#CED7BF'),trafficLayer)});
    const gauge=svgNode(plane(-57,-110,68,`<g data-needle>${path('M39 35V11',NEON,1.9)}${circle(39,35,2.7,'#E8F2D3')}</g>`),details).querySelector('[data-needle]');
    const ticketActors=[];for(let i=0;i<5;i++)ticketActors.push({i,node:svgNode(top(0,0,0,6,6,'#F5F9ED')+top(1,1,.1,4,1,NEON),details)});
    const scan=svgNode('<polygon fill="#CCFF00" opacity=".13"/><polyline fill="none" stroke="#CCFF00" stroke-width="1.7"/>',details),gate=svgNode('<polyline fill="none" stroke="#657658" stroke-width="4" stroke-linecap="round"/><polyline fill="none" stroke="#CCFF00" stroke-width="2" stroke-linecap="round"/>',details);
    const arms=[[-278,131,45,0],[-177,131,45,Math.PI]].map(a=>({a,node:svgNode('<polyline fill="none" stroke="#607256" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><polyline fill="none" stroke="#DCE6CF" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>'+[0,1,2].map(()=>circle(0,0,3.5,'#CCFF00','stroke="#5B7050" stroke-width="1"')).join('')+'<path fill="none" stroke="#536E48" stroke-width="1.6"/>',details)}));
    const parcelShape=box(0,0,0,6,6,5,{top:'#E2ECCF',front:'#AAC38D',side:'#729452'})+top(1,1,5.2,4,3,NEON);
    const parcels=[];for(let i=0;i<19;i++)parcels.push({i,node:svgNode(parcelShape,details)});
    const barsGroup=svgNode(plane(-59,136,50,Array.from({length:13},(_,i)=>rect(5+i*6.3,10,3.5,13,i<8?NEON:'#627B43',.5)).join('')),details),bars=[...barsGroup.querySelectorAll('rect')];
    const diverter=svgNode(path('M-8 0L10 3',NEON,2.2),details);
    const printer=svgNode(plane(220,178,43,'<path fill="#FAFCF0" stroke="#AABF98" stroke-width=".6"/>'+path('M6 7H30M6 12H27M6 17H20','#93A779',.7)),details).querySelector('path');
    const [beaconX,beaconY]=p(267,72,121),beacon=svgNode(ellipse(beaconX,beaconY,25,12,'none','stroke="#CCFF00" stroke-width="1.2" opacity=".5"')+[0,1,2].map(()=>ellipse(0,0,2.3,1.5,NEON)).join(''),details);
    const lift=svgNode(box(191,92,0,10,19,13,{top:'#DDEAC9',front:'#859F6C',side:'#627E4F'})+plane(192,111,11,rect(0,0,7,7,'#CCFF00',1)),details);
    const drones=[];for(let i=0;i<4;i++){
      const g=svgNode(box(-4,-4,0,8,8,4,{top:'#E9EFE0',front:'#87997A',side:'#587147'})+top(-2,-2,4.1,4,4,NEON),air),rotors=[];
      for(const [ox,oy]of[[-8,-7],[8,-7],[-8,7],[8,7]]){const q=p(ox,oy,2);svgNode(`<polyline points="800,435 ${q.join(',')}" stroke="#728A61" stroke-width="1"/>${ellipse(q[0],q[1],5,2.5,'none','stroke="#A7BB93" stroke-width=".7"')}`,g);rotors.push(svgNode(path('M-5 0H5',NEON,1),g));rotors[rotors.length-1].dataset.cx=q[0];rotors[rotors.length-1].dataset.cy=q[1];}
      drones.push({i,node:g,rotors});
    }
    const field=svgNode(ellipse(0,0,64,31,'none','stroke="#CCFF00" stroke-width=".8" opacity=".24" stroke-dasharray="2 9"')+ellipse(0,0,23,11,'none','stroke="#CCFF00" stroke-width=".75" opacity=".4"')+ellipse(0,0,4,2,NEON,'opacity=".6"'),fields);field.style.opacity='0';
    const motes=Array.from({length:12},(_,i)=>({i,node:svgNode(ellipse(0,0,1.7,.85,NEON,'opacity=".65"'),fields)}));

    function energy(){for(const d of districtState.values()){const distance=Math.hypot(pointer.sx-d.cx,pointer.sy-(d.cy-70));const local=pointer.active?Math.max(0,1-distance/245):0,target=Math.max(local,selected===d.id?.75:0,focus===d.id?1:0);d.energy+=(target-d.energy)*(paused?1:.13);d.button.style.setProperty('--district-energy',d.energy.toFixed(3));attr(d.halo,'opacity',(d.energy*.8).toFixed(3));}}
    function update(t,dt){const u=mod(t,20)/20;pointer.sx+=(pointer.x-pointer.sx)*(paused?1:.12);pointer.sy+=(pointer.y-pointer.sy)*(paused?1:.12);energy();
      for(const f of fanActors){const e=currentEnergy(f.district);f.angle=mod(f.angle+dt*360*(1+e*2),360);attr(f.spin,'transform',`rotate(${fmt(f.angle)})`);attr(f.ring,'opacity',.2+e*.8);}
      for(const l of ledActors)attr(l.node,'opacity',Math.min(1,.35+.55*Math.sin(u*TAU*3+l.phase)**2+currentEnergy(l.district)*.55));
      for(const e of eyes){const pulse=.91+.09*Math.sin(u*TAU*2);const blink=mod(t+(e.id.length*.13),6.4);for(const light of e.lights)light.style.opacity=blink>5.85&&blink<5.97?'.36':String(pulse);}
      for(const c of cars){const v=route(c.train?ring:c.i%3?ring:inner,c.train?u+.16-(c.i-14)*.0115:(c.i%2?1:-1)*u*(c.i%3===0?2:1)+c.i*.071);const q=p(v.x,v.y);translate(c.node,q[0]-camera.ox,q[1]-camera.oy);c.x.style.display=v.dx?'':'none';c.y.style.display=v.dy?'':'none';}
      for(const r of pulses){const v=route(r.r,u*4+r.i*.2+r.j*.18),q=p(v.x,v.y,3);translate(r.node,...q);}
      for(const person of people){const v=route([[-300,19],[286,19],[286,25],[-300,25],[-300,19]],u+person.i/18);translate(person.node,...p(v.x,v.y,2));}
      attr(gauge,'transform',`rotate(${-50+60*(.5+.5*Math.sin(u*TAU*2))} 39 35)`);
      for(const ticket of ticketActors){const q=p(-54+mod(u*4+ticket.i*.2,1)*86,-85,15);translate(ticket.node,q[0]-camera.ox,q[1]-camera.oy);}
      const scanZ=12+54*(.5+.5*Math.sin(u*TAU*4));attr(scan.children[0],'points',pts([p(195,-141,scanZ),p(233,-141,scanZ),p(233,-176,scanZ),p(195,-176,scanZ)]));attr(scan.children[1],'points',pts([p(195,-141,scanZ),p(233,-141,scanZ)]));scan.style.opacity=String(.6+currentEnergy('authorization')*.4);
      const ga=(.5+.5*Math.sin(u*TAU*2))*1.2,gatePoints=pts([p(188,-124,28),p(188+46*Math.cos(ga),-124,28+46*Math.sin(ga))]);for(const n of gate.children)attr(n,'points',gatePoints);
      for(const a of arms){const[x,y,z,phase]=a.a,s=Math.sin(t*TAU/5+phase),c=Math.cos(t*TAU/5+phase),world=[[x,y,z],[x+13+13*s,y-9,z+23+5*c],[x+29+13*s,y+7+10*c,z+9+7*s]],q=world.map(v=>p(...v)),spts=pts(q);attr(a.node.children[0],'points',spts);attr(a.node.children[1],'points',spts);for(let i=0;i<3;i++){attr(a.node.children[i+2],'cx',q[i][0]);attr(a.node.children[i+2],'cy',q[i][1]);}attr(a.node.children[5],'d',`M${q[2][0]-3} ${q[2][1]+2}v5h3m6-5v5h-3`);}
      for(const parcel of parcels){let q;const i=parcel.i;if(i<8)q=p(-293+mod(u*4+i/8,1)*124,145,22);else if(i<15)q=p(-71+mod(u*4+(i-8)/7,1)*124,155+(i%2?8:0),26);else q=p(-72+mod(-u*2+(i-15)*.25,1)*128,189,5);translate(parcel.node,q[0]-camera.ox,q[1]-camera.oy);}
      bars.forEach((b,i)=>{const h=5+14*(.5+.5*Math.sin(u*TAU*2+i*.35));attr(b,'height',h);attr(b,'y',23-h);b.style.opacity=String(.65+.35*currentEnergy('meter'));});
      const d=p(-19,162,35);attr(diverter,'transform',`translate(${d[0]} ${d[1]}) rotate(${Math.sin(u*TAU*4)*18})`);
      const len=20+24*(.5+.5*Math.sin(u*TAU*2));attr(printer,'d',`M0 0H38V${len-7}Q38 ${len+1} 32 ${len+2}H-6Q0 ${len-1} 0 ${len-7}Z`);
      const pulse=.5+.5*Math.sin(u*TAU*5);attr(beacon.children[0],'rx',24+8*pulse);attr(beacon.children[0],'ry',12+4*pulse);for(let i=0;i<3;i++){const a=u*TAU*2+i*TAU/3;attr(beacon.children[i+1],'cx',beaconX+26*Math.cos(a));attr(beacon.children[i+1],'cy',beaconY+13*Math.sin(a));}
      translate(lift,0,-camera.z*(16+86*(.5-.5*Math.cos(u*TAU*2))));
      for(const drone of drones){const i=drone.i,a=u*TAU+i*.25*TAU,x=110*Math.cos(a)+(i%2?110:-150),y=77*Math.sin(a)+(i<2?-120:112),z=155+13*Math.sin(a*2+i),q=p(x,y,z),dist=Math.hypot(pointer.sx-q[0],pointer.sy-q[1]),pull=pointer.active?Math.max(0,1-dist/220)*.13:0;translate(drone.node,q[0]-camera.ox+(pointer.sx-q[0])*pull,q[1]-camera.oy+(pointer.sy-q[1])*pull);for(const r of drone.rotors)attr(r,'transform',`translate(${r.dataset.cx} ${r.dataset.cy}) scale(1 .5) rotate(${u*360*40})`);}
      translate(field,pointer.sx,pointer.sy);field.style.opacity=pointer.active?'1':'0';
      motes.forEach(m=>{const d=state.districts[m.i%6],q=p(d.x,d.y,65),a=u*TAU*2+m.i*.79,x=q[0]+34*Math.cos(a),y=q[1]+17*Math.sin(a),dist=Math.hypot(pointer.sx-x,pointer.sy-y),pull=pointer.active?Math.max(0,1-dist/235)*.65:0;translate(m.node,x+(pointer.sx-x)*pull,y+(pointer.sy-y)*pull);m.node.style.opacity=String(pointer.active?Math.max(.1,pull):.15);});
      analytics(t);host.dataset.cityTime=t.toFixed(2);
    }
    function frame(now){raf=0;if(dead)return;if(now-lastDraw<30){if(!paused&&visible&&!document.hidden)raf=requestAnimationFrame(frame);return;}const dt=Math.min((now-last)/1000,.08);last=now;lastDraw=now;if(!paused&&visible&&!document.hidden)clock=mod(clock+dt,20);update(clock,paused?0:dt);if(!paused&&visible&&!document.hidden)raf=requestAnimationFrame(frame);}
    function wake(){if(dead)return;if(!raf){last=performance.now();raf=requestAnimationFrame(frame);}}
    function setPaused(value){paused=Boolean(value);pause.setAttribute('aria-pressed',String(paused));pause.setAttribute('aria-label',paused?'Resume city motion':'Pause city motion');pause.innerHTML=`<span class="opcity-pause-symbol" aria-hidden="true">${paused?'▷':'Ⅱ'}</span><span>${paused?'Resume motion':'Pause motion'}</span>`;host.dataset.cityPaused=String(paused);if(raf)cancelAnimationFrame(raf);raf=0;wake();}
    pause.addEventListener('click',()=>setPaused(!paused));
    function pointerMove(e){if(e.pointerType==='touch')return;const pt=graphic.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const q=pt.matrixTransform(graphic.getScreenCTM().inverse());pointer.x=q.x;pointer.y=q.y;pointer.active=true;wake();}
    function pointerLeave(){pointer.active=false;focus=null;wake();}
    stage.addEventListener('pointermove',pointerMove);stage.addEventListener('pointerleave',pointerLeave);
    graphic.addEventListener('click',()=>{if(!pointer.active)return;const near=[...districtState.values()].sort((a,b)=>Math.hypot(pointer.x-a.cx,pointer.y-a.cy)-Math.hypot(pointer.x-b.cx,pointer.y-b.cy))[0];if(Math.hypot(pointer.x-near.cx,pointer.y-near.cy)<220)select(near.id);});
    const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(!visible&&raf){cancelAnimationFrame(raf);raf=0;}else wake();},{rootMargin:'100px'});observer.observe(stage);
    const visibility=()=>{if(document.hidden&&raf){cancelAnimationFrame(raf);raf=0;}else wake();};document.addEventListener('visibilitychange',visibility);
    const preference=e=>setPaused(e.matches);reduced.addEventListener('change',preference);
    const api={pause:()=>setPaused(true),play:()=>setPaused(false),select,destroy(){dead=true;if(raf)cancelAnimationFrame(raf);observer.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',preference);host.replaceChildren();delete host._offpeakCity;},getState:()=>({paused,visible,time:clock,selected,districts:6,fanCount:fanActors.length,projection:"front",analytics:analyticsSummary.textContent})};host._offpeakCity=api;
    update(0,0);select('capacity');setPaused(paused);return api;
  }
  window.OffpeakCity={mount};
  function boot(){document.querySelectorAll('[data-city-host]').forEach(host=>mount(host).catch(error=>{host.dataset.cityReady='error';host.setAttribute('aria-busy','false');host.innerHTML='<img class="opcity-art" src="/assets/offpeak-city-live-poster.png" alt="OFFPEAK compute city">';console.error('OFFPEAK city:',error);}));}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
