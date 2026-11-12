import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
for (const [mode, port] of [['old', 43171], ['new', 43172]]) {
  const root = resolve('apps/web', `dist-migrate-${mode}`);
  createServer(async (req, res) => {
    if (req.url === '/seed') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Migration test storage setup</title>'); return; }
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, `.${name === '/' ? '/index.html' : name}`);
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const data = await readFile(path);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(path)] ?? 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  }).listen(port, () => process.stdout.write(`${mode}: http://localhost:${port}\n`));
}
