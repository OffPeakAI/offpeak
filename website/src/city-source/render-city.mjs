import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import crypto from 'node:crypto';
const require=createRequire(import.meta.url);
let sharp;sharp=require('sharp')
const ROOT=path.dirname(fileURLToPath(import.meta.url)),OUT=path.resolve(ROOT,'../assets'),WORK=path.join(ROOT,'render-work');
const FFMPEG=process.env.OFFPEAK_FFMPEG||'ffmpeg';
const LIVE=process.argv.includes('--live');
const W=1600,H=LIVE?700:900,FPS=24,DURATION=20,TAU=Math.PI*2;
const camera=LIVE?{x:2.25,yx:-.2,yy:.9,z:1.35,ox:800,oy:435}:{x:.95,yx:-.95,yy:.475,z:1,ox:800,oy:506};
const C={paper:'#F6F6F2',top:'#F5F6F0',front:'#E1E4DC',side:'#BAC2B8',edge:'#7D887E',ink:'#3D4840',glass:'#A4B1A6',dark:'#35433A',lime:'#C4D99A',active:'#D0ECA0',road:'#C9CDC6',line:'#879487'};
const round=x=>Math.round(x*100)/100,p=(x,y,z=0)=>[round(camera.ox+x*camera.x+y*camera.yx),round(camera.oy+(LIVE?0:x*.475)+y*camera.yy-z*camera.z)];
const P=arr=>arr.map(v=>v.join(',')).join(' '),poly=(pts,fill,stroke='none',sw=.7,extra='')=>`<polygon points="${P(pts)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" ${extra}/>`;
const line=(pts,color=C.edge,width=1,extra='')=>`<polyline points="${P(pts)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const pathsvg=(d,stroke,width=1,fill='none',extra='')=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const rect=(x,y,w,h,fill,r=0,stroke='none',sw=1,extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
const ellipse=(x,y,rx,ry,fill,extra='')=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
const circle=(x,y,r,fill,extra='')=>ellipse(x,y,r,r,fill,extra);
const top=(x,y,z,w,d,fill,stroke='none')=>poly([p(x,y,z),p(x+w,y,z),p(x+w,y+d,z),p(x,y+d,z)],fill,stroke);
const plane=(x,y,z,content)=>{const a=p(x,y,z);return `<g transform="matrix(${camera.x} ${LIVE?0:.475} 0 ${camera.z} ${a[0]} ${a[1]})">${content}</g>`};
const roof=(x,y,z,content)=>{const a=p(x,y,z);return `<g transform="matrix(${camera.x} ${LIVE?0:.475} ${camera.yx} ${camera.yy} ${a[0]} ${a[1]})">${content}</g>`};
const rightPlane=(x,y,z,content)=>{const a=p(x,y,z);return `<g transform="matrix(${camera.yx} ${camera.yy} 0 ${camera.z} ${a[0]} ${a[1]})">${content}</g>`};
const label=(x,y,z,s,size=5,color='#849387')=>plane(x,y,z,`<text x="0" y="0" font-family="Consolas,monospace" font-size="${size}" fill="${color}" letter-spacing=".9">${s}</text>`);
function box(x,y,z,w,d,h,colors={}){
 return poly([p(x,y+d,z),p(x+w,y+d,z),p(x+w,y+d,z+h),p(x,y+d,z+h)],colors.front||'url(#front)',colors.edge||C.edge,.6)
 +poly([p(x+w,y,z),p(x+w,y+d,z),p(x+w,y+d,z+h),p(x+w,y,z+h)],colors.side||'url(#side)',colors.edge||C.edge,.6)
 +top(x,y,z+h,w,d,colors.top||'url(#roof)',colors.edge||C.edge);
}
function shadow(x,y,w,d,h){return poly([p(x,y,0),p(x+w,y,0),p(x+w+h*.38,y+d+h*.24,0),p(x+h*.38,y+d+h*.24,0)],'#334039','none',0,'opacity=".14" filter="url(#soft-shadow)"');}
function pipe(points,r=3,color='#CBD6CA'){const q=points.map(v=>p(...v));return line(q,'#7E9181',r*2+1.5)+line(q,color,r*2)+line(q.map(([x,y])=>[x-.7,y-.8]),'#ECF0E7',Math.max(1,r*.55),'opacity=".65"');}
function rail(x,y,z,w,d){let s='';for(let k=0;k<=w;k+=12)s+=line([p(x+k,y,z),p(x+k,y,z+8)],'#8A9A8D',.7);for(let k=0;k<=d;k+=12)s+=line([p(x+w,y+k,z),p(x+w,y+k,z+8)],'#8A9A8D',.7);return s+line([p(x,y,z+8),p(x+w,y,z+8),p(x+w,y+d,z+8)],'#96A594',1.2);}
function vents(x,y,z,w,d,count=8){let s=box(x,y,z,w,d,3,{top:'#B6C2B4',front:'#A0AFA2',side:'#879B8B'});for(let i=2;i<d-1;i+=d/count)s+=line([p(x+1,y+i,z+3.3),p(x+w-1,y+i,z+3.3)],'#566C5C',1.2);return s;}
function cylinder(x,y,z,r,h,color='#CCD6CA'){
 const [cx,cy]=p(x,y,z),rx=r*(LIVE?2.259:1.344),ry=r*(LIVE?.9:.672),height=h*camera.z;
 return `<path d="M${cx-rx} ${cy-height}V${cy}A${rx} ${ry} 0 0 0 ${cx+rx} ${cy}V${cy-height}Z" fill="url(#cylinder)" stroke="#8E9F90" stroke-width=".7"/>`+ellipse(cx,cy-height,rx,ry,color,'stroke="#93A28F" stroke-width=".7"')+ellipse(cx,cy-height-1,rx*.75,ry*.75,'#E3EADB','opacity=".7"');
}
const fans=[],leds=[],screens=[];
function fan(x,y,z,r=12){fans.push({x,y,z:z+.7,r,phase:fans.length*.41});return cylinder(x,y,z-4,r+3,4,'#B6C4B3')+roof(x,y,z,circle(0,0,r,'#33483B')+circle(0,0,r-2,'#4D6253')+circle(0,0,r+1,'none','stroke="#DEE7D8" stroke-width="1"'));}
function led(x,y,z,w=4){leds.push({x,y,z,w,phase:leds.length*.61});return plane(x,y,z,rect(0,0,w,2.3,'#94AA7D',.4));}
function windows(x,y,z,w,h,cols=6,rows=4){let s='';const ww=(w-8)/cols,hh=(h-8)/rows;for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)s+=plane(x+4+c*ww,y,z-4-r*hh,rect(0,0,ww-2,hh-3,(r+c)%4===0?'#92AA96':'#687E70',.2)+rect(1,1,ww-4,1,'#C1D1BF',0,'none',0,'opacity=".5"'));return s;}
function tree(x,y,s=1){const [cx,cy]=p(x,y,3);return ellipse(cx+3,cy+2,9*s,4*s,'#809679','opacity=".11"')+line([p(x,y,2),p(x,y,15*s)],'#9AAA8D',2*s)+ellipse(cx,cy-16*s,8*s,10*s,'#B5C5A5')+ellipse(cx-3*s,cy-20*s,6*s,7*s,'#C7D3B7')+ellipse(cx+4*s,cy-15*s,4*s,6*s,'#A7BC96');}
function lamp(x,y,h=30){return line([p(x,y,0),p(x,y,h),p(x+7,y,h)],'#829786',1.2)+box(x+4,y-2,h-1,9,4,2,{top:'#F5F5DF',front:'#C9D4B8',side:'#9CAC94'});}
function crate(x,y,z=0,w=7){let s=box(x,y,z,w,w,w*.8,{top:'#E9EFDD',front:'#BACCA9',side:'#9EB48F'});s+=line([p(x+w*.5,y,z+w*.8),p(x+w*.5,y+w,z+w*.8),p(x+w*.5,y+w,z)],'#8CA17B',.6);return s;}
const defs=`<defs><linearGradient id="roof" x1="0" y1="0" x2=".5" y2="1"><stop stop-color="#FFFFFA"/><stop offset="1" stop-color="#ECEEE7"/></linearGradient><linearGradient id="front" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#EBEDE6"/><stop offset="1" stop-color="#C9D0C5"/></linearGradient><linearGradient id="side" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#C6CCC2"/><stop offset="1" stop-color="#AAB6A9"/></linearGradient><linearGradient id="cylinder" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#BAC2B4"/><stop offset=".3" stop-color="#F8F9F0"/><stop offset=".6" stop-color="#D6DCCD"/><stop offset="1" stop-color="#9CAC94"/></linearGradient><linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#D2DBD0" stop-opacity=".75"/><stop offset=".5" stop-color="#A5B8AA" stop-opacity=".70"/><stop offset="1" stop-color="#799783" stop-opacity=".90"/></linearGradient><radialGradient id="ground"><stop stop-color="#FAFBF7"/><stop offset="1" stop-color="#EEF0E9"/></radialGradient><filter id="soft-shadow" x="-30%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter><filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2"/></filter></defs>`;
const materialDefs=`<defs><filter id="neutral-architecture" x="-10%" y="-10%" width="120%" height="120%"><feColorMatrix type="saturate" values=".16"/><feComponentTransfer><feFuncR type="linear" slope="1.065" intercept="-.055"/><feFuncG type="linear" slope="1.065" intercept="-.055"/><feFuncB type="linear" slope="1.065" intercept="-.055"/></feComponentTransfer></filter><filter id="neutral-ground"><feColorMatrix type="saturate" values=".32"/></filter></defs>`;
const svg=content=>`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${materialDefs}${content}</svg>`;

function ground(live=false){
 let s=live?'':rect(0,0,W,H,'url(#ground)');
 if(!live){s+=ellipse(804,630,630,194,'#677F68','opacity=".075" filter="url(#soft-shadow)"');
 s+=box(-370,-300,-19,740,570,19,{top:'#E8ECE1',front:'#D8DFCF',side:'#C4CFBD',edge:'#C9D0C1'});
 s+=top(-358,-288,1,716,546,'#F0F2E9');}
 // Perimeter light-rail boulevard and two transverse service streets.
 for(const [x,y,w,d]of [[-344,-269,682,28],[-344,214,682,28],[-344,-241,28,455],[310,-241,28,455],[-316,-32,626,38],[-119,-241,29,455],[96,-241,29,455]]){
  s+=top(x-4,y-4,1,w+8,d+8,'#FAFBF4')+top(x,y,1.1,w,d,'#C4CDC0');
  if(w>d){s+=line([p(x,y+d/2,1.5),p(x+w,y+d/2,1.5)],'#F0F5E9',1,'stroke-dasharray="7 10"');}
  else s+=line([p(x+w/2,y,1.5),p(x+w/2,y+d,1.5)],'#F0F5E9',1,'stroke-dasharray="7 10"');
 }
 // Continuous twin rail in the outer lane.
 for(const inset of [0,5])s+=line([p(-334+inset,-258+inset,1.6),p(322-inset,-258+inset,1.6),p(322-inset,228-inset,1.6),p(-334+inset,228-inset,1.6),p(-334+inset,-258+inset,1.6)],'#748C78',.7);
 for(const x of [-113,102])for(const y of [-37,5])for(let k=0;k<6;k++)s+=top(x-2+k*4,y,1.8,2.2,11,'#E5EDDF');
 // Lots, fine expansion joints, lawns and charging islands.
 for(const x of [-306,-86,134])for(const y of [-227,35]){
  s+=box(x-5,y-5,1,170,161,3,{top:'#F7F8F1',front:'#D8DFCF',side:'#CBD5C2',edge:'#D1D9C9'});
  for(let k=1;k<7;k++)s+=line([p(x+k*22,y,4.3),p(x+k*22,y+150,4.3)],'#E4EADC',.45);
  for(let k=1;k<6;k++)s+=line([p(x,y+k*25,4.3),p(x+160,y+k*25,4.3)],'#E4EADC',.45);
 }
 for(const [x,y,w,d]of [[-290,-280,128,12],[-290,196,116,13],[135,197,100,12],[-305,7,122,11],[146,6,111,11]]){
  s+=top(x,y,3,w,d,'#D3DFBC');for(let i=5;i<w;i+=14)s+=tree(x+i,y+d/2,.6);
 }
 for(let i=0;i<8;i++){s+=lamp(-303+i*84,-274,24);s+=lamp(-303+i*84,244,24);}
 for(let i=0;i<5;i++){s+=lamp(-347,-207+i*92,24);s+=lamp(344,-208+i*92,24);}
 // Service access grates and utility routes read even at a distance.
 for(const [x,y]of [[-304,-45],[-84,-45],[135,-45],[-304,200],[-84,200],[135,200]]){
  s+=top(x,y,2,22,7,'#99AA94');for(let i=1;i<20;i+=3)s+=line([p(x+i,y+1,2.1),p(x+i,y+6,2.1)],'#D3DECA',.65);
 }
 // Border bolts and low service markers keep the scale of the miniature tangible.
 if(!live)for(let x=-346;x<345;x+=45){s+=cylinder(x,-283,1,1.2,1.2,'#C7D0BE');s+=cylinder(x,253,1,1.2,1.2,'#C7D0BE');}
 return s;
}

function capacityDistrict(){
 let s=shadow(-302,-219,151,128,144)+box(-301,-217,4,151,125,9,{top:'#DAE4D4'});
 // Three increasingly tall rack towers, each with multiple fine-grained modules.
 for(const [x,y,w,d,h]of [[-298,-214,40,68,103],[-250,-211,42,72,140],[-201,-208,42,76,118]]){
  s+=box(x,y,13,w,d,h)+box(x-1,y-1,h+13,w+2,d+2,4,{top:'#F1F5E9'});
  s+=windows(x,y+d,13+h,w,h-12,3,8);
  for(let k=0;k<7;k++){s+=rightPlane(x+w,y+5,13+h-10-k*14,rect(0,0,d-10,9,'#9FAF9D',1)+rect(2,2,d-14,1.2,'#6C846D'));s+=led(x+5,y+d,13+h-12-k*14,2.6);}
  s+=fan(x+w/2,y+20,20+h,10)+fan(x+w/2,y+48,20+h,10)+rail(x,y,h+18,w,d);
  for(let k=4;k<d-4;k+=8)s+=line([p(x+w,y+k,h+13),p(x+w,y+k,13)],'#D5E0CE',.5);
 }
 s+=cylinder(-284,-111,13,13,49)+cylinder(-250,-108,13,13,49);
 s+=pipe([[-284,-111,63],[-284,-94,63],[-214,-94,63],[-214,-118,40]],3);
 s+=pipe([[-250,-108,27],[-250,-83,27],[-170,-83,27],[-170,-108,39]],2.6);
 s+=box(-195,-120,13,40,25,23)+vents(-191,-117,36,30,17,8)+label(-189,-95,31,'CAPACITY',4.5);
 s+=crate(-302,-87,4,9)+crate(-288,-85,4,9)+crate(-274,-86,4,9);
 // Tower maintenance ladders, outlet trays and a delicate rooftop aerial.
 for(let k=0;k<11;k++)s+=line([p(-158,-187,20+k*10),p(-158,-179,20+k*10)],'#72856D',.6);
 s+=line([p(-158,-187,18),p(-158,-187,128)],'#C2CFB6',.8)+line([p(-158,-179,18),p(-158,-179,128)],'#C2CFB6',.8);
 s+=line([p(-245,-203,158),p(-245,-203,182)],'#8F9F84',.9)+line([p(-251,-203,175),p(-239,-203,175)],'#94A78A',.7);
 return s;
}
function quoteDistrict(){
 let s=shadow(-83,-211,149,128,92)+box(-82,-214,4,151,128,8);
 s+=box(-76,-210,12,117,76,70)+box(-79,-213,82,123,82,5);
 s+=windows(-74,-134,78,111,31,10,2);
 s+=box(-55,-188,87,72,46,23)+vents(-50,-183,110,62,34,12);
 s+=fan(-68,-193,89,9)+fan(31,-193,89,9);
 // Tall gauge pavilion with a fine framed face.
 s+=box(-64,-128,12,92,18,64,{top:'#E5ECDD'});
 s+=plane(-57,-110,68,rect(0,0,78,45,'#526A56',3)+pathsvg('M12 35 A27 27 0 0 1 66 35','#ACC19A',1.8));
 for(let i=0;i<9;i++){const a=Math.PI+i*Math.PI/8;s+=plane(-57,-110,68,line([[39+27*Math.cos(a),35+27*Math.sin(a)],[39+24*Math.cos(a),35+24*Math.sin(a)]],'#D4E4C7',.7));}
 s+=label(-56,-110,21,'ACCEPTED / FIXED',4.1);
 s+=box(42,-191,12,21,73,39)+windows(44,-118,45,17,25,2,3)+fan(52,-161,53,7);
 s+=box(-60,-88,4,100,13,10,{top:'#80987A'})+rail(-60,-88,14,100,13);
 s+=label(-51,-75,9,'QUOTE EXCHANGE',4.2);
 for(let i=0;i<4;i++)s+=crate(-79+i*12,-91,4,6);
 return s;
}
function authorizationDistrict(){
 let s=shadow(145,-213,143,121,99)+box(140,-216,4,158,128,7);
 s+=box(145,-210,11,36,61,69)+box(249,-210,11,38,61,69)+box(140,-215,80,153,69,13,{top:'#EFF4E6'});
 s+=vents(148,-206,94,132,24,8)+fan(167,-170,94,10)+fan(266,-170,94,10);
 s+=windows(147,-149,72,32,51,3,4)+windows(251,-149,72,32,51,3,4);
 s+=box(185,-196,11,9,57,62,{front:'#BCD49B',side:'#99B477',top:'#E6EFDA'})+box(235,-196,11,9,57,62,{front:'#BCD49B',side:'#99B477',top:'#E6EFDA'});
 s+=box(187,-197,72,55,57,7)+top(194,-194,11,40,90,'#D3DFCD');
 for(let i=0;i<6;i++)s+=top(195,-133+i*6,11.2,38,2.5,'#F6F9EF');
 s+=box(148,-122,11,26,28,32)+plane(152,-94,37,rect(0,0,18,18,'#4E6854',1)+pathsvg('M4 9l4 4 7-9','#CBDDAB',1.2));
 for(let x=184;x<256;x+=17)s+=cylinder(x,-98,11,2.8,15,'#D1DFBD');
 s+=label(199,-140,74,'AUTHORIZE',4.5);
 s+=rail(142,-213,94,150,66);
 return s;
}
function inferenceDistrict(){
 let s=shadow(-304,40,156,146,94)+box(-301,40,4,155,145,8);
 // A glass sawtooth-roof workshop; side ribs and internal benches remain readable.
 s+=box(-296,45,12,137,78,60,{front:'#9BB5A0',side:'#ADC5AF',top:'#D8E5D1'});
 s+=plane(-292,123,67,rect(0,0,129,48,'url(#glass)',0));
 for(let k=0;k<8;k++)s+=plane(-292+k*17,123,68,rect(0,0,2,53,'#EBF0E3'));
 for(let k=0;k<3;k++){const x=-294+k*45;s+=poly([p(x,46,75),p(x+40,46,91),p(x+40,118,91),p(x,118,75)],'#EAF0DF','#B6C8AE');s+=poly([p(x+40,46,91),p(x+44,46,73),p(x+44,118,73),p(x+40,118,91)],'#9EB99D','#8DA98F');}
 s+=box(-298,40,72,140,7,7)+box(-298,120,72,140,6,7);
 for(let i=0;i<5;i++){s+=box(-286+i*24,104,16,17,12,23,{front:'#69836C',side:'#8FA98E',top:'#D3E3CA'});s+=led(-282+i*24,116,33,6);}
 s+=box(-297,138,12,137,27,9,{top:'#5D775F',front:'#9EAF95',side:'#829B7A'});
 for(let i=0;i<24;i++)s+=line([p(-295+i*5.5,140,21.2),p(-295+i*5.5,163,21.2)],'#92AD88',.8);
 s+=box(-294,172,12,31,10,6)+box(-195,172,12,31,10,6);
 for(let k=0;k<4;k++)s+=box(-253,177+k*3,4,38,3,8-k*2,{top:'#EBF0E0',front:'#BDCCAE',side:'#A5B895'});
 for(const x of [-278,-177]){s+=cylinder(x,131,12,8,12)+cylinder(x,131,24,5,21,'#A6BD96');}
 s+=label(-284,123,21,'INFERENCE WORKSHOP',4.4);
 s+=pipe([[-153,59,12],[-153,59,88],[-137,59,88],[-137,143,88],[-153,143,54]],2.6);
 s+=fan(-286,59,94,7)+fan(-192,59,99,7);
 return s;
}
function meterDistrict(){
 let s=shadow(-84,38,150,143,87)+box(-82,39,4,151,148,8);
 s+=box(-76,44,12,76,73,67)+box(-78,41,79,80,79,5)+box(9,47,12,48,54,41);
 s+=windows(-72,117,75,66,26,7,2)+windows(11,101,50,42,25,5,2);
 s+=vents(-71,48,84,63,23,10)+fan(-49,96,86,11)+fan(31,66,54,12);
 s+=box(-66,122,12,106,14,46)+plane(-59,136,50,rect(0,0,92,27,'#4F6D55',2));
 s+=label(-56,136,18,'METER / RELEASE',4.5);
 s+=box(-77,149,12,140,29,13,{top:'#708E6E',front:'#B7C8AA',side:'#90AA80'});
 for(let k=0;k<24;k++)s+=line([p(-75+k*5.7,151,25.1),p(-75+k*5.7,176,25.1)],'#A5BD97',.8);
 s+=box(-22,150,25,5,26,7,{top:'#D8E8BF',front:'#ADC397',side:'#8CA977'});
 s+=pipe([[47,53,54],[66,53,54],[66,145,54],[46,145,29]],2.4);
 s+=rail(-80,42,85,81,78);
 for(let i=0;i<3;i++)s+=crate(31+i*11,181,12,8);
 return s;
}
function receiptDistrict(){
 let s=shadow(138,39,154,149,141)+box(137,39,4,158,149,8);
 s+=box(143,46,12,48,69,121)+box(141,44,133,52,73,6);
 for(let k=0;k<9;k++){
  s+=plane(147,115,124-k*12,rect(0,0,39,7.5,'#8FA98D',.5)+rect(1,1,35,1,'#D9E6CA'));
  for(let i=0;i<5;i++)s+=plane(148+i*7.5,115,124-k*12,rect(0,0,1,7,'#C9D8BD'));
  s+=rightPlane(191,50,124-k*12,rect(0,0,61,7.5,'#799675',.5)+rect(2,1,57,1,'#BCCFB0'));
  s+=led(150+k%4*8,115,125-k*12,3);
 }
 s+=vents(148,51,140,37,47,11)+fan(166,99,141,9);
 s+=box(201,47,12,36,50,68)+windows(204,97,72,30,48,3,5)+fan(219,69,83,11);
 s+=cylinder(267,72,12,20,91)+cylinder(267,72,105,23,7,'#DDEBC7')+cylinder(267,72,113,18,3,'#AEC68B');
 for(let k=0;k<5;k++){let[zx,zy]=p(267,72,25+k*17);s+=ellipse(zx,zy,27,13.5,'none','stroke="#ECF4DD" stroke-width="1"');}
 s+=box(201,124,12,86,54,41)+box(207,130,53,74,42,5)+vents(212,132,58,35,19,8)+fan(268,146,61,9);
 s+=plane(210,178,44,rect(0,0,62,9,'#486441',2));
 s+=label(213,178,27,'PRIVATE RECEIPTS',4.2);
 s+=box(141,137,12,45,44,32)+windows(144,181,40,38,20,4,2)+fan(162,157,46,9);
 s+=pipe([[194,57,21],[194,30,21],[260,30,21],[260,51,21]],2.7);
 for(let i=0;i<4;i++)s+=crate(204+i*13,184,12,8);
 s+=rail(140,42,139,53,75);
 return s;
}
function streetFurniture(){
 let s='';
 // Street-level details: parcels, scooter docks, planted islands, utility cabinets.
 for(const [x,y]of [[-280,-59],[-236,-59],[-59,-62],[2,-59],[172,-60],[266,-60],[-276,192],[-228,192],[-57,192],[12,192],[173,192],[267,192]]){
  s+=box(x,y,4,19,5,3,{top:'#AFC59A',front:'#BACCB0',side:'#95AE83'});for(let i=0;i<4;i++)s+=line([p(x+3+i*4,y,8),p(x+3+i*4,y+5,8)],'#E7F0DD',.6);
 }
 for(const [x,y]of [[-130,-169],[-132,95],[84,-167],[83,104],[301,-175],[301,92]]){s+=box(x,y,2,9,11,18)+led(x+2,y+11,13,4);s+=label(x+1,y+11,7,'OP',3.8);}
 for(const [x,y]of [[-130,-60],[82,-60],[-128,184],[83,184],[301,184]])s+=tree(x,y,.82);
 // Elevated inter-district pipe links deliberately preserve sightlines.
 s+=pipe([[-156,-161,51],[-129,-161,51],[-129,-177,51],[-79,-177,51]],2.5);
 s+=pipe([[45,-157,43],[80,-157,43],[80,-177,43],[144,-177,43]],2.3);
 s+=pipe([[-202,-89,32],[-202,-50,32],[-189,-50,32],[-189,40,32]],2.5);
 s+=pipe([[32,-85,30],[32,-46,30],[46,-46,30],[46,40,30]],2.3);
 s+=pipe([[249,-84,25],[249,-49,25],[235,-49,25],[235,40,25]],2.3);
 return s;
}

const mod=(a,b)=>((a%b)+b)%b;
function onPath(points,v){const lengths=points.slice(1).map((q,i)=>Math.hypot(q[0]-points[i][0],q[1]-points[i][1]));let distance=mod(v,1)*lengths.reduce((a,b)=>a+b,0);for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]){const q=points[i],r=points[i+1],t=distance/lengths[i];return{x:q[0]+(r[0]-q[0])*t,y:q[1]+(r[1]-q[1])*t,dx:Math.sign(r[0]-q[0]),dy:Math.sign(r[1]-q[1])}}distance-=lengths[i]}return{x:points[0][0],y:points[0][1],dx:1,dy:0};}
const ring=[[-329,-253],[317,-253],[317,223],[-329,223],[-329,-253]],innerRing=[[-105,-224],[109,-224],[109,193],[-105,193],[-105,-224]];
function vehicle(v,kind=0){const length=kind===2?23:15,w=v.dx?length:7,d=v.dx?7:length;let s=box(v.x-w/2,v.y-d/2,3,w,d,5,{top:kind?'#E8F0D8':'#FBFCF4',front:'#A6BB9B',side:'#7C9878'});s+=top(v.x-w*.28,v.y-d*.28,8.2,w*.56,d*.56,'#5D7862');if(kind===2){for(let i=0;i<3;i++)s+=top(v.x-w*.25+(v.dx?i*5:0),v.y-d*.25+(v.dy?i*5:0),8.35,v.dx?3.5:4,v.dy?3.5:4,'#BBCCAF');}const [cx,cy]=p(v.x,v.y,8.4);return s+ellipse(cx,cy,1.3,.8,kind?C.active:'#E1EFBB');}
function traffic(t){let s='',u=mod(t,DURATION)/DURATION;
 // Small electric shuttles circulate in both directions; a linked light rail uses the outer circuit.
 for(let i=0;i<14;i++)s+=vehicle(onPath(i%3?ring:innerRing,(i%2?1:-1)*u*(i%3===0?2:1)+i*.071),i%4===0);
 for(let i=0;i<5;i++){const v=onPath(ring,u+.16-i*.0115);s+=vehicle(v,2);}
 // Ground data routes pulse independently underneath architecture and bridges.
 const routes=[[[-281,-45],[257,-45],[257,23]],[[-136,-209],[-136,199]],[[85,-209],[85,199]],[[-277,205],[283,205]]];
 for(let j=0;j<routes.length;j++){s+=line(routes[j].map(q=>p(...q,2.8)),'#A6BF8F',1);for(let i=0;i<4;i++){const v=onPath(routes[j],u*4+i*.25+j*.18),[x,y]=p(v.x,v.y,3);s+=ellipse(x,y,2.5,1.2,'#DBF2B6')+ellipse(x,y,5,2.5,'#CDEDA1','opacity=".20"');}}
 // Visitors and hand trucks move on open sidewalks, never across building footprints.
 for(let i=0;i<18;i++){const v=onPath([[-300,19],[286,19],[286,25],[-300,25],[-300,19]],u+(i/18)),[x,y]=p(v.x,v.y,2);s+=ellipse(x,y+1,2,1,'#586F50','opacity=".15"')+line([[x,y-1],[x,y-5]],i%3?'#A0B39A':'#6A8868',1.2)+circle(x,y-6,1.2,'#D9DDCA');}
 return s;
}
function arm(x,y,z,phase,t){const a=Math.sin(t*TAU/5+phase),b=Math.cos(t*TAU/5+phase),shoulder=[x,y,z],elbow=[x+13+13*a,y-9,z+23+5*b],hand=[x+29+13*a,y+7+10*b,z+9+7*a];let s=pipe([shoulder,elbow,hand],2.8,'#D1DEC5');for(const q of [shoulder,elbow,hand]){const[xp,yp]=p(...q);s+=circle(xp,yp,3.6,'#8AA376')+circle(xp,yp,1.8,'#DFEACD');}const[xp,yp]=p(...hand);s+=pathsvg(`M${xp-3} ${yp+2}v5h3m6-5v5h-3`,'#526D4D',1.4);return s;}
function effects(t){const u=mod(t,DURATION)/DURATION;let s='';
 for(const f of fans){const angle=(u*360*20+f.phase*180)%360;let fanblades='';for(let k=0;k<5;k++)fanblades+=`<path d="M0 0C${f.r*.15} ${-f.r*.7} ${f.r*.9} ${-f.r*.9} ${f.r*.78} ${-f.r*.28}Q${f.r*.36} ${f.r*.2} 0 0" fill="#829879" transform="rotate(${angle+k*72})"/>`;s+=roof(f.x,f.y,f.z,fanblades+circle(0,0,2.3,'#C1D1B6'));}
 for(const l of leds){const light=.35+.65*Math.pow(Math.sin(u*TAU*3+l.phase),2);s+=plane(l.x,l.y,l.z,rect(0,0,l.w,2.3,'#D5F2A0',.4,'none',0,`opacity="${light.toFixed(3)}"`));}
 // Rate needle moves, then gently locks; accepted state is visible in the separate ticket lights.
 const ang=-50+60*(.5+.5*Math.sin(u*TAU*2));
 s+=plane(-57,-110,68,`<g transform="translate(39 35) rotate(${ang})">${pathsvg('M0 0V-24','#D5F0AA',1.9)}${circle(0,0,2.7,'#EDF5DF')}</g>`);
 for(let i=0;i<5;i++){const q=mod(u*4+i*.2,1);s+=top(-54+q*86,-85,15,6,6,'#EDF5DF')+line([p(-53+q*86,-84,15.2),p(-49+q*86,-84,15.2)],'#ABC783',.7);}
 // Authorization scanner descends through the portal; a gate arm raises and lowers.
 const scan=12+54*(.5+.5*Math.sin(u*TAU*4));
 s+=poly([p(195,-141,scan),p(233,-141,scan),p(233,-176,scan),p(195,-176,scan)],'#CFEAA5','none',0,'opacity=".23"')+line([p(195,-141,scan),p(233,-141,scan)],'#CDE9A0',1.8);
 const gate=.5+.5*Math.sin(u*TAU*2),ga=gate*1.2;
 s+=pipe([[188,-124,28],[188+46*Math.cos(ga),-124,28+46*Math.sin(ga)]],1.7,'#CCDDAE');
 // Workshop arms sort glowing packages across a live roller conveyor.
 s+=arm(-278,131,45,0,t)+arm(-177,131,45,Math.PI,t);
 for(let i=0;i<8;i++){const q=mod(u*4+i/8,1),x=-293+q*124;s+=crate(x,145,22,7)+top(x+1,146,28,5,4,i%3?'#D4E6B8':'#C7E692');}
 // Meter bars, a physical diverter and two return paths run at separate periods.
 let bars='';for(let i=0;i<13;i++){const h=5+14*(.5+.5*Math.sin(u*TAU*2+i*.35));bars+=rect(5+i*6.3,23-h,3.5,h,i<8?'#C5DFA3':'#88AA7B',.5);}s+=plane(-59,136,50,bars);
 for(let i=0;i<7;i++){let q=mod(u*4+i/7,1);let x=-71+q*124,y=155+(i%2?8:0);s+=crate(x,y,26,5);}
 const [gx,gy]=p(-19,162,35);s+=`<g transform="translate(${gx} ${gy}) rotate(${Math.sin(u*TAU*4)*18})">${pathsvg('M-8 0L10 3','#D6EAB6',2.1)}</g>`;
 for(let i=0;i<4;i++){const q=mod(-u*2+i*.25,1);s+=crate(-72+q*128,189,5,5);}
 // Printer paper unrolls; a signature line is progressively revealed on the slip.
 const ph=.5+.5*Math.sin(u*TAU*2),len=20+24*ph;
 s+=plane(220,178,43,`<path d="M0 0H38V${len-7}Q38 ${len+1} 32 ${len+2}H-6Q0 ${len-1} 0 ${len-7}Z" fill="#FAFBF1" stroke="#B9CBB0" stroke-width=".55"/>${pathsvg(`M6 7H30M6 12H27M6 17H${14+14*ph}`,'#A7BD95',.65)}`);
 // Archive-root beacon with orbiting checks and soft concentric pulses.
 const [bx,by]=p(267,72,121),pulse=.5+.5*Math.sin(u*TAU*5);
 s+=ellipse(bx,by,24+8*pulse,12+4*pulse,'none',`stroke="#C3DDA4" stroke-width="1" opacity="${.45-.25*pulse}"`);
 for(let i=0;i<3;i++){const a=u*TAU*2+i*TAU/3;s+=ellipse(bx+26*Math.cos(a),by+13*Math.sin(a),2.1,1.4,'#E2F6BA');}
 // A service lift travels its fixed tower shaft, stopping smoothly at both levels.
 const lift=16+86*(.5-.5*Math.cos(u*TAU*2));s+=box(191,92,lift,10,19,13,{front:'#DCE8CD',side:'#9BB790',top:'#F0F5E5'})+windows(192,111,lift+11,7,7,1,1);
 // Four small courier drones on closed ellipses, with spinning rotors and moving soft shadows.
 for(let i=0;i<4;i++){const a=u*TAU+(i*.25*TAU),x=110*Math.cos(a)+(i%2?110:-150),y=77*Math.sin(a)+(i<2?-120:112),z=155+13*Math.sin(a*2+i),[dx,dy]=p(x,y,z),[sx,sy]=p(x,y,2);
  s+=ellipse(sx,sy,12,5,'#5C795B','opacity=".055"');
  s+=box(x-4,y-4,z,8,8,4,{top:'#F5F8EA',front:'#AFBE9D',side:'#8EA87F'});
  for(const[ox,oy]of[[-8,-7],[8,-7],[-8,7],[8,7]]){const[cx,cy]=p(x+ox,y+oy,z+2);s+=line([[dx,dy],[cx,cy]],'#8DA581',1)+ellipse(cx,cy,5,2.5,'none','stroke="#91AC83" stroke-width=".7"')+line([[cx-4*Math.cos(u*TAU*40),cy-1.8*Math.sin(u*TAU*40)],[cx+4*Math.cos(u*TAU*40),cy+1.8*Math.sin(u*TAU*40)]],'#DCEBCC',1);}
 }
 return s;
}

async function main(){
 await fs.mkdir(WORK,{recursive:true});await fs.mkdir(OUT,{recursive:true});
 if(process.argv.includes('--live')){
  const darken=s=>s.replaceAll('#526A56','#202722').replaceAll('#4F6D55','#202722').replaceAll('#4E6854','#202722').replaceAll('#687E70','#3B4740').replaceAll('#33483B','#202722').replaceAll('#4D6253','#37423A').replaceAll('#849387','#56625A');
  const districts=[['capacity',capacityDistrict()],['quote',quoteDistrict()],['inference',inferenceDistrict()],['authorization',authorizationDistrict()],['meter',meterDistrict()],['receipt',receiptDistrict()]];
  const city=districts.map(([id,body])=>`<g data-city-district="${id}"><g filter="url(#neutral-architecture)">${darken(body)}</g><g data-district-motion="${id}"></g></g>`).join('');
  const eyes=(id,x,y,z,w,h)=>`<g data-city-eyes="${id}">${plane(x,y,z,rect(0,0,w,h,'#202522',h*.15,'#737D73',.5)+rect(w*.14,h*.30,w*.28,h*.21,'#CCFF00',h*.10)+rect(w*.58,h*.30,w*.28,h*.21,'#CCFF00',h*.10)+rect(w*.45,h*.64,w*.10,h*.08,'#BEE900',h*.04))}</g>`;
  const robotEyes=eyes('capacity',-248,-139,134,37,21)+eyes('inference',-236,123,61,37,23)+eyes('quote',46,-118,41,14,10)+eyes('receipt',148,115,124,36,20);
  const newDefs=`<defs><radialGradient id="city-neon-field"><stop stop-color="#CCFF00" stop-opacity=".16"/><stop offset="1" stop-color="#CCFF00" stop-opacity="0"/></radialGradient></defs>`;
  const instruments=[['GPU utilization','67.4','%'],['Available capacity','32.6','%'],['Model throughput','812','tok/s']].map(([name,value,unit],i)=>{
   const x=105+i*500,y=630,w=350,h=57;
   const trace=Array.from({length:27},(_,k)=>[145+k*7.1,34-9*Math.sin(k*.36+i)-3*Math.sin(k*.9)]);
   return `<g data-city-instrument="${i}" transform="translate(${x} ${y})">${poly([[-5,-6],[w+3,-6],[w,0],[0,0]],'#5A5D59','#95998F',.7)}${poly([[w,0],[w+7,-6],[w+7,h-4],[w,h]],'#292C29','#73786C',.7)}${rect(0,0,w,h,'#353834',5,'#808679',.9)}${rect(4,4,w-8,h-8,'#171C18',3,'#3B4437',.5)}${rect(12,h,7,7,'#686D63',1)}${rect(w-19,h,7,7,'#686D63',1)}${rect(9,8,w-18,1,'#D9DFCF',0,'none',0,'opacity=".16"')}<text data-metric-label="" x="15" y="17" font-family="Arial,sans-serif" font-size="9.5" fill="#AEB7A2">${name}</text><text data-metric-value="" x="15" y="44" font-family="Arial,sans-serif" font-size="24" letter-spacing="-1.2" fill="#EDF3E4">${value}</text><text data-metric-unit="" x="98" y="42" font-family="Arial,sans-serif" font-size="9" fill="#AFBBA2">${unit}</text>${line([[145,44],[330,44]],'#46513E',.5)}${line([[145,30],[330,30]],'#35402F',.4)}<path data-metric-fill="" d="M${trace.map(v=>v.join(' ')).join('L')}L330 44H145Z" fill="#CCFF00" opacity=".07"/><polyline data-metric-line="" points="${P(trace)}" fill="none" stroke="#CCFF00" stroke-width="1.4" stroke-linejoin="round"/><circle data-metric-dot="" cx="330" cy="${trace.at(-1)[1]}" r="2.2" fill="#CCFF00"/><text x="329" y="15" text-anchor="end" font-family="Arial,sans-serif" font-size="6.7" letter-spacing=".65" fill="#88977C">ILLUSTRATIVE</text></g>`;
  }).join('');
  const live=svg(`${newDefs}<g data-city-ground="" filter="url(#neutral-ground)">${ground(true)}</g><g data-city-traffic=""></g><g data-city-architecture="">${city}<g filter="url(#neutral-architecture)">${darken(streetFurniture())}</g></g><g data-city-details="">${robotEyes}</g><g data-city-air=""></g><g data-city-fields=""></g><g data-city-analytics="">${instruments}</g>`);
  await fs.writeFile(path.join(OUT,'offpeak-city-live.svg'),live);
  const districtFor=(x,y)=>y<0?(x<-125?'capacity':x<110?'quote':'authorization'):(x<-125?'inference':x<110?'meter':'receipt');
  const state={width:W,height:H,camera,projection:'front-facing orthographic, horizontal facades',analytics:'illustrative',period_seconds:20,fans:fans.map(f=>({...f,district:districtFor(f.x,f.y)})),leds:leds.map(l=>({...l,district:districtFor(l.x,l.y)})),districts:[{id:'capacity',x:-229,y:-69,z:10},{id:'quote',x:-6,y:-69,z:10},{id:'authorization',x:217,y:-69,z:10},{id:'inference',x:-229,y:195,z:12},{id:'meter',x:-4,y:195,z:12},{id:'receipt',x:216,y:195,z:12}]};
  await fs.writeFile(path.join(OUT,'offpeak-city-live-state.json'),JSON.stringify(state));
  const neon=s=>s.replaceAll('#D5F2A0','#CCFF00').replaceAll('#D5F0AA','#CCFF00').replaceAll('#CDE9A0','#CCFF00').replaceAll('#CFEAA5','#CCFF00').replaceAll('#C5DFA3','#CCFF00').replaceAll('#C3DDA4','#CCFF00').replaceAll('#E2F6BA','#CCFF00').replaceAll('#DBF2B6','#CCFF00');
  const previewAt=t=>live.replace('<g data-city-traffic=""></g>',`<g>${neon(traffic(t))}</g>`).replace('<g data-city-air=""></g>',`<g>${neon(effects(t))}</g>`);
  const preview=previewAt(0);
  await sharp(Buffer.from(preview)).png().toFile(path.join(OUT,'offpeak-city-live-poster.png'));
  await sharp(Buffer.from(preview)).flatten({background:'#f8f8f8'}).png().toFile(path.join(ROOT,'city-live-proof.png'));
  const initial=await sharp(Buffer.from(preview)).ensureAlpha().raw().toBuffer(),end=await sharp(Buffer.from(previewAt(20))).ensureAlpha().raw().toBuffer();let delta=0,transparent=0,min=255,max=0;
  for(let i=0;i<initial.length;i++){delta+=Math.abs(initial[i]-end[i]);if(i%4===3){min=Math.min(min,initial[i]);max=Math.max(max,initial[i]);if(initial[i]===0)transparent++;}}
  if(delta)throw new Error(`Front city source loop differs: ${delta}`);
  const corners=[3,(W-1)*4+3,(W*(H-1))*4+3,(W*H-1)*4+3].map(i=>initial[i]);
  await fs.writeFile(path.join(ROOT,'live-validation.json'),JSON.stringify({dimensions:[W,H],mode:'RGBA',projection:state.projection,camera,alpha_extrema:[min,max],fully_transparent_pixels:transparent,transparent_fraction:Number((transparent/(W*H)).toFixed(4)),corner_alpha:corners,background_rectangle:false,overall_floor_slab:false,districts:6,fan_anchors:fans.length,led_anchors:leds.length,analytics_instruments:3,analytics_mode:'illustrative; district-selected; 1Hz; deterministic 20s period',source_0s_20s_raw_pixel_difference:delta,svg_bytes:Buffer.byteLength(live),runtime:'../city-interactive.js'},null,2));
  console.log(`Live transparent SVG exported: ${Buffer.byteLength(live)} bytes; no overall background or slab. ${fans.length} fan anchors, ${leds.length} LED anchors.`);return;
 }
 const groundSvg=svg(`<g filter="url(#neutral-ground)">${ground()}</g>`);
 const citySvg=svg(`<g filter="url(#neutral-architecture)">${capacityDistrict()+quoteDistrict()+inferenceDistrict()+authorizationDistrict()+meterDistrict()+receiptDistrict()+streetFurniture()}</g>`);
 await fs.writeFile(path.join(ROOT,'city-ground.svg'),groundSvg);await fs.writeFile(path.join(ROOT,'city-architecture.svg'),citySvg);
 const [groundPng,cityPng]=await Promise.all([sharp(Buffer.from(groundSvg)).png().toBuffer(),sharp(Buffer.from(citySvg)).png().toBuffer()]);
 await fs.writeFile(path.join(WORK,'ground.png'),groundPng);await fs.writeFile(path.join(WORK,'architecture.png'),cityPng);
 async function frame(t,raw=false){const [trafficPng,effectsPng]=await Promise.all([sharp(Buffer.from(svg(traffic(t)))).png().toBuffer(),sharp(Buffer.from(svg(effects(t)))).png().toBuffer()]);let render=sharp(groundPng).composite([{input:trafficPng},{input:cityPng},{input:effectsPng}]);return raw?render.removeAlpha().raw().toBuffer():render.png().toBuffer();}
 const times=[0,5.5,11,16.5],proofs=[];
 for(const t of times){const b=await frame(t);await fs.writeFile(path.join(WORK,`proof-${t}.png`),b);proofs.push(b);if(t===0)await fs.writeFile(path.join(OUT,'offpeak-city-poster.png'),b);}
 await sharp({create:{width:1600,height:900,channels:4,background:C.paper}}).composite(await Promise.all(proofs.map(async(b,i)=>({input:await sharp(b).resize(800,450).png().toBuffer(),left:(i%2)*800,top:Math.floor(i/2)*450})))).png().toFile(path.join(ROOT,'city-contact-sheet.png'));
 console.log(`PROOF READY: ${fans.length} rotating fans, ${leds.length} status lights, six districts. ${W}x${H}.`);
 if(!process.argv.includes('--render'))return;
 const a=await frame(0,true),b=await frame(20,true);let diff=0;for(let i=0;i<a.length;i++)diff+=Math.abs(a[i]-b[i]);
 if(diff!==0)throw new Error(`Loop is not periodic: ${diff}`);
 const meanDifference=(one,two)=>{let d=0;for(let i=0;i<one.length;i++)d+=Math.abs(one[i]-two[i]);return d/one.length;};
 const finalFrame=await frame(DURATION-1/FPS,true),seamDelta=meanDifference(finalFrame,a),adjacent=[];
 for(const time of [0,2.5,5,8.75,12.5,15,17.5]){const pair=await Promise.all([frame(time,true),frame(time+1/FPS,true)]);adjacent.push(meanDifference(...pair));}
 console.log(`Loop boundary mean delta ${seamDelta.toFixed(4)}; sampled ordinary steps ${Math.min(...adjacent).toFixed(4)}–${Math.max(...adjacent).toFixed(4)}.`);
 console.log('Exact 0s/20s raw-pixel periodicity verified. Encoding 480 frames.');
 const video=path.join(OUT,'offpeak-city.mp4');
 const ff=spawn(FFMPEG,['-hide_banner','-loglevel','warning','-y','-f','rawvideo','-pix_fmt','rgb24','-s',`${W}x${H}`,'-r',String(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart','-frames:v',String(FPS*DURATION),video],{stdio:['pipe','ignore','pipe'],windowsHide:true});
 let stderr='';ff.stderr.on('data',d=>stderr+=d.toString());ff.stdin.on('error',()=>{});const finished=once(ff,'close');
 const started=Date.now();
 for(let i=0;i<FPS*DURATION;i+=4){const frames=await Promise.all(Array.from({length:Math.min(4,FPS*DURATION-i)},(_,j)=>frame((i+j)/FPS,true)));for(const f of frames){if(!ff.stdin.write(f))await once(ff.stdin,'drain');}if(i%48===0)console.log(`Rendered ${i+frames.length}/480 frames, ${Math.round((Date.now()-started)/1000)}s elapsed`);}
 ff.stdin.end();const[code]=await finished;if(code!==0)throw new Error(stderr);
 const bytes=(await fs.stat(video)).size;
 const report={file:'offpeak-city.mp4',width:W,height:H,fps:FPS,duration_seconds:DURATION,frames:FPS*DURATION,audio:false,codec:'H.264 / yuv420p',loop:'Deterministic 20-second periodic animation; exact raw pixels at t=0 and t=20 are equal.',periodic_pixel_difference:diff,loop_boundary_mean_delta:seamDelta,sampled_adjacent_mean_deltas:adjacent,loop_boundary_within_sampled_motion:seamDelta<=Math.max(...adjacent)+.02,rotating_fans:fans.length,status_lights:leds.length,districts:6,moving_systems:['electric shuttles','five-car light rail','courier drones and rotors','cooling fans','status LEDs','accepted quote dial','ticket conveyor','authorization scanning plane','gate arm','two industrial sorting arms','inference token parcels','meter bars','sorting diverter','return parcels','paper feed and signature','archive root beacon','service lift','walking visitors','data-route pulses'],bytes,sha256:crypto.createHash('sha256').update(await fs.readFile(video)).digest('hex'),render_elapsed_seconds:Math.round((Date.now()-started)/1000)};
 await fs.writeFile(path.join(ROOT,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exit(1)});
