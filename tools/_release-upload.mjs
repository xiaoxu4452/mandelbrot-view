/* ------------------------------------------------------------------
 * _release-upload.mjs — replace the release assets.
 *
 * GitHub refuses an upload whose name already exists, so the old asset is
 * deleted first and the new file uploaded under the same name.  The token
 * comes from the environment (the shell fetches it from the credential
 * manager once) or from the credential manager itself.
 *
 *   node tools/_release-upload.mjs [owner] [repo] [tag]
 * ------------------------------------------------------------------ */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [owner = 'xiaoxu4452', repo = 'mandelbrot-view', tag = 'v1.0.0'] = process.argv.slice(2);
const API = `https://api.github.com/repos/${owner}/${repo}`;
const UPLOAD = `https://uploads.github.com/repos/${owner}/${repo}/releases`;

let CACHED = process.env.GITHUB_TOKEN || '';
function token() {
  if (CACHED) return CACHED;
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
  });
  CACHED = (out.match(/^password=(.*)$/m) || [])[1].trim();
  if (!CACHED) throw new Error('no credential');
  return CACHED;
}

const headers = () => ({
  Authorization: `Bearer ${token()}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'mandelbrot-view-release'
});

/* name on the release  ->  file on disk */
const ASSETS = [
  ['Mandelbrot.View.exe', 'release/Mandelbrot View.exe'],
  ['Mandelbrot-View-src.zip', 'release/Mandelbrot-View-src.zip']
];

const list = await (await fetch(`${API}/releases/tags/${tag}`, { headers: headers() })).json();
if (!list.id) throw new Error('release not found: ' + JSON.stringify(list).slice(0, 200));
console.log(`[release] ${tag} id=${list.id}`);

for (const [name, file] of ASSETS) {
  if (!fs.existsSync(file)) { console.log(`[release] skip (missing) ${file}`); continue; }
  const buf = fs.readFileSync(file);
  const old = (list.assets || []).find(a => a.name === name);
  if (old) {
    const del = await fetch(`${API}/releases/assets/${old.id}`, { method: 'DELETE', headers: headers() });
    console.log(`[release] deleted old ${name} (${old.size} B) -> ${del.status}`);
  }
  const up = await fetch(`${UPLOAD}/${list.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buf.length)
    },
    body: buf
  });
  const text = await up.text();
  if (!up.ok) throw new Error(`upload ${name} -> ${up.status} ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  console.log(`[release] uploaded ${j.name} ${j.size} B  ${j.browser_download_url}`);
}
