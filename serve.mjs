// Local preview of dist/ with clean URLs, matching production behavior.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.PORT || 8090);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '');
  const candidates = !path || path === '.' ? ['index.html'] : extname(path) ? [path] : [`${path}.html`];
  for (const candidate of candidates) {
    try {
      const data = await readFile(join(root, candidate));
      res.writeHead(200, { 'content-type': types[extname(candidate)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(data);
    } catch {}
  }
  res.writeHead(404, { 'content-type': types['.html'] });
  res.end(await readFile(join(root, '404.html')));
}).listen(port, () => console.log(`http://localhost:${port}`));
