// Minimal read-only static file server for local dev (127.0.0.1 only).
// Usage: node DevTools/static-server.js [port]
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8777;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let rel = urlPath.replace(/^\/+/, '');
    if (rel === '') rel = 'DevTools/ground-truth-factory.html';
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
      // no-store: a dev server must never let the browser reuse an old copy.
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end('error');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('Serving ' + ROOT + ' at http://127.0.0.1:' + PORT + '/');
  console.log('Tool: http://127.0.0.1:' + PORT + '/DevTools/ground-truth-factory.html');
});
