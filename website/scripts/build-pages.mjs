import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Copy the editable, reference-shaped OFFPEAK pages into the site build. */
export function buildPages(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const source = path.join(root, 'src', 'pages');
  const destination = path.join(root, 'dist');
  const headerPath = path.join(root, 'src', 'shell-header.html');
  const footerPath = path.join(root, 'src', 'shell-footer.html');
  const header = fs.existsSync(headerPath) ? fs.readFileSync(headerPath, 'utf8') : '<header class="pages-fallback-nav"><a href="/">OFFPEAK</a><a href="/docs/">Read the docs ↗</a></header>';
  const footer = fs.existsSync(footerPath) ? fs.readFileSync(footerPath, 'utf8') : '<footer class="pages-fallback-nav"><a href="/">OFFPEAK</a><a href="/docs/">Product guide ↗</a></footer>';
  let count = 0;
  function copy(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { copy(file); continue; }
      if (entry.name === 'index.html') {
        const out = path.join(destination, path.relative(source, file));
        fs.mkdirSync(path.dirname(out), {recursive: true});
        const html = fs.readFileSync(file, 'utf8').replace('<!--HEADER-->', header).replace('<!--FOOTER-->', footer)
          .replace('</head>', '<link rel="stylesheet" href="/assets/material-system.css"><link rel="stylesheet" href="/assets/isometric-cards.css"><link rel="stylesheet" href="/assets/nav-isometric.css"><link rel="stylesheet" href="/assets/approved-logo.css"><link rel="stylesheet" href="/assets/ui-icons.css"><link rel="stylesheet" href="/assets/nav-collapse.css"></head>')
          .replace('</body>', '<script defer src="/assets/material-system.js"></script><script defer src="/assets/surface-interaction.js"></script><script defer src="/assets/isometric-cards.js"></script><script defer src="/assets/nav-isometric.js"></script><script defer src="/assets/approved-logo.js"></script><script defer src="/assets/ui-icons.js"></script><script defer src="/assets/nav-collapse.js"></script></body>');
        fs.writeFileSync(out, html);
        count++;
      }
    }
  }
  copy(source);
  fs.mkdirSync(path.join(destination, 'assets'), {recursive: true});
  for (const name of ['pages.css', 'pages.js']) fs.copyFileSync(path.join(source, name), path.join(destination, 'assets', name));
  const previews = path.join(source, 'template-previews');
  if (fs.existsSync(previews)) fs.cpSync(previews, path.join(destination, 'template-previews'), {recursive: true});
  console.log(`Restored ${count} OFFPEAK subpages with shared navigation.`);
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildPages();
