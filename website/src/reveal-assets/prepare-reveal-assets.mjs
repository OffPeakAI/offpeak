import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const C={ink:'#343A36',muted:'#929A93',line:'#E6EBE4',soft:'#F7F9F5',accent:'#B8CC7E',green:'#7F9555'};
const text=(x,y,s,size=10,color=C.ink,extra='')=>`<text x="${x}" y="${y}" font-family="Manrope,Inter,Segoe UI,Arial,sans-serif" font-size="${size}" fill="${color}" ${extra}>${s}</text>`;
const mono=(x,y,s,size=9,color=C.muted,extra='')=>`<text x="${x}" y="${y}" font-family="SFMono-Regular,Consolas,monospace" font-size="${size}" fill="${color}" ${extra}>${s}</text>`;
const line=(d,color=C.line,width=1,extra='')=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const rect=(x,y,w,h,fill='#fff',r=3,stroke='none',extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
const dot=(x,y,r=2,color=C.accent)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;
const check=(x,y,color=C.green)=>line(`M${x} ${y+3}l3 3 6-7`,color,1.35);
const card=(w,h,body)=>`<g filter="url(#paper-shadow)">${rect(10,8,w-20,h-24,'#fff',10,'#E7EBE4')}</g>${body}`;
const head=(s,w)=>`${dot(28,29,2.2)}${text(38,32,s,9.5,C.ink,'font-weight="500"')}${line(`M24 45H${w-24}`)}`;
function svg(w,h,title,body){return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title"><title id="title">${title}</title><defs><filter id="paper-shadow" x="-15%" y="-15%" width="130%" height="150%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#27332B" flood-opacity=".065"/></filter><linearGradient id="chip" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FAFCF8"/><stop offset="1" stop-color="#EAF0E6"/></linearGradient></defs>${body}</svg>\n`;}

const assets=[];
function add(name,w,h,title,body,meaning){assets.push({file:`offpeak-reveal-${name}.svg`,width:w,height:h,title,meaning,svg:svg(w,h,title,body)});}

// A small model record with an understated package/chip symbol.
let model=head('Open model',204);
model+=`<g transform="translate(102 86)">${rect(-23,-23,46,46,'url(#chip)',8,'#CBD5C4')}${rect(-13,-13,26,26,'#fff',4,'#DDE5D5')}`;
for(let i=0;i<4;i++){const d=-13+i*8.7;model+=line(`M${d} -29v6M${d} 23v6M-29 ${d}h6M23 ${d}h6`,'#BECAB6',1.3);}
model+=`${line('M-7 0h14M0-7v14',C.green,1.3)}</g>`;
model+=`${text(102,135,'Ready for inference',10,C.ink,'text-anchor="middle"')}${text(102,151,'One familiar API.',8,C.muted,'text-anchor="middle"')}`;
add('model',204,180,'Open model',card(204,180,model),'An open model available through one inference API.');

// Quote slip: no fabricated rate or operating statistic.
let quote=head('Accepted quote',184)+text(27,67,'RATE',7,C.muted,'letter-spacing="1.4"');
quote+=text(27,91,'Locked for this call',11.5,C.ink,'font-weight="500"')+line('M26 107H158',C.line,1,'stroke-dasharray="2 3"');
quote+=text(27,128,'Input tokens',8.7,C.muted)+text(157,128,'fixed',8.7,C.ink,'text-anchor="end"');
quote+=text(27,148,'Output tokens',8.7,C.muted)+text(157,148,'fixed',8.7,C.ink,'text-anchor="end"');
quote+=rect(25,165,134,23,'#F3F7EC',5)+check(36,176)+text(52,181,'Accepted',8.5,C.green);
add('quote',184,218,'Accepted quote slip',card(184,218,quote),'A quote fixed when the user accepts it.');

// Authorization: a fine-line key accompanies a one-call signature.
let auth=head('Authorize a call',234);
auth+=`<g transform="translate(36 70)"><circle cx="12" cy="12" r="10" fill="#F3F7ED" stroke="#BECBB1"/>${dot(12,12,3,'#B8C69E')}${line('M22 12h42m-10 0v7m-10-7v5','#88977A',1.7)}</g>`;
auth+=text(120,79,'Spend cap',8,C.muted)+text(120,96,'You set the limit.',10,C.ink);
auth+=line('M27 118H207')+mono(28,132,'wallet signature',8.2,C.muted)+check(195,126);
add('authorization',234,157,'Wallet signature and spend cap',card(234,157,auth),'A signed authorization grants one call within a chosen cap.');

// Meter: unnumbered usage bars avoid implying live performance.
let usage=head('Metered usage',242);
usage+=line('M29 121H213')+line('M29 76H213',C.line,.7,'stroke-dasharray="2 4"')+line('M29 98H213',C.line,.7,'stroke-dasharray="2 4"');
[17,24,21,36,32,46,56,50,61,66].forEach((v,i)=>{usage+=rect(34+i*17,121-v,8,v,i===8?C.accent:'#DDE5D7',2);});
usage+=text(29,143,'Pay for what runs.',9,C.ink)+dot(208,140,2,C.accent);
add('usage',242,174,'Metered token usage',card(242,174,usage),'Measured token usage determines the charge.');

// Receipt paper with a small signature trace and a folded corner.
let receipt=`<g filter="url(#paper-shadow)"><path d="M20 8H132L154 30V205l-7-4-7 4-7-4-7 4-7-4-7 4-7-4-7 4-7-4-7 4-7-4-7 4-7-4-7 4-7-4-7 4-7-4-7 4V8Z" fill="#fff" stroke="#E4EAE1"/><path d="M132 8v22h22" fill="#F3F6EF" stroke="#E4EAE1"/></g>`;
receipt+=dot(36,34,2)+text(46,37,'Private receipt',9,C.ink,'font-weight="500"')+line('M34 51H138');
receipt+=text(34,73,'CALL RECORD',6.5,C.muted,'letter-spacing="1.2"');
receipt+=line('M34 87H126', '#CCD5C6',2)+line('M34 100H113','#DDE4D8',2)+line('M34 113H123','#DDE4D8',2);
receipt+=line('M34 133H138',C.line,1,'stroke-dasharray="2 3"')+text(34,151,'Signed',8.2,C.muted);
receipt+=line('M38 177c4-3 7-17 9-14s-4 20 0 18 7-19 10-16-7 18-2 15 8-11 10-6 5-8 7-3 10 0 14-3', '#8C9A81',1.2);
receipt+=dot(130,177,8,'#F3F7EB')+check(126,177);
add('receipt',174,230,'Private receipt with signature',receipt,'A compact private record with signature verification.');

// A few spare blocks with very shallow isometric faces, no heavy hardware.
let capacity=head('Available capacity',212);
const cube=(x,y,active)=>`<path d="M${x} ${y}l18-9 18 9-18 9Z" fill="${active?'#DDE8CA':'#EFF3E9'}" stroke="#CFD9C6"/><path d="M${x} ${y}l18 9v18l-18-9Z" fill="#E5EDDE" stroke="#CFD9C6"/><path d="M${x+18} ${y+9}l18-9v18l-18 9Z" fill="${active?'#C9D9B2':'#DDE7D4'}" stroke="#CFD9C6"/>`;
capacity+=cube(104,75,false)+cube(62,75,false)+cube(83,100,true);
capacity+=text(106,148,'Idle compute, useful again.',8.4,C.muted,'text-anchor="middle"');
add('capacity',212,180,'Available compute capacity',card(212,180,capacity),'Spare compute capacity made available to model requests.');

// Prompt note uses three quiet text lines and one meaningful label.
let prompt=`<g filter="url(#paper-shadow)">${rect(10,8,204,137,'#FCFDF9',9,'#E5EBDD')}</g>`;
prompt+=rect(25,22,47,18,'#F1F5E9',4)+mono(32,34,'prompt',8.2,C.green)+mono(197,34,'01',7.5,'#B3BAAC','text-anchor="end"');
prompt+=text(26,68,'Summarize this document.',10.6,C.ink)+text(26,85,'Keep the key decisions.',10.6,C.ink);
prompt+=line('M26 104H182','#E1E8D9',1.5)+line('M26 116H142','#E1E8D9',1.5)+`<path d="M185 125h10m-4-4 4 4-4 4" fill="none" stroke="#A2B789" stroke-linecap="round" stroke-linejoin="round"/>`;
add('prompt',224,163,'Prompt note',prompt,'A simple input prompt, kept separate from billing and authorization.');

// Response is a compact structured-message object rather than a stock symbol.
let response=head('Structured response',246);
response+=mono(27,65,'{',10,'#9AA491')+mono(38,86,'"role"',9,'#89977B')+mono(83,86,': "assistant",',9,C.ink);
response+=mono(38,105,'"content"',9,'#89977B')+mono(101,105,': [',9,C.ink);
response+=rect(52,116,129,5,'#E0E8D8',2)+rect(52,130,99,5,'#E9EEE3',2);
response+=mono(38,153,']',9,C.ink)+mono(27,171,'}',10,'#9AA491')+dot(215,168,2.1,C.accent);
add('response',246,198,'Structured model response',card(246,198,response),'The model returns a structured response through the compatible API.');

for(const a of assets)await fs.writeFile(path.join(root,a.file),a.svg);
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({style:'Quiet native SVG product symbols; neutral paper, hairlines, restrained muted-lime details.',placement:'Mixed-size floating items around centered about paragraph, using original Causal media-item geometry. Do not arrange as a grid.',files:assets.map(({svg,...rest})=>rest)},null,2)+'\n');
console.log('Wrote '+assets.length+' restrained OFFPEAK reveal assets.');
