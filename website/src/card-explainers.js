/* Full-card, illustrative OFFPEAK mechanisms. No data or asset requests. */
(() => {
  'use strict';
  let serial = 0;
  const definitions = {
    'scene-feature-0': {title:'Know the maximum.',kind:'quote',steps:['Read the rates','Set the ceiling','Accept the quote'],copy:'A proposed quote fixes the model, rates, and output ceiling. Accepted rates stay fixed for that request.'},
    'scene-feature-1': {title:'Pin the right model.',kind:'model',steps:['Check the model','Pin its revision','Validate the fit'],copy:'The planned serving profile identifies the exact model revision. Its quality and commercial serving rights must be validated first.'},
    'scene-feature-2': {title:'See what you can call.',kind:'discovery',steps:['Browse details','Check capability','Use the identifier'],copy:'Model discovery is meant to expose the revision and supported text capability before you prepare a request.'},
    'scene-feature-3': {title:'A real slot to work.',kind:'capacity',steps:['Fresh health','A free slot','Reserve on acceptance'],copy:'A low GPU reading is not enough. The proposed service accepts work only when an authorized worker has a slot it can reserve.'},
    'scene-feature-4': {title:'Count the completed work.',kind:'meter',steps:['Count input','Meter output','Release the rest'],copy:'The pilot design bills a complete, retrievable response within the authorized cap. Unused reservation returns to the available balance.'},
    'scene-feature-5': {title:'Keep the billing record.',kind:'receipt',steps:['Record usage','Sign the record','Check inclusion'],copy:'Planned receipts connect usage and billing. A signature and batch record do not prove the answer was correct.'},
    'scene-productivity-0': {title:'Read the available room.',kind:'insights',steps:['Check health','Inspect slots','Refresh capacity'],copy:'Capacity information is a recent view of eligible workers. It is not a reservation or a promise that a request will be accepted.'},
    'scene-productivity-1': {title:'Turn text into useful labels.',kind:'classify',steps:['Send descriptions','Run a suitable model','Review categories'],copy:'Illustrative workflow: classify product descriptions with an open model that passes your quality check. No live inference runs here.'},
    'scene-productivity-2': {title:'Authorize a clear limit.',kind:'authorize',steps:['Inspect the quote','Sign the boundary','Accept if available'],copy:'The proposed authorization binds your request and maximum charge. Acceptance still depends on funds and a real serving slot.'},
    'scene-productivity-3': {title:'Follow one request.',kind:'lifecycle',steps:['Quote and authorize','Run and reconcile','Charge and release'],copy:'The planned flow keeps each request tied to its cap, result, and final charge. Incomplete failed work is unbilled in the pilot design.'},
    'scene-productivity-4': {title:'Take the record with you.',kind:'export',steps:['Inspect the receipt','Export the fields','Reconcile the charge'],copy:'A receipt export makes the billing fields portable. The current demo record has no operator signature or on-chain proof.'}
  };
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const svgNS='http://www.w3.org/2000/svg';
  function drawing(kind,uid){
    const machined=['quote','model','discovery','capacity','meter','receipt'].includes(kind);
    const g=name=>`url(#${uid}-${name})`;
    const rect=(x,y,w,h,fill,rx=4,extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`;
    const text=(x,y,value,size=13,fill='#6d6d6d',anchor='start',extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" ${extra}>${esc(value)}</text>`;
    const path=(d,stroke='#6d6d6d',width=1.3,extra='')=>`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
    const screw=(x,y)=>`<circle cx="${x}" cy="${y}" r="3.8" fill="#b9b9b9" stroke="#757575" stroke-width=".8"/>${path(`M${x-1.6} ${y+1.4}l3.2-2.8`,'#626262',1)}`;
    const lamp=(x,y,active=true)=>`<circle cx="${x}" cy="${y}" r="5" fill="${active?'#ccff00':'#8c8c8c'}" stroke="#666666" stroke-width="1.2"/><circle cx="${x-1}" cy="${y-1}" r="1.3" fill="#fff" opacity=".55"/>`;
    const plate=(x,y,w,h,dark=false,r=10,fasten=true)=>{
      if(!machined||!fasten)return `${rect(x,y+5,w,h,dark?'#292929':'#b7b7b7',r)}${rect(x,y,w,h,g(dark?'metal':'white'),r,'stroke="'+(dark?'#5a5a5a':'#c8c8c8')+'" stroke-width="1.2"')}${rect(x+3,y+3,w-6,h-6,'none',Math.max(1,r-2),'stroke="'+(dark?'#adadad55':'#ffffff')+'" stroke-width=".8"')}${fasten?screw(x+9,y+10)+screw(x+w-9,y+h-10):''}`;
      const edge=dark?'#191919':'#9f9f9f',rim=dark?'#c3c3c3':'#fff';
      return `<g class="ce-machined-casing">${rect(x+.5,y+7,w-1,h,edge,r,'stroke="#484848" stroke-width=".7"')}${rect(x,y,w,h,g(dark?'bevel-metal':'bevel-white'),r,'stroke="'+(dark?'#767676':'#b2b2b2')+'" stroke-width="1.1"')}${path(`M${x+r} ${y+1.5}H${x+w-r}Q${x+w-1.5} ${y+1.5} ${x+w-1.5} ${y+r}V${y+h-r}`,rim,1.4)}${path(`M${x+1.5} ${y+r}V${y+h-r}Q${x+1.5} ${y+h-1.5} ${x+r} ${y+h-1.5}H${x+w-r}`,dark?'#1b1b1b':'#909090',1.7)}${rect(x+5,y+5,w-10,h-10,'none',Math.max(2,r-3),'stroke="'+(dark?'#11111199':'#d1d1d1')+'" stroke-width="1"')}${path(`M${x+r} ${y+h+3.5}H${x+w-r}`,dark?'#646464':'#e2e2e2',.75)}${screw(x+10,y+11)}${screw(x+w-10,y+h-11)}</g>`;
    };
    const vent=(x,y,w,count=8)=>Array.from({length:count},(_,i)=>rect(x,y+i*5,w,2,g('vent'),1)).join('');
    const channel=(d,delay=0)=>`${path(d,'#c4c4c4',7)}${path(d,'#f1f1f1',4.5)}${path(d,'#6d6d6d',1.7)}${path(d,'#ccff00',2.5,`class="ce-packet" style="--delay:${delay}s"`)}`;
    const rails=(x,y,w)=>`${rect(x,y,w,4,g('rail'),2)}${rect(x,y+29,w,4,g('rail'),2)}`;
    const paper=(x,y,w,h,label='REQUEST')=>`${plate(x,y,w,h,false,3,false)}${path(`M${x+w-18} ${y}v18h18`,'#c8c8c8',1)}${text(x+13,y+24,label,12,'#505050')}${Array.from({length:4},(_,i)=>path(`M${x+13} ${y+39+i*12}h${w-29-(i%2)*16}`,'#bfbfbf',2)).join('')}`;
    const ring=(x,y,r)=>`<circle cx="${x}" cy="${y+3}" r="${r}" fill="#acacac"/><circle cx="${x}" cy="${y}" r="${r}" fill="${g('ring')}" stroke="#6c6c6c" stroke-width="1.2"/><circle cx="${x}" cy="${y}" r="${r-6}" fill="#343434" stroke="#8c8c8c" stroke-width="1"/>`;
    const fan=(x,y,r=34,reverse=false)=>`${ring(x,y,r)}<g transform="translate(${x} ${y})"><g class="ce-fan${reverse?' ce-reverse':''}">${Array.from({length:7},(_,i)=>`<path d="M0-4C${r*.65}-${r*.65} ${r*.82}-${r*.1} ${r*.55} ${r*.24}L5 5Z" fill="${g('blade')}" stroke="#a5a5a5" stroke-width=".65" transform="rotate(${i*360/7})"/>`).join('')}</g><circle r="6" fill="#717171" stroke="#d6d6d6" stroke-width="1"/><circle r="2" fill="#ccff00"/></g>`;
    const chip=(x,y,w=104,h=85,label='MODEL')=>`${Array.from({length:7},(_,i)=>rect(x-8,y+12+i*9,8,3,g('rail'),1)+rect(x+w,y+12+i*9,8,3,g('rail'),1)).join('')}${plate(x,y,w,h,true,7)}${rect(x+16,y+15,w-32,h-31,'#252525',4,'stroke="#6c6c6c"')}${text(x+w/2,y+h/2+4,label,14,'#ccff00','middle')} ${path(`M${x+24} ${y+h-22}h${w-48}`,'#5d5d5d',1.3)}`;
    const check=(x,y,scale=1)=>`<g transform="translate(${x} ${y}) scale(${scale})">${path('m-10 0 7 7 15-17','#ccff00',4)}</g>`;
    const bracket=(x,y,w,h)=>path(`M${x+13} ${y}h-13v13M${x+w-13} ${y}h13v13M${x} ${y+h-13}v13h13M${x+w-13} ${y+h}h13v-13`,'#9a9a9a',1.2);
    const gear=(x,y,r=22)=>`<g transform="translate(${x} ${y})"><g class="ce-gear">${Array.from({length:12},(_,i)=>rect(-3,-r-5,6,12,'#a3a3a3',2,`transform="rotate(${i*30})"`)).join('')}<circle r="${r}" fill="${g('white')}" stroke="#8c8c8c"/><circle r="${r-8}" fill="#3f3f3f" stroke="#adadad"/></g><circle r="5" fill="#d0d0d0"/></g>`;
    const boltLine=(x,y,w)=>Array.from({length:Math.floor(w/24)},(_,i)=>screw(x+i*24,y)).join('');
    let content='';
    if(kind==='quote'){
      content=channel('M75 177H135',-.4)+channel('M407 181H510',-1.2)+rails(92,150,420);
      content+=plate(145,51,261,244,true,14)+plate(164,64,223,213,false,6,false);
      content+=text(179,91,'REQUEST QUOTE',14,'#404040')+rect(307,79,61,19,'#e9e9e9',3)+text(337,92,'FIXED',10,'#6a6a6a','middle');
      content+=path('M179 105H370','#d0d0d0',1)+text(179,131,'INPUT RATE',12)+text(179,160,'OUTPUT LIMIT',12)+rect(310,117,58,16,'#d4d4d4',3)+rect(310,146,58,16,'#d4d4d4',3);
      content+=rect(176,180,200,48,'#343434',5)+text(190,198,'MAXIMUM CHARGE',10,'#c6c6c6')+path('M191 215H349','#ccff00',5);
      content+=rect(176,239,200,18,'#f1f1f1',3)+path('M190 248H302','#a5a5a5',2)+lamp(354,248);
      content+=plate(54,134,71,75,false,8)+text(89,176,'IN',17,'#5f5f5f','middle')+plate(467,144,70,72,true,8)+check(502,180,1.1);
      content+=`<g class="ce-scan-x">${rect(163,109,3,157,'#b5b5b5',1,'opacity=".55"')}</g>`+text(275,329,'BOUND THE REQUEST',13,'#747474','middle');
    }else if(kind==='model'){
      content=plate(107,67,388,226,true,15)+vent(120,91,22,30)+vent(460,91,22,30)+plate(155,86,289,184,false,6);
      // One integral front-face module: no paper stack or offset profile cards.
      content+=rect(176,113,246,126,'#e3e3e3',7,'stroke="#afafaf" stroke-width="1"')+path('M187 124H411M187 229H411','#fbfbfb',1);
      content+=chip(187,132,112,88,'MODEL')+text(319,141,'REVISION',11,'#565656')+rect(318,151,84,25,'#282828',4)+text(360,168,'PINNED',12,'#ccff00','middle');
      content+=text(319,196,'TEXT',12,'#606060')+path('M318 207H399M318 215H375','#a9a9a9',2)+text(299,255,'VALIDATE BEFORE SERVING',10,'#656565','middle');
      content+=channel('M64 194H106',-.8)+channel('M495 194H546',-1.6)+bracket(144,75,311,208);
      content+=plate(54,170,46,48,false,7)+path('M65 181h24M65 190h15M65 199h21','#9d9d9d',2);
      content+=`<g class="ce-latch">${plate(273,77,79,21,true,4,false)}${rect(292,83,40,8,'#ccff00',2)}</g>`;
      content+=lamp(477,278)+text(303,326,'ONE KNOWN MODEL VERSION',13,'#747474','middle');
    }else if(kind==='discovery'){
      content=plate(54,80,154,214,true,12)+text(76,105,'MODEL CATALOG',12,'#ccff00');
      content+=Array.from({length:3},(_,i)=>`${rect(70,126+i*45,121,34,i===1?'#6e6e6e':'#3f3f3f',5,'stroke="#7b7b7b"')}${rect(80,135+i*45,17,17,i===1?'#ccff00':'#8d8d8d',3)}${path(`M107 ${141+i*45}h66M107 ${149+i*45}h41`,i===1?'#e6e6e6':'#9a9a9a',2)}`).join('');
      content+=channel('M207 187H247V141H290',-.7)+paper(290,64,222,231,'MODEL DETAILS');
      content+=text(307,198,'TEXT',12,'#575757')+text(307,225,'REVISION',12,'#575757')+text(307,252,'IDENTIFIER',12,'#575757')+rect(393,185,95,19,'#e5e5e5',3)+rect(393,213,95,19,'#e5e5e5',3)+rect(393,241,95,19,'#e5e5e5',3);
      content+=`<g class="ce-inspect">${ring(283,168,42)}<circle cx="283" cy="168" r="31" fill="#ccff001c"/>${path('M310 198l29 33','#717171',15)}${path('M311 198l29 33','#c1c1c1',8)}${path('M269 168h28M283 154v28','#ccff00',2)}</g>`;
    }else if(kind==='capacity'){
      content=plate(63,74,242,210,true,14)+fan(125,137,37)+fan(238,137,37,true)+vent(86,207,66,9)+vent(201,207,66,9);
      content+=channel('M305 180H349',-.8)+plate(354,64,187,232,false,13);
      content+=text(371,91,'SERVING SLOTS',13,'#575757')+Array.from({length:4},(_,i)=>`${plate(371,109+i*41,151,31,i!==2,5,false)}${lamp(386,124+i*41,i===2)}${text(408,129+i*41,i===2?'FREE SLOT':'OCCUPIED',11,i===2?'#666666':'#bcbcbc')}`).join('');
      content+=`<g class="ce-gate">${rect(339,168,16,47,g('rail'),3)}${rect(343,171,8,16,'#ccff00',2)}</g>`+path('M125 185H238','#7b7b7b',1)+lamp(181,185);
      content+=text(299,325,'ACCEPT ONLY WITH ROOM TO SERVE',13,'#747474','middle');
    }else if(kind==='meter'){
      content=channel('M62 109H225V150',-.1)+channel('M62 251H225V212',-.9)+channel('M375 178H534',-1.7)+channel('M420 178V276H480',-2.2);
      content+=plate(54,78,134,64,false,7)+text(120,114,'INPUT',16,'#696969','middle')+plate(54,219,134,64,false,7)+text(120,256,'OUTPUT',16,'#696969','middle');
      content+=plate(230,83,149,197,true,12)+ring(304,157,54)+`<g transform="translate(304 157)"><g class="ce-meter-arm">${path('M0 4V-36','#ccff00',4)}</g><circle r="6" fill="#dedede"/></g>`;
      content+=Array.from({length:9},(_,i)=>path(`M${304+Math.cos((-150+i*37.5)*Math.PI/180)*43} ${157+Math.sin((-150+i*37.5)*Math.PI/180)*43}l${Math.cos((-150+i*37.5)*Math.PI/180)*5} ${Math.sin((-150+i*37.5)*Math.PI/180)*5}`,'#afafaf',1.2)).join('');
      content+=rect(252,229,104,24,'#292929',4)+text(304,246,'MEASURED',11,'#ccff00','middle')+plate(463,140,82,61,true,8)+check(504,171,1)+plate(453,252,93,46,false,6)+text(499,280,'RELEASE',11,'#676767','middle');
      content+=text(303,325,'USAGE WITHIN YOUR CAP',13,'#747474','middle');
    }else if(kind==='receipt'){
      content=plate(109,64,367,209,true,15)+vent(129,82,91,7)+lamp(449,92)+rect(162,113,260,17,'#1d1d1d',5,'stroke="#737373"');
      content+=`<g class="ce-paper-feed">${paper(196,100,184,186,'USAGE RECEIPT')}${path('M214 208h92M214 220h148','#bababa',2)}${path('M215 250q13-21 21-4t13-6 10 4 20-10 12 5 18-3','#707070',2.2,'class="ce-signature"')}${text(287,273,'BILLING RECORD',10,'#767676','middle')}</g>`;
      content+=rect(142,119,292,12,g('rail'),4)+rect(150,122,276,3,'#e8e8e8',1)+gear(140,216,19)+gear(446,216,19);
      content+=plate(430,271,62,42,true,6)+check(461,291,.7)+channel('M379 301H430',-.5)+text(285,327,'SIGNED RECORD. CLEAR SCOPE.',13,'#747474','middle');
    }else if(kind==='insights'){
      content=plate(181,70,232,235,true,15)+ring(297,179,82);
      content+=`<g opacity=".7">${[25,46,66].map(r=>`<circle cx="297" cy="179" r="${r}" fill="none" stroke="#7b7b7b" stroke-width="1"/>`).join('')}${path('M219 179H375M297 101V257','#7b7b7b',1)}</g>`;
      content+=`<g transform="translate(297 179)"><g class="ce-radar"><path d="M0 0 68-36A77 77 0 0 1 77 0Z" fill="${g('radar')}"/>${path('M0 0H77','#ccff00',1.4)}</g></g>`;
      content+=[[265,152],[321,130],[334,211],[265,226]].map(([x,y])=>lamp(x,y)).join('');
      content+=channel('M84 105H161V147H219',-.4)+channel('M381 147H454V105H512',-1.3)+channel('M84 258H155V211H220',-.9)+channel('M378 211H454V258H513',-2);
      content+=[[42,75,'A'],[470,75,'B'],[42,229,'C'],[470,229,'D']].map(([x,y,l],i)=>`${plate(x,y,82,67,false,8)}${text(x+16,y+26,l,15,'#6e6e6e')}${vent(x+17,y+39,39,3)}${lamp(x+62,y+24,i!==2)}`).join('');
      content+=text(297,288,'RECENT VIEW',11,'#cacaca','middle');
    }else if(kind==='classify'){
      content=rails(36,155,522)+channel('M52 172H540',-.5)+paper(47,80,88,90,'TEXT')+paper(59,93,88,90,'TEXT');
      content+=plate(182,72,221,223,true,13)+chip(240,109,104,83,'TEXT')+rect(206,217,176,33,'#282828',4)+text(294,238,'CLASSIFY',15,'#ccff00','middle');
      content+=`<g class="ce-token-slide">${rect(164,160,19,19,'#ccff00',4,'stroke="#828282"')}</g>`;
      content+=[[445,61,'KITCHEN'],[445,145,'OUTDOORS'],[445,229,'ELECTRONICS']].map(([x,y,l],i)=>`${plate(x,y,117,66,false,6)}${rect(x+10,y+13,21,21,'#404040',4)}${check(x+20,y+24,.45)}${text(x+12,y+51,l,11,'#6d6d6d')}`).join('');
      content+=channel('M403 172H427V94H445',-.3)+channel('M427 172H445',-.9)+channel('M427 172V262H445',-1.5);
      content+=text(294,321,'ILLUSTRATIVE PRODUCT SORTING',12,'#747474','middle');
    }else if(kind==='authorize'){
      content=plate(62,90,191,175,true,14)+plate(81,105,152,130,false,7)+rect(184,148,81,59,g('metal'),7,'stroke="#898989"')+ring(214,178,13)+text(155,139,'WALLET',14,'#6a6a6a','middle')+path('M99 192h59M99 206h43','#b2b2b2',3);
      content+=channel('M266 179H359',-.6)+plate(362,64,170,226,false,12)+text(447,94,'SPEND LIMIT',13,'#5e5e5e','middle')+rect(384,111,126,58,'#2d2d2d',6)+path('M400 140H493','#ccff00',6);
      content+=`<g class="ce-lock-shackle">${path('M411 209v-20a35 35 0 0 1 70 0v20','#9a9a9a',13)}${path('M411 209v-20a35 35 0 0 1 70 0v20','#e2e2e2',6)}</g>`+plate(397,207,98,60,true,8)+ring(446,236,13)+path('M446 237v8','#ccff00',4);
      content+=text(296,320,'YOUR REQUEST. YOUR BOUNDARY.',13,'#747474','middle')+`<g class="ce-key-signal">${check(311,180,.9)}</g>`;
    }else if(kind==='lifecycle'){
      content=channel('M120 114H473V266H120V114',-.6);
      content+=paper(65,55,109,112,'QUOTE')+plate(424,60,117,108,true,9)+chip(442,77,80,69,'RUN');
      content+=plate(65,220,113,88,true,8)+text(121,252,'RELEASE',12,'#cecece','middle')+path('M87 276h61m-9-7 9 7-9 7','#ccff00',3);
      content+=plate(424,220,117,87,false,8)+text(483,251,'RECORD',12,'#6e6e6e','middle')+path('M442 268h80M442 278h49','#9d9d9d',2);
      content+=plate(223,121,157,111,true,13)+text(301,149,'REQUEST',12,'#c9c9c9','middle')+rect(244,162,115,44,'#212121',5)+text(301,190,'ONE ID',17,'#ccff00','middle');
      content+=channel('M174 114H222V159',-1)+channel('M380 177H425',-2);
      content+=`<g class="ce-lifecycle-packet">${rect(221,106,16,16,'#ccff00',4,'stroke="#868686"')}</g>`+lamp(484,194)+lamp(121,194);
    }else if(kind==='export'){
      content=paper(68,64,164,219,'RECEIPT')+path('M84 164h117M84 177h98M84 205h77M84 220h102','#b9b9b9',2);
      content+=channel('M233 175H306',-.4)+plate(315,67,235,215,true,14)+rect(337,89,191,145,'#202020',7,'stroke="#787878"');
      content+=text(356,117,'{',25,'#ccff00')+text(509,217,'}',25,'#ccff00','end')+text(374,143,'request_id',12,'#cfcfcf')+text(374,170,'usage',12,'#cfcfcf')+text(374,197,'charge',12,'#cfcfcf')+path('M461 140h42M437 167h66M447 194h56','#878787',3);
      content+=vent(347,250,107,3)+lamp(507,256)+`<g class="ce-export-arrow">${path('M274 138v67m-16-16 16 16 16-16','#8e8e8e',5)}</g>`;
      content+=text(152,316,'BILLING RECORD',12,'#747474','middle')+text(431,316,'PORTABLE FIELDS',12,'#747474','middle');
    }
    if(machined){
      const construction=`<g class="ce-feature-wireframe" opacity=".22" fill="none" stroke="#939393" stroke-width=".75">${Array.from({length:12},(_,i)=>path(`M${36+i*48} 36V303`,'#aaaaaa',.5)).join('')}${Array.from({length:7},(_,i)=>path(`M30 ${39+i*43}H570`,'#aaaaaa',.5)).join('')}${bracket(29,34,542,271)}${path('M24 176h20M34 166v20M557 176h20M567 166v20M291 28h18M300 19v18M291 309h18M300 302v18','#868686',.9)}</g>`;
      content=construction+content;
    }
    return `<svg class="ce-machine" viewBox="0 0 600 350" aria-hidden="true" focusable="false"><defs>${machined?`<linearGradient id="${uid}-bevel-metal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#a8a8a8"/><stop offset=".027" stop-color="#6d6d6d"/><stop offset=".08" stop-color="#4b4b4b"/><stop offset=".7" stop-color="#373737"/><stop offset=".97" stop-color="#454545"/><stop offset="1" stop-color="#787878"/></linearGradient><linearGradient id="${uid}-bevel-white" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff"/><stop offset=".035" stop-color="#fafafa"/><stop offset=".08" stop-color="#e9e9e9"/><stop offset=".82" stop-color="#dfdfdf"/><stop offset=".97" stop-color="#f1f1f1"/><stop offset="1" stop-color="#c3c3c3"/></linearGradient>`:''}<linearGradient id="${uid}-white" x2="0" y2="1"><stop stop-color="#fcfcfc"/><stop offset="1" stop-color="#e6e6e6"/></linearGradient><linearGradient id="${uid}-metal" x2="0" y2="1"><stop stop-color="#6c6c6c"/><stop offset=".05" stop-color="#4f4f4f"/><stop offset=".55" stop-color="#3c3c3c"/><stop offset="1" stop-color="#303030"/></linearGradient><linearGradient id="${uid}-rail" x2="0" y2="1"><stop stop-color="#ededed"/><stop offset=".4" stop-color="#a5a5a5"/><stop offset=".6" stop-color="#ebebeb"/><stop offset="1" stop-color="#828282"/></linearGradient><linearGradient id="${uid}-ring" x2="1" y2="1"><stop stop-color="#e8e8e8"/><stop offset=".5" stop-color="#979797"/><stop offset="1" stop-color="#bebebe"/></linearGradient><linearGradient id="${uid}-blade" x2="1" y2="1"><stop stop-color="#bfbfbf"/><stop offset="1" stop-color="#727272"/></linearGradient><linearGradient id="${uid}-vent" x2="0" y2="1"><stop stop-color="#1f1f1f"/><stop offset="1" stop-color="#8d8d8d"/></linearGradient><radialGradient id="${uid}-radar"><stop stop-color="#ccff0000"/><stop offset="1" stop-color="#ccff0055"/></radialGradient></defs><g class="ce-machine-geometry">${content}</g></svg>`;
  }
  function create(sceneId){
    const definition=definitions[sceneId];if(!definition)return null;
    const uid=`offpeak-explainer-${++serial}`;
    const root=document.createElement('section');root.className='offpeak-card-explainer';root.dataset.explainer=definition.kind;root.dataset.sceneId=sceneId;root.dataset.active='false';root.dataset.running='false';
    root.setAttribute('aria-labelledby',`${uid}-title`);
    root.innerHTML=`<header class="ce-heading"><span class="ce-kicker"><i aria-hidden="true"></i>${definition.kind==='classify'?'ILLUSTRATIVE WORKFLOW':'PLANNED PRODUCT FLOW'}</span><h3 id="${uid}-title">${esc(definition.title)}</h3></header><div class="ce-visual">${drawing(definition.kind,uid)}</div><div class="ce-description"><ol class="ce-steps">${definition.steps.map((step,i)=>`<li><span aria-hidden="true">${String(i+1).padStart(2,'0')}</span>${esc(step)}</li>`).join('')}</ol><p>${esc(definition.copy)}</p></div>`;
    const reduced=matchMedia('(prefers-reduced-motion:reduce)');let active=false,visible=false,destroyed=false;
    const sync=()=>{root.dataset.running=String(active&&visible&&!document.hidden&&!reduced.matches);root.dataset.reduced=String(reduced.matches);};
    const intersection=new IntersectionObserver(entries=>{visible=entries[entries.length-1].isIntersecting;sync();},{threshold:.01});intersection.observe(root);
    const resize=new ResizeObserver(entries=>{const box=entries[entries.length-1].contentRect;root.dataset.wide=String(box.width/Math.max(1,box.height)>1.28);root.dataset.small=String(box.height<350);});resize.observe(root);
    root.setActive=value=>{if(destroyed)return;active=Boolean(value);root.dataset.active=String(active);sync();};
    root.destroy=()=>{if(destroyed)return;destroyed=true;active=false;sync();intersection.disconnect();resize.disconnect();document.removeEventListener('visibilitychange',sync);reduced.removeEventListener('change',sync);};
    document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',sync);sync();
    return root;
  }
  window.OffpeakCardExplainers={create,sceneIds:Object.keys(definitions)};
})();
