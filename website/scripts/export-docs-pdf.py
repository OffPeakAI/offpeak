"""Export docs-md/print/*.html to PDFs with headless Chrome (Playwright).
Usage: python scripts/export-docs-pdf.py <out_dir> [<out_dir> ...]
Run node scripts/build-docs-set.mjs and node scripts/build-offpeak.mjs first (fonts/CSS come from dist/assets)."""
import pathlib, sys, mimetypes
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
names = {'whitepaper': 'OFFPEAK-Whitepaper.pdf', 'roadmap': 'OFFPEAK-Roadmap.pdf', 'holders': 'OFFPEAK-Holders.pdf', 'docs': 'OFFPEAK-Docs.pdf'}
outs = [pathlib.Path(p) for p in sys.argv[1:]] or [root / 'src' / 'documents']
def handler(route):
    path = route.request.url.split('http://op.local', 1)[1].split('?')[0]
    if path.startswith('/assets/'): f = root / 'dist' / path.lstrip('/')
    elif path.startswith('/print/'): f = root / 'docs-md' / path.lstrip('/')
    else: f = None
    if f and f.is_file(): route.fulfill(path=str(f), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
    else: route.fulfill(status=404, body='')
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    pg = b.new_page()
    pg.route('http://op.local/**', handler)
    for key, fn in names.items():
        pg.goto(f'http://op.local/print/{key}.html', wait_until='networkidle')
        pg.evaluate('document.fonts.ready')
        pg.evaluate("document.querySelectorAll('details').forEach(d=>d.open=true)")
        for o in outs:
            o.mkdir(parents=True, exist_ok=True)
            pg.pdf(path=str(o / fn), format='A4', print_background=True, display_header_footer=True,
                   header_template='<span></span>',
                   footer_template='<div style="font-size:8px;color:#71736b;width:100%;padding:0 15mm;display:flex;justify-content:space-between;font-family:Arial"><span>OFFPEAK · Product preview</span><span class="pageNumber"></span></div>',
                   margin={'top': '14mm', 'bottom': '16mm', 'left': '14mm', 'right': '14mm'})
        print('wrote', fn)
    b.close()
