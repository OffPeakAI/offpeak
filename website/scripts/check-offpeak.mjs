import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../dist');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const files=walk(root),errors=[];
for(const file of files.filter(f=>/\.(html|css|js)$/.test(f))){const text=fs.readFileSync(file,'utf8');if(/\.html$/.test(file)&&/causal|app\.causal|plausible|googletagmanager/i.test(text))errors.push('Legacy identity: '+file);for(const m of text.matchAll(/(?:src|href)=["'](\/[^"'#?]*)(?:[^"']*)["']/g)){const target=path.join(root,m[1]);if(!fs.existsSync(target))errors.push('Missing asset/link '+m[1]+' in '+path.relative(root,file));}}
const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert.equal((index.match(/data-scene="scene-(?:feature|productivity)-/g)||[]).length,11,'11 distinct native scenes');
assert.equal((index.match(/data-faq="/g)||[]).length,9,'9 original FAQ rows');
assert.equal((index.match(/<section/g)||[]).length,11,'10 original homepage sections plus requested research case');
assert.equal((index.match(/data-reveal-object="/g)||[]).length,10,'10 original reveal placements');
const previews=[...new Set([...index.matchAll(/src="(\/template-previews\/[^"\s]+)"/g)].map(m=>m[1]))];
assert.equal(previews.length,18,'18 distinct gallery previews');
for(const route of ['blog','blog/canvas-ai','blog/introducing-mcp','blog/product-design','blog/vibe-design','blog/about-us','blog/billing-records','content-creators','designers','founders','mcp','pricing','privacy','templates','terms','widgets']){
  const page=fs.readFileSync(path.join(root,route,'index.html'),'utf8');
  assert(!/http-equiv="refresh"/i.test(page),'Real page required: '+route);
  assert.equal((page.match(/<h1\b/g)||[]).length,1,'One page heading: '+route);
}
assert(index.includes('Idle GPUs. Open models.'),'Exact approved headline');
assert(index.includes('/assets/city-interactive.js'),'Live transparent interactive city');
if(errors.length)throw new Error(errors.join('\n'));console.log(`Passed: ${files.length} build files and local links, 11 unique scenes, 18 gallery previews, 9 FAQs, 10 reference sections plus research case and 16 real subpages.`);
