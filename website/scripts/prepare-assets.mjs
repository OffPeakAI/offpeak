import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Copy the user's latest OFFPEAK artwork without altering its illustration.
// The optional source-root argument makes this handoff portable.
const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(here, '../src/assets');
const sourceRoot = path.resolve(process.argv[2] || 'source-assets/outputs');
await fs.mkdir(destination, { recursive: true });

const manifest = {
  brand: 'OFFPEAK',
  revision: '2026-10-13 current toon / isometric identity',
  accent: '#CCFF00',
  notes: [
    'Exact existing artwork is copied byte for byte. No generative replacements or raster edits.',
    'Banner and mascot use the latest toon treatment; the five current technology studies retain their original detailed industrial illustration.',
    'All illustrations depict product concepts. Receipt checks show inclusion/signatures, not proof of correct computation or metering.',
    'Commercial font binaries are not redistributed. Existing supplied brand lettering is reused as vector outlines.',
    'Six small interface icons are native SVG drawings created for this adaptation, using neutral isometric hardware and the same neon accent.'
  ],
  files: []
};

async function record(name, data, metadata) {
  await fs.writeFile(path.join(destination, name), data);
  manifest.files.push({ file: name, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), ...metadata });
}
async function copy(source, name, usage, dimensions) {
  await record(name, await fs.readFile(path.join(sourceRoot, source)), { source, method: 'exact byte-for-byte copy', usage, ...(dimensions ? { dimensions } : {}) });
}

await copy('offpeak-toon-pfp/source/center-computer.png', 'offpeak-mark.png', 'Header, footer, introductory hero mark, favicon source; transparent exact latest CRT.', [759, 704]);
await copy('offpeak-center-banner-toon/left-bot.png', 'offpeak-bot-left.png', 'Small accompanying isometric box bot; transparent.', [155, 166]);
await copy('offpeak-center-banner-toon/right-bot.png', 'offpeak-bot-right.png', 'Small accompanying isometric round bot; transparent.', [155, 183]);
await copy('offpeak-center-banner-toon/hero-assets.png', 'offpeak-hero-assets.png', 'Wide group of three exact current characters; transparent.', [2172, 724]);
await copy('offpeak-center-banner-toon/offpeak-center-banner-toon.mp4', 'offpeak-banner.mp4', 'Wide 3:1 animated character group with wordmark, six seconds, silent.', [1500, 500]);
await copy('offpeak-center-banner-toon/offpeak-center-banner-toon.png', 'offpeak-banner.png', 'Static / reduced-motion alternative for wide character group.', [1500, 500]);

const scenes = [
  ['01-night-shift', 'capacity', 'Spare GPU capacity, open-model routing and provider supply.'],
  ['02-price-lock', 'quote', 'A capacity-based quote, fixed once accepted.'],
  ['03-spend-guard', 'authorize', 'Signed per-call authorization and spending caps.'],
  ['04-pay-what-runs', 'meter', 'Usage metering, charged usage and release of unused balance.'],
  ['05-private-receipts', 'receipt', 'Private receipts, public roots, signature / inclusion checks.']
];
for (const [sourceName, name, meaning] of scenes) {
  await copy(`offpeak-x-series/${sourceName}-base.png`, `offpeak-${name}-base.png`, `${meaning} Text-free source illustration.`, [1254, 1254]);
  await copy(`offpeak-x-series/${sourceName}.mp4`, `offpeak-${name}.mp4`, `${meaning} Finished 6-second silent animated concept.`, [1024, 1024]);
  await copy(`offpeak-x-series/${sourceName}.png`, `offpeak-${name}-poster.png`, `${meaning} Finished poster / reduced-motion fallback.`, [1024, 1024]);
}

const headlineSource = 'offpeak-center-banner-toon/source/offpeak-headline.json';
const headline = JSON.parse(await fs.readFile(path.join(sourceRoot, headlineSource), 'utf8'));
for (const [name, fill] of [['offpeak-wordmark.svg', '#242523'], ['offpeak-wordmark-light.svg', '#F2F2F2']]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${headline.width} ${headline.height}" role="img" aria-labelledby="wordmark-title"><title id="wordmark-title">OFFPEAK</title><path fill="${fill}" fill-rule="nonzero" d="${headline.path_data}"/></svg>\n`;
  await record(name, Buffer.from(svg), { source: headlineSource, method: 'Exact existing Nuixyber wordmark path, tight viewBox and accessible title', usage: name.includes('light') ? 'Wordmark on dark surfaces.' : 'Wordmark on light surfaces.' });
}

// Small functional illustrations. Shared camera, case materials, linework and accent
// make them companions to the existing hardware without pretending they are 3D renders.
const G = '#CCFF00', INK = '#242A2C', SCREEN = '#151A1B', TOP = '#92999A', SIDE = '#646D70', FRONT = '#424C50';
const n = x => Number(x.toFixed(2));
const p = (x, y, z = 0) => [n(160 + (x - y) * .88), n(190 + (x + y) * .43 - z)];
const pts = arr => arr.map(q => q.join(',')).join(' ');
const poly = (arr, fill, stroke = INK, extra = '') => `<polygon points="${pts(arr)}" fill="${fill}" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" ${extra}/>`;
function block(x, y, z, w, d, h, colors = {}) {
  return poly([p(x,y+d,z),p(x+w,y+d,z),p(x+w,y+d,z+h),p(x,y+d,z+h)], colors.front || FRONT)
    + poly([p(x+w,y,z),p(x+w,y+d,z),p(x+w,y+d,z+h),p(x+w,y,z+h)], colors.side || SIDE)
    + poly([p(x,y,z+h),p(x+w,y,z+h),p(x+w,y+d,z+h),p(x,y+d,z+h)], colors.top || TOP);
}
function front(x,y,z,w,h,content) {
  const [tx,ty] = p(x,y,z);
  return `<g transform="matrix(.88 .43 0 1 ${tx} ${ty})">${content}</g>`;
}
const rect = (x,y,w,h,fill,r=2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const line = (d,color=G,width=3,extra='') => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const base = () => block(-70,-47,0,140,94,12,{top:'#778184',side:'#414B4F',front:'#30393D'});
function vents(x,y,z,w,count=5) { let out=''; for(let i=0;i<count;i++) out+=poly([p(x,y+i*5,z),p(x+w,y+i*5,z),p(x+w,y+i*5+1.8,z),p(x,y+i*5+1.8,z)], '#2B3438','#2B3438'); return out; }
function fan(w,h) {
  let out=`<ellipse cx="${w/2}" cy="${h/2}" rx="${w*.35}" ry="${h*.34}" fill="${SCREEN}" stroke="#899396" stroke-width="1.2"/>`;
  for(let i=0;i<5;i++) out+=`<g transform="translate(${w/2} ${h/2}) scale(${w*.34/24} ${h*.30/24})"><path d="M0 0 C-5 -20 8 -24 14 -15 C8 -8 5 -3 0 0" fill="#505B5F" transform="rotate(${i*72})"/></g>`;
  return out+`<circle cx="${w/2}" cy="${h/2}" r="4" fill="#778285" stroke="${INK}"/>`;
}
function capacity() {
  let out=base();
  for(const [x,y,h] of [[-48,-25,59],[-5,-25,83],[38,-25,48]]) {
    out+=block(x,y,12,29,35,h)+vents(x+4,y+3,12+h,21,4);
    out+=front(x,y+35,12+h,29,h,rect(3,7,23,h-13,SCREEN)+fan(29,h)+rect(4,h-7,5,3,G));
  }
  return out;
}
function quote() {
  let out=base()+block(-51,-25,12,84,46,82)+vents(-43,-20,94,65,5);
  out+=front(-46,21,87,73,66,rect(0,0,73,66,SCREEN,4)+line('M12 45 A25 25 0 0 1 62 45','#717C7F',3)+line('M37 45 L53 18',G,3)+`<circle cx="37" cy="45" r="5" fill="${G}"/>`+line('M12 56H61','#4D595D',2));
  out+=block(36,-5,12,23,30,40)+front(39,25,45,17,27,rect(0,0,17,27,SCREEN)+line('M3 13l4 4 8-11',G,2.5));
  return out;
}
function authorize() {
  let out=base()+block(-48,-21,12,15,37,85)+block(31,-21,12,15,37,85)+block(-48,-21,82,94,37,15);
  out+=front(-43,16,87,5,68,rect(0,0,5,67,G,1))+front(34,16,87,5,68,rect(0,0,5,67,G,1));
  out+=block(-21,8,12,32,28,21,{top:G,front:'#7B981D',side:'#A3C82A'});
  out+=block(-58,32,12,25,20,37)+front(-55,52,44,19,25,rect(0,0,19,25,SCREEN)+line('M3 12l4 4 8-11',G,2.5));
  return out;
}
function meter() {
  let out=base()+block(-43,-25,12,85,37,83)+vents(-34,-18,95,64,4);
  let screen=rect(0,0,71,52,SCREEN,3);
  for(let i=0;i<6;i++) screen+=rect(7+i*10,16,6,22,i<4?G:'#3A4748',1);
  screen+=line('M8 44H62','#687477',1.5);
  out+=front(-36,12,83,71,52,screen);
  out+=block(-48,23,12,40,28,5,{top:'#283237'})+block(5,23,12,42,28,5,{top:'#283237'});
  out+=block(-37,30,17,12,12,5,{top:G,side:'#A3C82A',front:'#7B981D'})+block(17,30,17,12,12,5,{top:G,side:'#A3C82A',front:'#7B981D'});
  return out;
}
function withdraw() {
  let out=base()+block(-53,-27,12,46,38,55)+vents(-47,-21,67,32,4);
  out+=front(-47,11,59,34,36,rect(0,0,34,36,SCREEN,3)+line('M7 13H25M7 20H25M7 27H17',G,2.5));
  out+=block(23,18,12,36,27,14,{top:'#2D383C'});
  out+=block(30,22,26,22,17,5,{top:G,side:'#A3C82A',front:'#7B981D'});
  const a=p(-2,5,50),b=p(45,5,50); out+=line(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`,G,6);
  out+=line(`M${b[0]-12} ${b[1]-12}L${b[0]} ${b[1]}L${b[0]-15} ${b[1]+1}`,G,5);
  return out;
}
function receipt() {
  let out=base()+block(-52,-25,12,32,38,54)+vents(-47,-20,66,22,4);
  out+=front(-46,13,58,20,40,rect(0,0,20,40,SCREEN)+rect(6,7,7,25,G,1));
  out+=block(-12,-25,12,62,50,67)+vents(-5,-20,79,46,4);
  out+=front(-5,25,70,48,33,rect(0,0,48,33,SCREEN,3)+line('M24 7V14M11 14H37M11 14V22M37 14V22',G,1.8)+rect(19,4,10,6,G,1)+rect(6,22,10,6,G,1)+rect(32,22,10,6,G,1));
  out+=front(4,25,29,34,48,rect(-3,-3,40,8,'#111617',2)+`<path d="M0 0H34V30L27 38H-7L0 30Z" fill="#E3E7E4" stroke="${INK}" stroke-width="1.5"/>`+line('M6 9H26M6 16H26M6 23H20','#89948E',1.3));
  return out;
}
for(const [name, render] of Object.entries({ capacity, quote, authorize, meter, withdraw, receipt })) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 256" role="img" aria-labelledby="icon-title"><title id="icon-title">OFFPEAK ${name}</title><ellipse cx="160" cy="224" rx="105" ry="15" fill="#172123" opacity=".10"/>${render()}</svg>\n`;
  await record(`offpeak-icon-${name}.svg`,Buffer.from(svg),{source:'scripts/prepare-assets.mjs',method:'Native vector interface illustration',usage:`Small ${name} interface/card icon. Transparent background.`,dimensions:[320,256]});
}

await fs.writeFile(path.join(destination,'offpeak-assets-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(path.join(destination,'OFFPEAK-ASSETS.txt'),
`OFFPEAK artwork\n\nExact current artwork copied from the user's 2026-10-13 graphics handoff.\nAccent #CCFF00; neutral gray hardware and charcoal screens.\n\n*-base.png: text-free 1254px source illustrations.\n*.mp4: silent 6-second loops.\n*-poster.png: finished static alternatives.\nThe square scenes include social headlines. To fit a website card without duplicating its heading, display the illustration band (roughly y=230..920 of the 1024px square) inside an overflow-hidden slot; do not stretch it.\n\nThe wordmark uses exact Nuixyber vector outlines. Font binaries are not bundled.\nSix small icon SVGs are original native vector drawings from prepare-assets.mjs; they follow the existing neutral hardware, isometric camera and lime accent.\n\nProvenance, usages, sizes and SHA-256 hashes are in offpeak-assets-manifest.json.\nRebuild with: node scripts/prepare-assets.mjs [path-to-original-usi-outputs]\n`);
console.log(`Prepared ${manifest.files.length} OFFPEAK assets in ${destination}`);
