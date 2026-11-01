import fs from 'node:fs';
import path from 'node:path';
import {buildPages} from './build-pages.mjs';
import {writeNavFigures} from './build-nav-anatomy.mjs';
const root=path.resolve(import.meta.dirname,'..');
const dist=path.resolve(root,'dist');
// This is the disposable build directory, never source or the preserved reference.
if(dist!==path.join(root,'dist')||!dist.startsWith(root+path.sep))throw new Error('Invalid output directory');
console.log('Rebuilding verified output directory:',dist);
fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(path.join(dist,'assets'),{recursive:true});
writeNavFigures();
fs.cpSync(path.join(root,'src/nav-anatomy'),path.join(dist,'assets/nav-anatomy'),{recursive:true});
for(const asset of fs.readdirSync(path.join(root,'src/assets')).filter(f=>/\.(png|svg|mp4|json)$/.test(f)))fs.copyFileSync(path.join(root,'src/assets',asset),path.join(dist,'assets',asset));
for(const name of ['faithful.css','faithful.js','hero-premium.css','hero-premium.js','scenes.css','scenes.js','docs.css','city-interactive.css','city-interactive.js','material-system.css','material-system.js','card-explainers.css','card-explainers.js','reference-scroll.js','reference-motion-data.js','reference-motion.js','reference-dot-field.js','reference-motion.css','scene-choreography.js','surface-interaction.js','isometric-cards.css','isometric-cards.js','workflow-world.css','workflow-world.js','tech-conversation.css','tech-conversation.js','tech-roadmap.css','tech-roadmap.js','gpu-companion.css','gpu-companion.js','nav-isometric.css','nav-isometric.js','research-case.css','approved-logo.css','approved-logo.js','feature-backdrop.css','feature-backdrop.js','cta-cinema.css','cta-cinema.js','nav-collapse.css','nav-collapse.js','ui-icons.css','ui-icons.js'])fs.copyFileSync(path.join(root,'src',name),path.join(dist,'assets',name));
fs.cpSync(path.join(root,'src/reveal-assets'),path.join(dist,'assets/reveal'),{recursive:true,filter:p=>!p.endsWith('.png')&&!p.endsWith('.mjs')});
const homepage=fs.readFileSync(path.join(root,'src/index.html'),'utf8').replace('<!--OFFPEAK_RESEARCH_CASE-->',fs.readFileSync(path.join(root,'src/research-case.html'),'utf8')).replace(/<template\b[^>]*id="scene-[^"]+"[\s\S]*?<\/template>/g,'').replace('<script src="/assets/scenes.js"',fs.readFileSync(path.join(root,'src/scenes.html'),'utf8')+'\n<script src="/assets/scenes.js"');
fs.writeFileSync(path.join(dist,'index.html'),homepage);
// The local console demo (/console/, /app/) is intentionally not shipped. See deploy/block-demo.conf.
for(const name of ['docs']){fs.mkdirSync(path.join(dist,name));fs.copyFileSync(path.join(root,'src',name+'.html'),path.join(dist,name,'index.html'))}
for(const [from,to] of [['root-Dx9Ruach.css','reference.css'],['home-DL54nMDs.css','reference-home.css']])fs.copyFileSync(path.join(root,'reference/assets',from),path.join(dist,'assets',to));
for(const file of fs.readdirSync(path.join(root,'reference/assets')).filter(x=>x.endsWith('.woff2')))fs.copyFileSync(path.join(root,'reference/assets',file),path.join(dist,'assets',file));
fs.cpSync(path.join(root,'src/documents'),path.join(dist,'documents'),{recursive:true});
buildPages(root);
if(fs.existsSync(path.join(root,'src/pages/template-previews')))fs.cpSync(path.join(root,'src/pages/template-previews'),path.join(dist,'template-previews'),{recursive:true});
const aliases={};
for(const [route,target]of Object.entries(aliases)){const folder=path.join(dist,route);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${target}"><title>OFFPEAK</title><a href="${target}">Continue to OFFPEAK</a></html>`)}

// Canonical URLs point at the public domain. Every built page gets one if it lacks it.
const SITE='https://offpeakai.app';
const walkHtml=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walkHtml(path.join(d,e.name)):e.name==='index.html'?[path.join(d,e.name)]:[]);
for(const file of walkHtml(dist)){const rel=path.relative(dist,path.dirname(file)).split(path.sep).join('/');const url=SITE+'/'+(rel?rel+'/':'');let html=fs.readFileSync(file,'utf8');if(!/rel="canonical"/.test(html)&&/<\/head>/i.test(html)){html=html.replace(/<\/head>/i,`<link rel="canonical" href="${url}"></head>`);fs.writeFileSync(file,html)}}
console.log('Built faithful OFFPEAK homepage, restored subpages and documentation (console demo not shipped).');
