/* OFFPEAK nav Figures built with Anatomy by Ryan (MIT). See vendor/anatomy/LICENSE.
 * Concept, parts and truth note: ../evidence/nav-anatomy-design.txt.
 * Exported geometry is also reusable by the product roadmap. No browser dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as k from './vendor/anatomy/iso-kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W=320,H=260;
const BASE={x:-86,y:-58,w:172,d:116,r:8};
const P=k.fitProjection(k.boxCorners({x:-91,y:-63,w:182,d:126,r:0},-7,78),W,H,{pad:24,azimuth:45,elevation:31});
const pos=(p)=>k.iso(p,P);
const axis=(a)=>k.axisVector(P,a);
const esc=(s)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

export const NAV_ANATOMY_CSS=`
.nav-anatomy-svg{display:block;width:100%;height:100%;overflow:visible;--anatomy-paper:#343536;--anatomy-top:#57595a;--anatomy-shade-0:#292b2c;--anatomy-shade-1:#303233;--anatomy-shade-2:#393b3c;--anatomy-shade-3:#434546;--anatomy-hi:#929798;--anatomy-mid:#727778;--anatomy-lo:#565b5b;--anatomy-faint:#3f4445;--anatomy-lit:#ccff00;--anatomy-weight:.52px}
.nav-anatomy-svg .iso-fill{fill:var(--anatomy-paper);stroke:none}.nav-anatomy-svg .iso-shade{stroke:none}.nav-anatomy-svg .iso-shade[data-shade="0"]{fill:var(--anatomy-shade-0)}.nav-anatomy-svg .iso-shade[data-shade="1"]{fill:var(--anatomy-shade-1)}.nav-anatomy-svg .iso-shade[data-shade="2"]{fill:var(--anatomy-shade-2)}.nav-anatomy-svg .iso-shade[data-shade="3"]{fill:var(--anatomy-shade-3)}.nav-anatomy-svg .iso-top{fill:var(--anatomy-top);stroke:none}
.nav-anatomy-svg .iso-line{fill:none;stroke:var(--anatomy-lo);stroke-width:var(--anatomy-weight);stroke-linecap:round;stroke-linejoin:round}.nav-anatomy-svg .iso-line[data-tone="hi"]{stroke:var(--anatomy-hi)}.nav-anatomy-svg .iso-line[data-tone="mid"]{stroke:var(--anatomy-mid)}.nav-anatomy-svg .iso-line[data-tone="faint"]{stroke:var(--anatomy-faint)}.nav-anatomy-svg .iso-line[data-tone="lit"]{stroke:#ccff00}.nav-anatomy-svg .iso-bevel{stroke:#b7bbbb;opacity:.5}.nav-anatomy-svg .iso-dots{fill:#afb4b3;stroke:none}.nav-anatomy-svg .iso-dots circle{opacity:.7}.nav-anatomy-svg .iso-face-text{fill:#b3b8b5;font-family:ui-monospace,monospace;letter-spacing:.1em}
.nav-anatomy-svg .an-white{--anatomy-paper:#e8e9e6;--anatomy-top:#fafbf8;--anatomy-shade-0:#aaaead;--anatomy-shade-1:#bfc3c0;--anatomy-shade-2:#d1d5d1;--anatomy-shade-3:#e0e4df;--anatomy-hi:#9ea4a0;--anatomy-mid:#b0b6b1;--anatomy-lo:#bbc0bd;--anatomy-faint:#d8dcd6}
.nav-anatomy-svg .an-dark{--anatomy-paper:#171b1b;--anatomy-top:#222727;--anatomy-shade-0:#111515;--anatomy-shade-1:#171c1c;--anatomy-shade-2:#202525;--anatomy-shade-3:#292e2e;--anatomy-hi:#56615e;--anatomy-faint:#303b37}
.nav-anatomy-svg .an-signal{--anatomy-paper:#9bc100;--anatomy-top:#ccff00;--anatomy-shade-0:#627b00;--anatomy-shade-1:#7d9b00;--anatomy-shade-2:#97b800;--anatomy-shade-3:#afd500;--anatomy-hi:#d4ff33;--anatomy-faint:#99ba00}
.nav-anatomy-svg .an-ink{stroke:#a3aaa4;stroke-width:.8;fill:none;stroke-linecap:round}.nav-anatomy-svg .an-halo{fill:#1d2921;opacity:.10;filter:blur(6px)}.nav-anatomy-svg .an-fan-vane{fill:#929b98;stroke:#bcc4bf;stroke-width:.45}.nav-anatomy-svg .an-fan-root{fill:#4b5551}.nav-anatomy-svg .an-part{vector-effect:non-scaling-stroke}
`;

function figure(key,label){
  let count=0;
  const items=[],motions=[];
  const add=(name,svg,at,order=0)=>{items.push({name,svg,key:k.depthOf(at,P)+order});return svg;};
  const solid=(name,plan,z,h,material='',order=0,extra='')=>{
    count++;
    const shape=k.slabOf(plan,z,h,P,5,Math.min(.8,h*.18));
    return add(name,`<g class="an-part ${material}" data-part="${name}">${k.solidSvg(shape,{tone:'hi',inner:extra})}</g>`,[plan.x+plan.w/2,plan.y+plan.d/2,z+h/2],order);
  };
  const cyl=(name,x,y,r,z,h,material='',order=0,extra='')=>{
    count++;
    return add(name,`<g class="an-part ${material}" data-part="${name}">${k.solidSvg(k.cylinder(x,y,r,z,h,P,36,.35),{tone:'hi',inner:extra})}</g>`,[x,y,z+h/2],order);
  };
  const screw=(name,x,y,z)=>cyl(name,x,y,1.45,z,.7,'',0,k.lineSvg(k.lineOnTop([x-.8,y],[x+.8,y],z+.7,P),{tone:'lo'}));
  const inset=(name,plan,z,material='an-dark')=>solid(name,plan,z,.45,material);
  const group=(name,fn,at,motion)=>{
    const start=items.length;fn();const children=items.splice(start).sort((a,b)=>a.key-b.key).map(x=>x.svg).join('');
    add(name,`<g data-an-motion="${name}">${children}</g>`,at);if(motion)motions.push({name,...motion});
  };
  function base(){
    for(const [i,[x,y]] of k.corners(BASE,15).entries()){
      solid(`foot-${i}`,{x:x-5,y:y-5,w:10,d:10,r:3},-7,4,'an-dark');
      solid(`collar-${i}`,{x:x-6,y:y-6,w:12,d:12,r:3},-3,3);
    }
    solid('stand-plinth',BASE,0,7,'',0,k.lineSvg(k.sideSeam(BASE,3.5,P,5),{tone:'faint'}));
    solid('service-deck',k.insetPlan(BASE,5),7,1.5,'an-dark');
    k.corners(BASE,11).forEach(([x,y],i)=>screw(`base-screw-${i}`,x,y,8.5));
    solid('power-bezel',{x:59,y:40,w:15,d:7,r:2},8.5,2,'an-dark');
    solid('power-lens',{x:62,y:42,w:7,d:2.5,r:1},10.5,.7,'an-signal');
    solid('identity-plate',{x:-71,y:41,w:35,d:7,r:1.2},8.5,.8,'',0,k.faceTextSvg(k.topMatrix([-67,46],9.3,P),'OFFPEAK',{size:3.4,tone:'mid'}));
  }
  base();
  const api={solid,cyl,screw,inset,group,add,motions,get count(){return count;},parts:(n)=>count+=n};
  function finish(){
    const body=`<path class="an-halo" d="${k.haloOf(BASE,-7,1,P)}"/>`+items.sort((a,b)=>a.key-b.key).map(i=>i.svg).join('');
    const svg=k.figureSvg({width:W,height:H,label,body,className:'nav-anatomy-svg'});
    const standalone=svg.replace('><',`><style>${NAV_ANATOMY_CSS}</style><`);
    return{key,label,width:W,height:H,body,svg,standalone,projection:P,motions,partCount:count};
  }
  return{...api,finish};
}

function capacity(){
  const f=figure('capacity','Illustrative capacity bank: two cooling fans above replaceable compute modules.');
  const {solid,cyl,screw,add}=f;
  solid('fan-bank-foundation',{x:-64,y:-41,w:128,d:70,r:5},8.5,9);
  solid('replaceable-white-deck',{x:-60,y:-37,w:120,d:62,r:4},17.5,2,'an-white');
  for(let i=0;i<8;i++)solid(`radiator-fin-${i}`,{x:-48+i*13,y:-35,w:4,d:58,r:.7},19.5,5,'');
  [-31,31].forEach((x,i)=>{
    const y=-5;
    solid(`fan-square-${i}`,{x:x-26,y:y-26,w:52,d:52,r:5},24.5,6,'');
    cyl(`fan-recess-${i}`,x,y,22,30.5,.7,'an-dark');
    const blades=Array.from({length:8},(_,j)=>`<path class="an-fan-vane" transform="rotate(${j*45})" d="M3 -2 C10 -9 16 -11 19 -5 L17 3 C11 2 7 3 3 2Z"/>`).join('');
    const matrix=k.topMatrix([x,y],31.3,P);
    add(`fan-rotor-${i}`,`<g transform="${matrix}"><g data-an-motion="fan-${i}">${blades}</g></g>`,[x,y,31.35]);
    f.parts(8);f.motions.push({name:`fan-${i}`,kind:'rotate',speed:i?24:-28});
    cyl(`fan-hub-${i}`,x,y,5.5,31.4,3.4,'');
    cyl(`fan-hub-inlay-${i}`,x,y,2.6,34.8,.5,'an-white');
    k.corners({x:x-26,y:y-26,w:52,d:52,r:5},5).forEach(([sx,sy],j)=>screw(`fan-screw-${i}-${j}`,sx,sy,30.5));
  });
  [-55,55].forEach((x,i)=>{
    solid(`bus-rail-${i}`,{x:x-2,y:-43,w:4,d:79,r:1},8.5,7,'an-white');
    solid(`bus-stop-${i}`,{x:x-4,y:29,w:8,d:8,r:1.5},15.5,2);
  });
  return f.finish();
}
function sorter(){
  const f=figure('sorter','Illustrative request sorter: a guided carriage routes one bounded request into an output tray.');
  const {solid,screw,group}=f;
  [-39,26].forEach((y,i)=>{
    solid(`guide-${i}`,{x:-64,y,w:126,d:5,r:1},8.5,6,'an-white');
    [-61,57].forEach((x,j)=>solid(`guide-stop-${i}-${j}`,{x,y:y-2,w:7,d:9,r:1.4},14.5,5));
  });
  for(let i=0;i<3;i++){
    const x=-58+i*40;
    solid(`tray-${i}`,{x,y:-25,w:34,d:45,r:2},8.5,3);
    [-25,17].forEach((y,j)=>solid(`tray-wall-${i}-${j}`,{x,y,w:34,d:3,r:.6},11.5,7));
    solid(`tray-paper-${i}`,{x:x+5,y:-18,w:24,d:30,r:1},11.5,.7,'an-white');
    solid(`tray-led-${i}`,{x:x+10,y:21,w:12,d:2,r:.5},11.5,1,i===1?'an-signal':'an-dark');
    [-56+i*40,-28+i*40].forEach((sx,j)=>screw(`tray-fixing-${i}-${j}`,sx,-22,11.5));
  }
  group('sort-carriage',()=>{
    [-37,25].forEach((y,i)=>solid(`carriage-bushing-${i}`,{x:-9,y,w:18,d:9,r:2},14.5,8));
    solid('carriage-back-foot',{x:-7,y:-31,w:14,d:6,r:1.6},22.5,10);
    solid('carriage-front-foot',{x:-7,y:21,w:14,d:6,r:1.6},22.5,10);
    solid('carriage-bridge',{x:-9,y:-31,w:18,d:58,r:3},32.5,7,'an-white');
    solid('optical-head',{x:-8,y:-9,w:16,d:16,r:3},24.5,8,'');
    solid('optical-window',{x:-5,y:-7,w:10,d:12,r:1},39.5,1.2,'an-dark');
    solid('optical-lens',{x:-2,y:-5,w:4,d:8,r:.8},40.7,.7,'an-signal');
    [-26,20].forEach((y,i)=>screw(`carriage-screw-${i}`,0,y,39.5));
  },[0,-3,32],{kind:'slide',vector:axis([1,0,0]),from:-38,to:38,period:8});
  solid('ruler-strip',{x:-63,y:35,w:116,d:4,r:.8},8.5,.6,'an-white',0,(()=>{const t=k.topTicks(-60,50,5,2,35,9.1,[1.5,2.8],P);return k.lineSvg(t.minor,{tone:'lo'})+k.lineSvg(t.major,{tone:'mid'});})());
  [-60,50].forEach((x,i)=>screw(`ruler-rivet-${i}`,x,37,9.1));
  return f.finish();
}
function scanner(){
  const f=figure('scanner','Illustrative field scanner: a carriage reads structured fields from a document on a platen.');
  const {solid,screw,group}=f;
  solid('scanner-platen',{x:-57,y:-36,w:114,d:70,r:4},8.5,5);
  solid('subject-sheet',{x:-43,y:-30,w:86,d:57,r:1.5},13.5,.8,'an-white');
  for(let i=0;i<5;i++){
    solid(`field-cell-${i}`,{x:-34,y:-24+i*10,w:i%2?48:66,d:6,r:.8},14.3,.25,'an-white',0,k.lineSvg(k.planOutline({x:-33,y:-23+i*10,w:i%2?46:64,d:4,r:.6},14.55,P),{tone:'lo'}));
  }
  [-51,47].forEach((x,i)=>{
    solid(`scanner-rail-${i}`,{x,y:-36,w:4,d:69,r:.8},13.5,4,'an-white');
    [-35,27].forEach((y,j)=>solid(`scanner-stop-${i}-${j}`,{x:x-2,y,w:8,d:7,r:1.2},17.5,4));
  });
  group('scan-carriage',()=>{
    [-51,43].forEach((x,i)=>solid(`scan-bushing-${i}`,{x,y:-5,w:8,d:12,r:1.5},17.5,6));
    solid('scan-bridge',{x:-54,y:-4,w:108,d:10,r:2},23.5,5,'an-white');
    solid('scan-shoe',{x:-39,y:-3,w:78,d:8,r:1.5},18.5,5,'an-dark');
    solid('scan-optical-strip',{x:-37,y:-1,w:74,d:2,r:.7},23.5,.65,'an-signal');
    [-47,47].forEach((x,i)=>screw(`scan-fixing-${i}`,x,1,28.5));
  },[0,0,24],{kind:'slide',vector:axis([0,1,0]),from:-22,to:23,period:7});
  solid('rear-service-cover',{x:-54,y:-48,w:108,d:10,r:2},8.5,19);
  for(let i=0;i<6;i++)solid(`rear-slot-${i}`,{x:-29+i*10,y:-45,w:5,d:4,r:.7},27.5,.4,'an-dark');
  [-48,48].forEach((x,i)=>screw(`cover-fixing-${i}`,x,-42.5,27.5));
  [-27,17].forEach((x,i)=>{
    solid(`token-seat-${i}`,{x,y:29,w:30,d:8,r:1.5},8.5,2);
    solid(`field-token-${i}`,{x:x+3,y:31,w:24,d:4,r:.8},10.5,2,'an-white');
  });
  return f.finish();
}
function receipt(){
  const f=figure('receipt','Illustrative receipt printer: an itemized usage slip moves through a mechanical feed.');
  const {solid,screw,group}=f;
  solid('printer-lower-case',{x:-60,y:-38,w:120,d:75,r:6},8.5,11);
  solid('printer-white-cover',{x:-56,y:-34,w:112,d:39,r:4},19.5,28,'an-white');
  solid('service-top',{x:-51,y:-29,w:102,d:29,r:3},47.5,2);
  k.corners({x:-51,y:-29,w:102,d:29,r:3},5).forEach(([x,y],i)=>screw(`cover-screw-${i}`,x,y,49.5));
  for(let i=0;i<6;i++)solid(`cover-vent-${i}`,{x:-31+i*11,y:-23,w:5,d:15,r:1},49.5,.4,'an-dark');
  solid('feed-bed',{x:-44,y:5,w:88,d:30,r:3},19.5,2,'an-dark');
  [-43,39].forEach((x,i)=>solid(`feed-guide-${i}`,{x,y:5,w:4,d:30,r:1},21.5,5,'an-white'));
  for(let i=0;i<8;i++)solid(`traction-pad-${i}`,{x:-34+i*9,y:8,w:6,d:3,r:.6},21.5,1);
  group('receipt-feed',()=>{
    solid('output-receipt',{x:-33,y:9,w:66,d:38,r:1},22.5,.8,'an-white');
    for(let i=0;i<5;i++)solid(`receipt-rule-${i}`,{x:-26,y:16+i*5,w:i===4?45:51,d:1,r:.2},23.3,.05,'an-white',0,k.lineSvg(k.lineOnTop([-26,16+i*5],[i===4?19:25,16+i*5],23.36,P),{tone:'mid',free:true}));
    solid('receipt-confirmation',{x:24,y:34,w:4,d:4,r:.5},23.3,.2,'an-signal');
  },[0,29,23.5],{kind:'feed',vector:axis([0,1,0]),from:-4,to:4,period:6.8});
  [-41,35].forEach((x,i)=>solid(`tear-mount-${i}`,{x,y:17,w:6,d:6,r:1},21.5,9));
  solid('tear-strip',{x:-38,y:19,w:76,d:2.3,r:.4},30.5,2,'an-white');
  solid('status-window',{x:20,y:-16,w:23,d:8,r:2},49.5,1.4,'an-dark');
  [24,35].forEach((x,i)=>solid(`status-eye-${i}`,{x,y:-14,w:4,d:4,r:.8},50.9,.7,'an-signal'));
  solid('feed-key',{x:-43,y:-16,w:10,d:10,r:2},49.5,2.5,'an-white');
  return f.finish();
}

export function buildNavFigures(){
  const figures=Object.fromEntries([capacity(),sorter(),scanner(),receipt()].map(f=>[f.key,f]));
  return{version:1,source:'https://github.com/wheresryan22/anatomy',license:'MIT',illustrative:true,css:NAV_ANATOMY_CSS,figures};
}
export function writeNavFigures(outDir=path.join(HERE,'../src/nav-anatomy')){
  const result=buildNavFigures();fs.mkdirSync(outDir,{recursive:true});
  for(const figure of Object.values(result.figures)){
    if(figure.partCount<40||figure.partCount>80)throw new Error(`${figure.key}: ${figure.partCount} parts outside Figure tier`);
    if(/NaN|undefined|Infinity/.test(figure.svg))throw new Error(`Invalid geometry: ${figure.key}`);
    fs.writeFileSync(path.join(outDir,`${figure.key}.svg`),figure.standalone);
  }
  const payload={...result,figures:Object.fromEntries(Object.entries(result.figures).map(([key,{body,standalone,projection,...figure}])=>[key,figure]))};
  fs.mkdirSync(path.join(HERE,'../src/assets'),{recursive:true});
  fs.writeFileSync(path.join(HERE,'../src/assets/nav-anatomy.json'),JSON.stringify(payload));
  fs.writeFileSync(path.join(outDir,'LICENSE.txt'),fs.readFileSync(path.join(HERE,'vendor/anatomy/LICENSE'),'utf8'));
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=writeNavFigures();
  console.log(Object.values(result.figures).map(f=>`${f.key}: ${f.partCount} purposeful parts / ${(f.svg.match(/<path/g)||[]).length} paths`).join('\n'));
}
