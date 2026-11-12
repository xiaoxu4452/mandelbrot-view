/* ------------------------------------------------------------------
 * sync-desktop-ui.mjs — copy the web UI into the desktop snapshot.
 *
 * The desktop exe embeds `src/ui/` (see tools/gen-ui-resources.mjs): it never
 * reads the web app's js/ tree.  That snapshot used to be a *fork* of the web
 * UI, which meant every web fix had to be applied twice — and the two copies
 * drifted apart badly enough that the desktop was still running the worker
 * that writes its tile at 64 KiB, straight into the wasm shadow stack.
 *
 * So the snapshot is now a copy with a handful of desktop-only parameters
 * re-applied on top.  Those are the whole delta:
 *
 *   - renderScale 2 instead of 1: the desktop window is a retina surface and
 *     a 1x buffer looks soft next to the shell's own compositing.
 *   - one worker when the native shell is in charge (the C++ pool owns the
 *     CPU; a second pool would fight it) and a conservative cap otherwise.
 *   - REMOTE_MAX fixed at 24: the out-of-browser core is a local service, and
 *     24 queued jobs is already more than it can answer.
 *
 * The default palette is deliberately NOT re-applied: the web moved it to ice
 * because that is the scheme the renderer was tuned against, and a violet
 * first frame made every new session look wrong.
 *
 * Usage: node tools/sync-desktop-ui.mjs [--check]
 * ------------------------------------------------------------------ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  path.join(ROOT, 'Meter Mandelbrot', 'src', 'ui'),
  path.join(ROOT, 'desktop', 'src', 'ui')
];
const CHECK = process.argv.includes('--check');

/* [search, replace, note] — each must apply exactly once. */
const DELTAS = [
  ['  renderScale: 1,', '  renderScale: 2,', 'retina buffer'],
  ['  const n = NATIVE ? 1 : clamp(cores - 1, 2, 32);',
   '  const n = NATIVE ? 1 : clamp((navigator.hardwareConcurrency || 4) - 1, 2, 8);',
   'worker count'],
  ['const REMOTE_MAX = Math.max(8, Math.min(32, (navigator.hardwareConcurrency || 4) - 1));',
   'const REMOTE_MAX = 24;', 'remote queue cap'],
  ['  let dpr = Math.max(1, Math.min(2, +state.renderScale || 1));',
   '  let dpr = Math.max(1, Math.min(2, +state.renderScale || 2));',
   'dpr fallback']
];

function patchApp(text, file) {
  let out = text;
  for (const [from, to, note] of DELTAS) {
    const n = out.split(from).length - 1;
    if (n !== 1) {
      throw new Error(`${file}: delta "${note}" matched ${n} times (expected 1): ${from}`);
    }
    out = out.replace(from, to);
  }
  return out;
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) { copyTree(s, d); continue; }
    if (!/\.(js|css|html|json|png|jpg|svg|wasm)$/i.test(name)) continue;
    fs.copyFileSync(s, d);
  }
}

let changed = 0, same = 0;
for (const target of TARGETS) {
  if (!fs.existsSync(target)) { console.log('[sync] skip (missing) ' + target); continue; }
  // js/
  const jsSrc = path.join(ROOT, 'js'), jsDst = path.join(target, 'js');
  fs.mkdirSync(jsDst, { recursive: true });
  for (const name of fs.readdirSync(jsSrc)) {
    if (!/\.(js|json)$/i.test(name)) continue;
    let text = fs.readFileSync(path.join(jsSrc, name), 'utf8');
    if (name === 'app.js') text = patchApp(text, name);
    const dst = path.join(jsDst, name);
    const old = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
    if (old === text) { same++; continue; }
    if (CHECK) { console.log('[sync] would update ' + path.relative(ROOT, dst)); changed++; continue; }
    fs.writeFileSync(dst, text);
    changed++;
  }
  // css/ + index.html
  const cssSrc = path.join(ROOT, 'css'), cssDst = path.join(target, 'css');
  if (fs.existsSync(cssSrc)) copyTree(cssSrc, cssDst);
  const idx = path.join(ROOT, 'index.html');
  if (fs.existsSync(idx)) {
    const dst = path.join(target, 'index.html');
    const text = fs.readFileSync(idx, 'utf8');
    const old = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
    if (old !== text) {
      if (CHECK) { console.log('[sync] would update ' + path.relative(ROOT, dst)); changed++; }
      else { fs.writeFileSync(dst, text); changed++; }
    } else same++;
  }
}
console.log(CHECK ? `[sync] check: ${changed} file(s) differ` : `[sync] ${changed} updated, ${same} already current`);
