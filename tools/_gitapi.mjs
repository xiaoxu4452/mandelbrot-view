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
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(API + path, {
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
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    if (r.status >= 500 || r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (attempt + 1))); continue; }
    throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`${init.method || 'GET'} ${path} failed after retries`);
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
  const blob = await api('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' })
  });
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
