import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, {recursive:true});
fs.cpSync(path.join(root, 'reference'), dist, {recursive:true});
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
for (const file of walk(dist).filter(p => p.endsWith('.html'))) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace('</head>', '<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/card-depth.css"></head>');
  html = html.replace('</body>', '<script defer src="/card-depth.js"></script></body>');
  fs.writeFileSync(file, html);
}
// A design study must not send its visitors to the original site's analytics.
const rootModule = path.join(dist, 'assets/root-BgOnUeH5.js');
let js = fs.readFileSync(rootModule, 'utf8');
const begin = js.indexOf('function M(e){');
const end = js.indexOf('var N=', begin);
if (begin < 0 || end < 0) throw new Error('Reference analytics boundary changed');
js = js.slice(0, begin) + 'function M(){return null}' + js.slice(end);
const readyHook='(0,g.useEffect)(()=>{l()},[])';
if(!js.includes(readyHook)) throw new Error('Reference mount boundary changed');
js=js.replace(readyHook,'(0,g.useEffect)(()=>{l();window.causalPageReady=true;window.dispatchEvent(new Event("causal:ready"))},[])');
fs.writeFileSync(rootModule, js);
for (const name of ['card-depth.css','card-depth.js']) fs.copyFileSync(path.join(root,'src',name),path.join(dist,name));
const manifestPath=path.join(root,'.openai/hosting.json');
if(fs.existsSync(manifestPath)) {
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.static={directory:'dist'};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
}
console.log(`Built ${walk(dist).filter(p=>p.endsWith('.html')).length} pages with local assets and card depth.`);
