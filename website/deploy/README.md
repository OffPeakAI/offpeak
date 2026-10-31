# Deploy notes

- Serve `website/dist/` as static files with directory-index support at https://offpeakai.app.
- The console demo (`/console/`, `/app/`) is not built. `block-demo.conf` makes the server return 404 for any `/app*` or `/console*` path, even if old files remain on the host.
- Other hosts: Netlify/Cloudflare Pages `_redirects` equivalent:
  ```
  /app*      /404  404
  /console*  /404  404
  ```
