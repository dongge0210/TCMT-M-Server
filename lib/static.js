// Tiny static file server for the built-in dashboard (stdlib only).
// Returns true when the request was handled (a file under `root`),
// false when the caller should keep routing (e.g. to the API handler).
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

export function createStatic({ root, prefix = '/dashboard/' }) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (p === prefix.slice(0, -1)) p = prefix; // /dashboard -> /dashboard/
    if (req.method !== 'GET' || !p.startsWith(prefix)) return false;

    const rel = p.slice(prefix.length) || 'index.html';
    const file = path.normalize(path.join(root, rel));
    // Defense in depth: never serve anything outside the dashboard dir.
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return true;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
    return true;
  };
}
