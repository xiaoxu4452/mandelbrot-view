/* ------------------------------------------------------------------
 * _rebuild-web.mjs — replace the remote history with ONE clean commit.
 *
 * The user asked for a rebuild: the repo carried 17,473 embedded desktop
 * files (an old UI copy plus third-party bundles) and months of interim
 * commits.  The local HEAD tree is already clean, and every blob in it is
 * already on GitHub, so the rebuild is: create one parentless commit from
 * the current tree, then force the branch pointer to it.
 *
 *   node tools/_rebuild-web.mjs "commit message"
 * ------------------------------------------------------------------ */
import { execFileSync } from 'node:child_process';

const MESSAGE = process.argv[2] ||
  'Mandelbrot View — the web build (CPU perturbation core, one engine per frame)';

function git(...a) {
  return execFileSync('git', a, { maxBuffer: 256 * 1024 * 1024 }).toString().trim();
}
let CACHED = process.env.GITHUB_TOKEN || '';
function token() {
  if (CACHED) return CACHED;
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
  });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error('no credential for github.com');
  return (CACHED = m[1].trim());
}
async function api(path, init = {}) {
  const r = await fetch('https://api.github.com/repos/xiaoxu4452/mandelbrot-view' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mandelbrot-view-publish',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', `${head}^{tree}`);
console.log(`[local] HEAD ${head.slice(0, 8)}  tree ${tree.slice(0, 8)}`);

const commit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message: MESSAGE, tree, parents: [] })
});
console.log(`[commit] ${commit.sha}  (parents: none — history replaced)`);

await api('/git/refs/heads/main', {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: true })
});
console.log(`[done] main -> ${commit.sha}`);
console.log(`https://github.com/xiaoxu4452/mandelbrot-view/commit/${commit.sha.slice(0, 8)}`);
