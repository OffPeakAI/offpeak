import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const dist=path.join(root,'dist');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'capture-manifest.json'),'utf8'));
const issues=[];
for(const route of manifest.pages){
 const page=path.join(dist,route,'index.html');
 if(!fs.existsSync(page)){issues.push(`Missing page ${route}`);continue;}
 const html=fs.readFileSync(page,'utf8');
 for(const match of html.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|webp|png|woff2|svg))(?:[?#][^"]*)?"/g)) {
  if(!fs.existsSync(path.join(dist,match[1]))) issues.push(`Missing ${match[1]} on ${route}`);
 }
 if(!html.includes('/card-depth.js')) issues.push(`Enhancement missing on ${route}`);
 for(const match of html.matchAll(/srcSet="([^"]+)"/gi)) {
  for(const candidate of match[1].split(',')) {
   const url=candidate.trim().split(/\s+/)[0];
   if(url.startsWith('/')&&!fs.existsSync(path.join(dist,url))) issues.push(`Missing responsive image ${url}`);
  }
 }
}
if(manifest.failures.length) issues.push('Reference download failures remain');
if(issues.length){console.error(issues.join('\n'));process.exit(1);}
console.log(`Verified ${manifest.pages.length} pages and ${manifest.files.length} captured assets.`);
