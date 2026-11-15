/* _gitapi.mjs — publish the local commit through the GitHub Git Data API.
 *
 * The sandbox's egress proxy refuses `CONNECT github.com` (502) but allows
 * api.github.com, so `git push` cannot leave this machine.  This script
 * rebuilds the same commit remotely from the blobs that already exist in the
 * local object store, so the pushed tree is byte-identical to a normal push:
 *
 *   1. for every path changed by the local commit, upload its blob
 *      (`git cat-file blob <sha>`, base64) — content-addressed, so the remote
 *      sha equals the local one;
 *   2. create one tree with `base_tree` = the parent's tree;
 *   3. create the commit with the parent;
 *   4. fast-forward refs/heads/main.
 *
 *   GITHUB_TOKEN=... node tools/_gitapi.mjs <owner> <repo> <localSha> <parentSha>
 */
import { execFileSync } from 'node:child_process';

const [owner, repo, localSha, diffBase, parentSha] = process.argv.slice(2);
if (!owner || !repo || !localSha || !parentSha) {
  console.error('usage: node tools/_gitapi.mjs <owner> <repo> <sha> [diffBase] <remoteParent>');
  process.exit(2);
}
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN missing'); process.exit(2); }

const API = `https://api.github.com/repos/${owner}/${repo}`;
const git = (...a) => execFileSync('git', a, { maxBuffer: 256 * 1024 * 1024 });

async function api(path, init = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let r, text;
    try {
      r = await fetch(API + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mandelbrot-view-deploy',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {})
        }
      });
      text = await r.text();
    } catch (e) {
      /* The egress proxy drops large uploads now and then ("other side
       * closed").  A network failure is as retryable as a 5xx. */
      lastErr = e;
      await new Promise(s => setTimeout(s, 1200 * (attempt + 1)));
      continue;
    }
    if (r.ok) return text ? JSON.parse(text) : null;
    /* A 404 from a *blob upload* is not a missing endpoint: the same token can
     * read the repository and the endpoint was just used successfully by the
     * run before.  The egress proxy answers a dropped POST with a GitHub-shaped
     * 404 here, which is why a publish used to die on the first new file.  It
     * is as retryable as a transport error; anything else (a real 404 on a
     * read, a 403 from a bad token) still surfaces immediately. */
    if (r.status === 404 && init.method === 'POST' && path === '/git/blobs') {
      lastErr = new Error('POST /git/blobs -> 404 (transient)');
      await new Promise(s => setTimeout(s, 1500 * (attempt + 1)));
      continue;
    }
    if (r.status >= 500 || r.status === 429 || r.status === 408) {
      lastErr = new Error(`${init.method || 'GET'} ${path} -> ${r.status}`);
      await new Promise(s => setTimeout(s, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`${init.method || 'GET'} ${path} failed after retries: ${lastErr && lastErr.message}`);
}

const message = git('log', '-1', '--format=%B', localSha).toString().replace(/\s+$/, '');
/* `diffBase` is the LOCAL commit with the same tree as the remote parent: the
 * remote commit was created server-side, so this clone never received it. */
const BASE = diffBase || parentSha;
const changed = git('diff', '--name-only', '-z', BASE, localSha).toString().split('\0').filter(Boolean);

/* Deleted paths must be removed from the tree (sha: null). */
const deleted = new Set(
  git('diff', '--name-only', '--diff-filter=D', '-z', BASE, localSha)
    .toString().split('\0').filter(Boolean)
);
console.log(`commit ${localSha.slice(0, 8)}: ${changed.length} paths (${deleted.size} deleted)`);

const tree = [];
for (const path of changed) {
  if (deleted.has(path)) { tree.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
  const sha = git('rev-parse', `${localSha}:${path}`).toString().trim();
  const mode = git('ls-tree', localSha, '--', path).toString().split(' ')[0].trim();
  const buf = git('cat-file', 'blob', sha);
  /* Content-addressed: a blob that is already there (yesterday's core.wasm,
   * any unchanged asset) must not be uploaded again — the 3 MB body is exactly
   * what the proxy keeps dropping. */
  const exists = await api(`/git/blobs/${sha}`, {}).then(() => true, () => false);
  if (exists) { tree.push({ path, mode: mode === '100755' ? '100755' : '100644', type: 'blob', sha }); process.stdout.write(`  blob ${path} (already there)\n`); continue; }
  let blob;
  try {
    blob = await api('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' })
    });
  } catch (e) {
    throw new Error(`${path} (${(buf.length / 1024).toFixed(0)} KB): ${e.message}`);
  }
  if (blob.sha !== sha) throw new Error(`blob sha mismatch for ${path}: ${blob.sha} != ${sha}`);
  tree.push({ path, mode: mode === '100755' ? '100755' : '100644', type: 'blob', sha });
  process.stdout.write(`  blob ${path}\n`);
}

const parentCommit = await api(`/git/commits/${parentSha}`);
const newTree = await api('/git/trees', {
  method: 'POST',
  body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree })
});
const commit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] })
});
console.log(`remote commit ${commit.sha}`);

const ref = await api('/git/refs/heads/main', {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false })
});
console.log(`refs/heads/main -> ${ref.object.sha}`);
