// Zero-dependency static build: wraps src/pages/*.html in src/layout.html,
// expands {{> partial}} includes, and writes the finished site to the repo root,
// which is what the host serves. Commit the generated files along with the sources.
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const dist = new URL('./', import.meta.url);

cpSync(new URL('./public/', import.meta.url), dist, { recursive: true });

// Fingerprint CSS/JS so they can be cached for a year and still update on deploy.
const version = createHash('sha1')
  .update(read('./public/assets/site.css') + read('./public/assets/site.js'))
  .digest('hex')
  .slice(0, 10);

const expand = (html) =>
  html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => expand(read(`./src/partials/${name}.html`)));

const layout = read('./src/layout.html');

for (const file of readdirSync(new URL('./src/pages/', import.meta.url))) {
  const raw = read(`./src/pages/${file}`);
  const match = raw.match(/^<!--(\{[\s\S]*?\})-->\r?\n/);
  if (!match) throw new Error(`${file}: missing metadata comment`);
  const meta = JSON.parse(match[1]);
  const body = expand(raw.slice(match[0].length));
  const slug = file.replace(/\.html$/, '');
  const url = slug === 'index' ? 'https://ignitedevelopment.net/' : `https://ignitedevelopment.net/${slug}`;

  const html = expand(layout)
    .replaceAll('{{title}}', meta.title)
    .replaceAll('{{desc}}', meta.desc)
    .replaceAll('{{url}}', url)
    .replaceAll('{{v}}', version)
    .replace('{{robots}}', meta.noindex ? '<meta name="robots" content="noindex">' : '')
    .replace('{{endcta}}', meta.noCta ? '' : expand('{{> endcta}}'))
    .replace(/\{\{cur:(\w+)\}\}/g, (_, n) => (n === slug ? ' aria-current="page"' : ''))
    .replace('{{body}}', body)
    // Link straight to clean URLs so production never spends a redirect on .html.
    .replace(/href="index\.html"/g, 'href="/"')
    .replace(/href="(\w+)\.html(#[\w-]+)?"/g, 'href="/$1$2"')
    .replace(/(href|src)="assets\//g, '$1="/assets/');

  writeFileSync(new URL(file, dist), html);
}

console.log(`Built ${readdirSync(new URL('./src/pages/', import.meta.url)).length} pages to the repo root (v${version})`);
