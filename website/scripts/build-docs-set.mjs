// Renders website/docs-md/*.md into site source pages and docs-md/print/*.html (PDF sources, see scripts/export-docs-pdf.py). Run: node scripts/build-docs-set.mjs
// Then rebuild with node scripts/build-offpeak.mjs. The markdown files are the source of truth.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const md = n => fs.readFileSync(path.join(root, 'docs-md', n), 'utf8');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/\$/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => /^https?:/.test(u) ? `<a class="op-link" href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<a class="op-link" href="${u}">${t}</a>`);
  s = s.replace(/(^|[\s(·])(https?:\/\/[^\s<]+)/g, '$1<a class="op-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/(^|[\s(])(\/documents\/[^\s<]+\.pdf)/g, '$1<a class="op-link" href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/Offpeaky99@atomicmail\.io/g, '<a class="op-link" href="mailto:Offpeaky99@atomicmail.io">Offpeaky99@atomicmail.io</a>');
  return s;
}
const STATES = [['Live', 'live'], ['In testing', 'testing'], ['Planned', 'planned'], ['Later', 'later'], ['Next', 'next'], ['Off', 'off'], ['Not published', 'off'], ['None', 'off']];
function chip(cellHtml, raw) {
  const plain = raw.replace(/\*/g, '').trim();
  for (const [w, c] of STATES) if (plain === w || plain.startsWith(w + ' ') || plain.startsWith(w + '.') || plain.startsWith(w + ',')) return `<span class="op-state op-state--${c}">${cellHtml}</span>`;
  return cellHtml;
}
const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
/** Minimal markdown: headings, paragraphs, lists, tables, quotes, code, rules. */
function render(src) {
  const lines = src.split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim() || /^---+$/.test(l.trim())) { i++; continue; }
    if (l.startsWith('```')) { const buf = []; i++; while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]); i++; out.push(`<figure class="docs-code"><pre><code>${esc(buf.join('\n'))}</code></pre></figure>`); continue; }
    const h = /^(#{1,3}) (.*)$/.exec(l);
    if (h) { out.push({level: h[1].length, text: h[2]}); i++; continue; }
    if (l.startsWith('|')) { const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]); const head = cells(rows[0]); const body = rows.slice(2).map(cells);
      out.push(`<div class="docs-table-wrap"><table><thead><tr>${head.map(c => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map((c, j) => j === 0 ? `<th scope="row">${inline(c)}</th>` : `<td>${chip(inline(c), c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue; }
    if (l.startsWith('> ')) { const buf = []; while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^> ?/, '')); out.push(`<div class="docs-note op-trust"><p>${inline(buf.join(' '))}</p></div>`); continue; }
    if (/^(- |\d+\. )/.test(l)) { const ordered = /^\d+\. /.test(l); const items = []; while (i < lines.length && /^(- |\d+\. )/.test(lines[i])) items.push(lines[i++].replace(/^(- |\d+\. )/, ''));
      const tag = ordered ? 'ol' : 'ul'; out.push(`<${tag} class="op-list">${items.map(x => `<li>${inline(x)}</li>`).join('')}</${tag}>`); continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(#|\||> |- |\d+\. |```)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out;
}
function page({file, route, kicker, pdf, extra = {}}) {
  const blocks = render(md(file));
  const title = blocks.find(b => b.level === 1).text;
  let intro = [], sections = [], cur = null;
  for (const b of blocks) {
    if (typeof b === 'object' && b.level === 1) continue;
    if (typeof b === 'object' && b.level === 2) { cur = {title: b.text, id: extra.ids?.[b.text] || slug(b.text), body: []}; sections.push(cur); continue; }
    const html = typeof b === 'object' ? `<h3>${inline(b.text)}</h3>` : b;
    (cur ? cur.body : intro).push(html);
  }
  for (const s of sections) if (extra.inject?.[s.title]) s.body.push(extra.inject[s.title]);
  // The first intro paragraph that begins with bold status text becomes the status note.
  intro = intro.map((x, k) => k === 0 && extra.lead ? x.replace('<p>', '<p class="docs-lead">') : x);
  const nav = sections.map(s => `<a href="#${s.id}">${inline(s.title)}</a>`).join('');
  const links = [['/whitepaper/', 'Whitepaper'], ['/roadmap/', 'Roadmap'], ['/holders/', 'Holder one-pager'], ['/docs/', 'Docs']].filter(([u]) => u !== route)
    .map(([u, t]) => `<a class="docs-source-link" href="${u}">${t} <span aria-hidden="true">→</span></a>`).join('');
  const main = `<main id="docs-main" class="op-docset-main">
<section id="overview" class="docs-section docs-intro"><span class="docs-status"><span aria-hidden="true"></span> Product preview · In development</span><h1>${inline(title)}</h1>${intro.join('\n')}<p class="op-pdf-row"><a class="docs-button" href="${pdf}" target="_blank" rel="noopener">Download PDF <span aria-hidden="true">↓</span></a></p></section>
${sections.map(s => `<section id="${s.id}" class="docs-section">${route === '/roadmap/' ? chip('<span class="docs-tiny-label op-phase-label">' + esc(s.title.split(' (')[0].toUpperCase()) + '</span>', s.title) : ''}<h2>${inline(s.title)}</h2>${s.body.join('\n')}</section>`).join('\n')}
</main>`;
  const aside = `<aside class="docs-sidebar"><p class="docs-kicker">${kicker}</p><nav aria-label="On this page">${nav}</nav><a class="docs-source-link" href="${pdf}" target="_blank" rel="noopener">Download PDF <span aria-hidden="true">↓</span></a>${links}</aside>`;
  return {title, body: `<div class="docs-layout">${aside}${main}</div>`, print: `<article class="op-print">${main.replace(/<p class="op-pdf-row">[\s\S]*?<\/p>/, '')}</article>`};
}
const head = (title, desc) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} · OFFPEAK</title><meta name="description" content="${desc}"><link rel="icon" href="/assets/offpeak-white-mark.svg"><link rel="stylesheet" href="/assets/reference.css"><link rel="stylesheet" href="/assets/reference-home.css"><link rel="stylesheet" href="/assets/faithful.css"><link rel="stylesheet" href="/assets/pages.css"><link rel="stylesheet" href="/assets/docs.css"></head>`;
const defs = [
  {file: 'WHITEPAPER.md', route: '/whitepaper/', dir: 'whitepaper', kicker: 'WHITEPAPER', pdf: '/documents/OFFPEAK-Whitepaper.pdf', desc: 'How OFFPEAK works: off-peak priced open-model inference on Robinhood Chain, settled in USDG.', extra: {}},
  {file: 'ROADMAP.md', route: '/roadmap/', dir: 'roadmap', kicker: 'ROADMAP', pdf: '/documents/OFFPEAK-Roadmap.pdf', desc: 'What is live, in testing, next and later for OFFPEAK.', extra: {}},
  {file: 'HOLDERS.md', route: '/holders/', dir: 'holders', kicker: 'FOR HOLDERS', pdf: '/documents/OFFPEAK-Holders.pdf', desc: 'OFFPEAK and $OFPK in one page: what it is, token status, catalysts and official links.', extra: {lead: true}},
];
const printDir = path.join(root, 'docs-md', 'print'); fs.mkdirSync(printDir, {recursive: true});
const printShell = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · OFFPEAK</title><link rel="stylesheet" href="/assets/reference.css"><link rel="stylesheet" href="/assets/docs.css"><link rel="stylesheet" href="/print/docs-set-print.css"></head><body class="docs-page op-print-body"><header class="op-print-head"><img src="/assets/offpeak-wordmark.svg" alt="OFFPEAK" width="116" height="26"><span>${title} · Product preview</span></header>${inner}<footer class="op-print-foot">OFFPEAK · Product preview · In development. Third-party names describe compatibility only; no affiliation.</footer></body></html>`;
for (const d of defs) {
  const p = page(d);
  const html = `${head(p.title, d.desc)}<body class="offpeak-page op-docset-page"><!--HEADER--><div class="docs-page op-docset">${p.body}</div><!--FOOTER--></body></html>\n`;
  fs.mkdirSync(path.join(root, 'src/pages', d.dir), {recursive: true});
  fs.writeFileSync(path.join(root, 'src/pages', d.dir, 'index.html'), html);
  fs.writeFileSync(path.join(printDir, d.dir + '.html'), printShell(p.title, p.print));
}
// /docs/ keeps its standalone documentation shell and the twelve v1.0 gates.
const gates = fs.readFileSync(path.join(root, 'src/docs-gates.html'), 'utf8');
const dp = page({file: 'DOCS.md', route: '/docs/', kicker: 'DOCS', pdf: '/documents/OFFPEAK-Docs.pdf', extra: {ids: {'Core features': 'features', 'Pricing and billing': 'billing'}}});
const withGates = dp.body.replace(/(<h3>Pilot acceptance gates[\s\S]*?<\/p>)<div class="docs-table-wrap">[\s\S]*?<\/table><\/div>/, `$1${gates}`);
const docsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="OFFPEAK docs: getting started, core features, pricing and billing, FAQ and how to get help.">
  <meta name="robots" content="noindex,nofollow">
  <title>Docs · OFFPEAK</title>
  <link rel="icon" href="/assets/offpeak-white-mark.svg">
  <link rel="stylesheet" href="/assets/reference.css">
  <link rel="stylesheet" href="/assets/docs.css">
  <link rel="stylesheet" href="/assets/pages.css">
  <link rel="stylesheet" href="/assets/material-system.css">
  <script defer src="/assets/material-system.js"></script>
  <script defer src="/assets/surface-interaction.js"></script>
<link rel="stylesheet" href="/assets/isometric-cards.css"><script defer src="/assets/isometric-cards.js"></script><link rel="stylesheet" href="/assets/approved-logo.css"></head>
<body class="docs-page op-docset">
  <a class="docs-skip" href="#overview">Skip to docs</a>
  <header class="docs-header">
    <a class="docs-brand" href="/" aria-label="OFFPEAK home"><span class="docs-brand-mark approved-logo" aria-hidden="true"><img src="/assets/offpeak-white-mark.svg" alt="" width="40" height="40"></span><img class="docs-brand-type" src="/assets/offpeak-wordmark.svg" alt="OFFPEAK" width="116" height="26"></a>
    <nav aria-label="Primary navigation"><a href="/">Home</a><a href="/whitepaper/">Whitepaper</a><a href="/roadmap/">Roadmap</a><a href="/holders/">Holders</a><a class="docs-button" href="/whitepaper/">Read the whitepaper <span aria-hidden="true">↗</span></a></nav>
  </header>
  ${withGates}
  <footer class="docs-footer"><a class="docs-brand" href="/" aria-label="OFFPEAK home"><img class="docs-brand-type" src="/assets/offpeak-wordmark.svg" alt="OFFPEAK" width="116" height="26"></a><nav class="op-docs-footer-links" aria-label="Footer"><a href="/whitepaper/">Whitepaper</a><a href="/roadmap/">Roadmap</a><a href="/holders/">Holders</a><a href="/docs/">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms status</a></nav><a href="#overview">Back to top <span aria-hidden="true">↑</span></a></footer>
<script defer src="/assets/approved-logo.js"></script></body>
</html>
`;
fs.writeFileSync(path.join(root, 'src/docs.html'), docsHtml);
fs.writeFileSync(path.join(printDir, 'docs.html'), printShell(dp.title, dp.print.replace(/(<h3>Pilot acceptance gates[\s\S]*?<\/p>)<div class="docs-table-wrap">/, '$1<div class="docs-table-wrap">')));
console.log('Rendered whitepaper, roadmap, holders and docs pages from docs-md/.');
