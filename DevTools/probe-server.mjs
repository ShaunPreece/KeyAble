#!/usr/bin/env node
// Serves DevTools on http://localhost:<port> for the probe pages (WebHID needs a secure
// context, which localhost is), and takes each finished probe's log: a POST to /log is
// written to DevTools/probe-logs/<name>.txt, so a log reaches the developer with no save
// dialog. Local only: it listens on 127.0.0.1.
//
// Usage: node DevTools/probe-server.mjs [port]   (default 8766)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(DIR, 'probe-logs');
const port = Number(process.argv[2]) || 8766;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/log') {
      const name = (url.searchParams.get('name') || 'probe').replace(/[^\w.-]/g, '_');
      let body = '';
      for await (const chunk of req) body += chunk;
      await mkdir(LOGS, { recursive: true });
      await writeFile(path.join(LOGS, `${name}.txt`), body);
      res.writeHead(204).end();
      return;
    }
    const file = path.join(DIR, path.normalize(url.pathname).replace(/^[\\/]+/, ''));
    if (!file.startsWith(DIR + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Probe server on http://localhost:${port}`));
