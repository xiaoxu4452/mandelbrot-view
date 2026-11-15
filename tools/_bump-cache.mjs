/* _bump-cache.mjs — raise every local `?v=<n>` so a deploy cannot be served
 * from a stale CDN/browser cache.
 *
 * The page's modules import each other with an explicit version query; the
 * GitHub Pages CDN keeps them for hours.  Bumping the number here is the only
 * reliable way to make a phone that visited yesterday load today's core.
 *
 *   node tools/_bump-cache.mjs            # raise every distinct version by 1
 *   node tools/_bump-cache.mjs 40         # pin every reference to 40
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = process.argv[2] ? Number(process.argv[2]) : null;

const files = [];
for (const f of ['index.html']) files.push(path.join(ROOT, f));
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'wgpu') walk(p); }
    else if (/\.(js|css)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(ROOT, 'js'));
for (const f of fs.readdirSync(path.join(ROOT, 'css'))) {
  if (f.endsWith('.css')) files.push(path.join(ROOT, 'css', f));
}
/* The two GPU modules keep their own version tags in the same namespace. */
for (const f of fs.readdirSync(path.join(ROOT, 'js', 'wgpu'))) {
  if (f.endsWith('.js')) files.push(path.join(ROOT, 'js', 'wgpu', f));
}

const seen = new Map();
let touched = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const out = src.replace(/\?v=(\d+)/g, (m, n) => {
    const next = pin == null ? Number(n) + 1 : pin;
    seen.set(Number(n), next);
    return `?v=${next}`;
  });
  if (out !== src) { fs.writeFileSync(f, out); touched++; }
}
console.log(`[bump] ${touched} files, versions ${JSON.stringify([...seen])}`);
