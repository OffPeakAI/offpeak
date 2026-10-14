/* Exact approved OFFPEAK white mechanical logo.
 * Geometry and 8-second motion copied without modification from:
 * source/render-white.cjs
 * Original transparent profile: model(t, {x:246, y:260, scale:1.59}), viewBox 0 0 500 500.
 * Only the SVG transport, ID namespacing, visibility, and motion lifecycle are new.
 */
(() => {
  'use strict';
  /* ORIGINAL_MODEL_START */
const TAU=Math.PI*2,DURATION=8,FPS=25,F=n=>Number(n.toFixed(5));
const C={white:'#F9FAF6',paper:'#F1F2EE',front:'#EDEFE9',side:'#C5CBC2',edge:'#8A9388',dark:'#151815',screen:'#161C17',ink:'#354033',lime:'#CCFF00'};
const rect=(x,y,w,h,fill,r=0,stroke='none',sw=.65,extra='')=>`<rect x="${F(x)}" y="${F(y)}" width="${F(w)}" height="${F(h)}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
const line=(pts,c=C.edge,w=.7,extra='')=>`<polyline points="${pts.map(p=>p.map(F).join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
const circle=(x,y,r,fill,stroke='none',sw=.6)=>`<circle cx="${F(x)}" cy="${F(y)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const label=(x,y,s,size=3.4,color='#737D70',attrs='')=>`<text x="${x}" y="${y}" font-size="${size}" font-family="Arial,sans-serif" ${attrs.includes('letter-spacing')?'':'letter-spacing=".7"'} fill="${color}" ${attrs}>${s}</text>`;
const defs=`<defs><linearGradient id="whitefront" x2=".8" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCDDDA"/></linearGradient><linearGradient id="whiteside" x2="1" y2=".2"><stop stop-color="#D7D9D6"/><stop offset="1" stop-color="#B5BBB2"/></linearGradient><linearGradient id="roofwhite" x2=".6" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#ECEEE9"/></linearGradient><linearGradient id="glass" x2=".9" y2="1"><stop stop-color="#171C18"/><stop offset=".54" stop-color="#171C18"/><stop offset="1" stop-color="#171C18"/></linearGradient><filter id="soft" x="-50%" y="-300%" width="200%" height="700%"><feGaussianBlur stdDeviation="4"/></filter></defs>`;
// Match the architectural cards' largely neutral material, retaining lime LEDs.
function neutralise(s){return s.replace(/#[0-9a-fA-F]{6}/g,c=>{if(c.toUpperCase()===C.lime)return c;const rgb=[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)),l=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;return '#'+rgb.map(v=>Math.round(l+(v-l)*.12).toString(16).padStart(2,'0')).join('');});}
function screw(x,y){return circle(x,y,2.1,'#B8C1B4','#879380',.5)+circle(x,y,1.25,'#EFF2EA')+line([[x-.85,y],[x+.85,y]],'#7C8874',.5)}
function impeller(t,phase){
 let s=circle(0,0,23,'#D6DCD1','#85917E',.65)+circle(0,0,20,'#39463A')+circle(0,0,18.2,'#536051');
 const a=(t/DURATION*720+phase)%360;
 s+=`<g transform="rotate(${F(a)})">`;
 for(let i=0;i<6;i++)s+=`<path transform="rotate(${i*60})" d="M2 -3C8 -18 20 -16 17 -6C14 -1 9 2 4 2Z" fill="${i%2?'#899681':'#C1CDB6'}" stroke="#84957B" stroke-width=".45"/>`;
 s+='</g>'+circle(0,0,4.4,'#B9C5AF','#485944',.65)+circle(0,0,2.1,'#E6ECDD');
 // The structural guard stays still while the impeller rotates underneath.
 s+=circle(0,0,14,'none','#A6B29D',.6)+line([[-20,0],[20,0]],'#D9E2D0',.65)+line([[0,-20],[0,20]],'#D9E2D0',.65);
 return s;
}
function model(time,{x=250,y=269,scale=1.69}={}){
 // Normalise first: the 0 and 8 second states are exactly identical.
 const t=((time%DURATION)+DURATION)%DURATION,q=t/DURATION*TAU;
 const yaw=(28+14*Math.sin(q)) * Math.PI/180;
 const elev=(24+3.5*Math.sin(q+Math.PI/2))*Math.PI/180;
 const cy=Math.cos(yaw),sy=Math.sin(yaw),ce=Math.cos(elev),se=Math.sin(elev);
 const bob=5*Math.sin(q),lidLift=20*(.5-.5*Math.cos(q)),suspension=6*(.5-.5*Math.cos(q+Math.PI/2));
 const p=([a,b,z])=>[x+scale*(a*cy+b*sy),y+scale*(a*sy*se-b*cy*se-(z-95)*ce-bob)];
 const depth=([a,b,z])=>a*sy*ce-b*cy*ce+z*se;
 const faces=[];let assembled='';const flush=()=>{assembled+=faces.sort((a,b)=>a.z-b.z).map(a=>a.s).join('');faces.length=0;};
 function poly(points,fill,stroke=C.edge,sw=.6,extra=''){
  return `<polygon points="${points.map(v=>p(v).map(F).join(',')).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${sw*scale}" stroke-linejoin="round" ${extra}/>`;
 }
 function put(points,markup,bias=0){faces.push({z:points.reduce((a,b)=>a+depth(b),0)/points.length+bias,s:markup});}
 function face(points,fill,extra='',bias=0){put(points,poly(points,fill)+extra,bias)}
 function plane(o,u,v,content){const a=p(o),b=p(o.map((n,i)=>n+u[i])),c=p(o.map((n,i)=>n+v[i]));return `<g transform="matrix(${F(b[0]-a[0])} ${F(b[1]-a[1])} ${F(c[0]-a[0])} ${F(c[1]-a[1])} ${F(a[0])} ${F(a[1])})">${content}</g>`;}
 function box(x0,y0,z0,w,d,h,opt={}){
  const x1=x0+w,y1=y0+d,z1=z0+h;
  const front=[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]];
  const side=[[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]];
  const roof=[[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  face(side,opt.side||'url(#whiteside)',opt.right?plane([x1+.03,y0,z1],[0,1,0],[0,0,-1],opt.right):'');
  face(roof,opt.top||'url(#roofwhite)',opt.roof?plane([x0,y0,z1+.03],[1,0,0],[0,1,0],opt.roof):'');
  face(front,opt.front||'url(#whitefront)',opt.face?plane([x0,y0-.03,z1],[1,0,0],[0,0,-1],opt.face):'');
 }
 // Bottom floating chassis: front seam and a lime status strip.
 box(-92,-53,1,184,106,13,{front:'#CBD2C5',side:'#AEBBA6',roof:rect(5,5,174,96,'#728469',3)});
 for(const xx of [-68,58])box(xx,-42,14,11,84,15+suspension,{front:'#586650',side:'#66755E',top:'#D8E4CD'});
 box(-87,-49,16+suspension,174,98,8,{front:'#748467',side:'#5D6F51',top:'#C4D0BA',face:rect(9,2.7,156,2.4,C.lime,.5)});
 flush();
 // Body panels are the same white/grey architectural material as the cards.
 const zBody=24+suspension,H=146;
 const eyeShift=2.4*Math.sin(q),blink=1-.86*Math.pow(Math.max(0,Math.cos(q-Math.PI*1.38)),80);
 let screen=rect(8,14,174,111,'#AEB7A5',6,'#748269',1.1)+rect(12,18,166,103,'#59674F',5)+rect(16,22,158,95,'url(#glass)',4.5,'#182411',.7);
 screen+=`<path d="M20 36Q20 26 30 26H163" fill="none" stroke="#86937A" stroke-width="1.2" opacity=".5"/>`;
 screen+=rect(29+eyeShift,59+(1-blink)*5,47,11*blink,C.lime,5.5*blink)+rect(112+eyeShift,59+(1-blink)*5,47,11*blink,C.lime,5.5*blink)+rect(84+eyeShift*.6,81,21,5,C.lime,2.5);
 // Spare, practical front detailing; eyes remain the immediate 48px read.
 screen+=label(20,137,'OFFPEAK',4.5,'#77826D','letter-spacing="1.25"');
 screen+=rect(164,129,11,11,'#8B977D',1,'#7E8A70')+rect(166,131,7,7,C.lime,.5);
 for(const [a,b] of [[5,7],[184,7],[5,138]])screen+=screw(a,b);
 screen+=line([[19,127],[154,127]],'#C2CBB8',.55);
 let side=rect(9,16,88,110,'#CBD3C3',3,'#909F85',.7)+rect(17,30,72,80,'#4B5B41',1.8,'#859578',.6);
 side+=screw(13,21)+screw(92,21)+screw(13,122)+screw(92,122);
 side+=label(20,139,'OP / 001',3.7,'#738568');
 box(-95,-55,zBody,190,110,H,{face:screen,right:side,roof:rect(9,10,172,90,'#A6B29B',2,'#748668',.6)});
 flush();
 // Six real hinged louvers. Their free edges move out of the side wall.
 for(let i=0;i<6;i++){
  const opening=.16+.9*(.5-.5*Math.cos(q-i*.15));
  const zh=zBody+H-32-i*12;
  const zFree=zh-9*Math.cos(opening),xFree=95+9*Math.sin(opening);
  const points=[[95.4,-35,zh],[95.4,30,zh],[xFree,30,zFree],[xFree,-35,zFree]];
  put(points,poly(points,i%2?'#EDF1E8':'#E0E8D9','#8B9C7E',.6),3);
 }
 flush();
 // Raised cooling deck on four visible telescopic pillars.
 const lidZ=zBody+H+5+lidLift;
 for(const xx of [-78,73])for(const yy of [-38,33])box(xx,yy,zBody+H,5,5,5+lidLift,{front:'#E4EAD9',side:'#869879',top:'#FAFCF5'});
 flush();
 let roof=rect(8,8,180,100,'#F2F5ED',3,'#D5DDCC',.55);
 roof+=`<g transform="translate(53 58)">${impeller(t,0)}</g><g transform="translate(143 58)">${impeller(t,30)}</g>`;
 for(const [a,b]of [[10,11],[186,11],[10,105],[186,105]])roof+=screw(a,b);
 for(let i=0;i<5;i++)roof+=rect(86+i*5,25,2,65,'#A2B394',.6);
 box(-98,-58,lidZ,196,116,6,{front:'#E2E8D9',side:'#ABB99E',top:'url(#roofwhite)',roof});
 flush();return neutralise(assembled);
}
  /* ORIGINAL_MODEL_END */
