/* _finalize-repo.mjs — one-shot repo finalizer.
 *
 * State after the v2 deploy: remote main (096f42b4) already serves the new
 * app but still carries the legacy/ engine files, and its tree hash has no
 * local counterpart (GitHub normalised something), so a diff-based push
 * cannot resolve a base. Every BLOB of the local HEAD tree, however, already
 * exists on the remote (uploaded with the v2 publish).
 *
 * This script therefore rebuilds the remote history from scratch:
 *   1. `git ls-tree -r HEAD` gives the full entry list of the final tree;
 *   2. POST /git/trees with that flat list (no base_tree) — content
 *      addressed, so the resulting tree sha equals the local one;
 *   3. POST /git/commits { tree, parents: [] } — one clean parentless commit;
 *   4. PATCH refs/heads/main (force).
 *
 *   node tools/_finalize-repo.mjs "commit message"
 */
import { execFileSync } from 'node:child_process';

const MESSAGE = process.argv[2] ||
  'Mandelbrot View v2 — the compiled desktop core as a web app';

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

const treeSha = git('rev-parse', 'HEAD^{tree}');
  const entries = git('ls-tree', '-r', 'HEAD').split('\n')
  .filter(Boolean)
  .map((line) => {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/.exec(line);
    if (!m) throw new Error('bad ls-tree line: ' + line);
    return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
  })
  .filter((e) => e.type === 'blob');   // -r still lists directory trees; paths imply them
console.log(`[local] HEAD tree ${treeSha.slice(0, 8)}  ${entries.length} entries`);

/* Upload every blob (content-addressed: re-uploading an existing one is a
 * no-op that returns the same sha). */
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
let uploaded = 0;
for (const e of entries) {
  /* Raw bytes — no toString()/trim(): a stripped trailing newline changes
   * the content hash, which is exactly how the remote tree drifted from the
   * local one in the first place. */
  const raw = execFileSync('git', ['cat-file', 'blob', e.sha], { maxBuffer: 64 * 1024 * 1024 });
  const body = raw.toString('base64');
  const r = await api('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: body, encoding: 'base64' })
  });
  if (r.sha !== e.sha) throw new Error(`blob sha mismatch for ${e.path}: ${r.sha} != ${e.sha}`);
  uploaded++;
  await sleep(250);
}
console.log(`[blobs] ${uploaded} uploaded (content-addressed)`);

const tree = await api('/git/trees', {
  method: 'POST',
  body: JSON.stringify({ tree: entries })
});
console.log(`[tree] ${tree.sha}  (local twin: ${treeSha.slice(0, 8)})`);

const commit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message: MESSAGE, tree: tree.sha, parents: [] })
});
console.log(`[commit] ${commit.sha}  (parents: none — history replaced)`);

await api('/git/refs/heads/main', {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: true })
});
console.log(`[done] main -> ${commit.sha}`);
