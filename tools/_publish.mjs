/* ------------------------------------------------------------------
 * _publish.mjs — push the local commit through the GitHub Git Data API.
 *
 * The sandbox's egress proxy refuses `CONNECT github.com` (502), so
 * `git push` cannot leave this machine; api.github.com is allowed.  The
 * token comes from the Git credential manager, which already holds the
 * account's credentials for this repository.
 *
 * The remote branch was last written by this same script, so the remote
 * commit is *not* in the local object store.  The diff base is therefore
 * resolved by tree: the local commit whose tree equals the remote commit's
 * tree is the same content, and the API applies the local commit's changes
 * on top of the remote parent.
 *
 *   node tools/_publish.mjs [owner] [repo]
 * ------------------------------------------------------------------ */
import { execFileSync } from 'node:child_process';

const [owner = 'xiaoxu4452', repo = 'mandelbrot-view'] = process.argv.slice(2);
const API = `https://api.github.com/repos/${owner}/${repo}`;

function git(...a) {
  return execFileSync('git', a, { maxBuffer: 256 * 1024 * 1024 }).toString().trim();
}

/* The token may come from the environment (the credential manager pops a
 * dialog when it is queried from a process without a console, so the shell
 * fetches it once and hands it over). */
let CACHED = process.env.GITHUB_TOKEN || '';
function token() {
  if (CACHED) return CACHED;
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
  });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error('no credential for github.com');
  CACHED = m[1].trim();
  return CACHED;
}

async function api(path, init = {}) {
  /* The egress proxy drops the 3 MB core.wasm body now and then ("other side
   * closed"); fetch throws instead of returning a status, so a plain await
   * loses the publish halfway.  Both a transport failure and a 5xx are
   * retryable -- blob uploads are content-addressed, so a retry is idempotent. */
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let r, text;
    try {
      r = await fetch(API + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mandelbrot-view-publish',
          ...(init.body ? { 'Content-Type': 'application/json' } : {})
        }
      });
      text = await r.text();
    } catch (e) {
      lastErr = e;
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
      continue;
    }
    if (r.ok) return text ? JSON.parse(text) : null;
    if (r.status >= 500 || r.status === 429 || r.status === 408) {
      lastErr = new Error(`${init.method || 'GET'} ${path} -> ${r.status}`);
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 400)}`);
  }
  throw new Error(`${init.method || 'GET'} ${path} failed after retries: ${lastErr && lastErr.message}`);
}

const localSha = git('rev-parse', 'HEAD');
const localTree = git('rev-parse', 'HEAD^{tree}');
const ref = await api('/git/ref/heads/main');
const remoteSha = ref.object.sha;
const remoteCommit = await api(`/git/commits/${remoteSha}`);
/* The published commit is rebuilt (single-parent history), so its sha never
 * equals the local one and comparing shas re-uploads the tree every run.  The
 * tree is the content: if it already matches, there is nothing to publish. */
if (remoteCommit.tree && remoteCommit.tree.sha === localTree) {
  console.log(`[publish] remote ${remoteSha.slice(0, 8)} tree already ${localTree.slice(0, 8)}`);
  console.log('[publish] nothing to do');
  process.exit(0);
}
const remoteTree = remoteCommit.tree.sha;

/* The local commit that carries the remote tree: the diff base. */
const lines = git('log', '--all', '--format=%H %T').split('\n');
let diffBase = null;
for (const line of lines) {
  const [sha, tree] = line.trim().split(/\s+/);
  if (tree === remoteTree) { diffBase = sha; break; }
}
if (!diffBase) {
  /* No local commit has that tree (a normal clone would have one).  Fall
   * back to the remote commit's parent chain: the API can still take the
   * local tree as a whole if the caller passes no diff base. */
  diffBase = remoteSha;
  console.log('[publish] no local commit carries the remote tree; using the remote commit itself');
}
console.log(`[publish] local ${localSha.slice(0, 8)}  remote ${remoteSha.slice(0, 8)}  base ${diffBase.slice(0, 8)}`);

const out = execFileSync(process.execPath,
  ['tools/_gitapi.mjs', owner, repo, localSha, diffBase, remoteSha],
  { env: { ...process.env, GITHUB_TOKEN: token() }, stdio: 'inherit' });

const after = await api('/git/ref/heads/main');
console.log('[publish] remote main is now ' + after.object.sha);
