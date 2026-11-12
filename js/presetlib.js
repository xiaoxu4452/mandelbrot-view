/* ------------------------------------------------------------------
 * presetlib.js — the preset library, seen from the page.
 *
 * The library is *embedded*: `presets-data.js` holds every entry as a full
 * reference-shaped object, generated at build time from the original program's
 * own `examples/*.json`.  Nothing is scanned, nothing is read from disk, and
 * the same module serves the desktop shell, the browser build and the tests.
 *
 * Why embedded rather than a folder of JSON files:
 *
 *   - a preset is data the program owns, not a user document; it ships with
 *     the binary and cannot go missing or be half-updated;
 *   - the language switch is a field swap (`name` / `nameZh`) instead of a
 *     re-read of the folder;
 *   - opening a card is a lookup, not a message round trip, so the grid can
 *     thumbnail itself immediately.
 *
 * Import and export still speak the reference program's JSON — a file the user
 * imports lands in "mine", and export writes the same shape back out.  The
 * only non-reference key we add is `ramp` (a hand-edited gradient), which the
 * reference program ignores.
 * ------------------------------------------------------------------ */
import { PRESET_LIB } from './presets-data.js';
import { MORE_LIB, SET_LIB } from './sets-data.js';
import { importRefPreset, exportRefPreset, defaultRefColors,
         readColors, readGlobals } from './refpreset.js';
import { registerAdditivePalette } from './palettes.js';

const USER_KEY = 'mb.userPresets.v1';

export const LIB = {
  dir: '',            // empty: the library is built in
  items: [],          // one entry per preset, compact
  count: 0,
  ready: true,
  native: false
};

const listeners = [];
const objById = new Map();     // id -> the full reference-shaped object
const paletteIds = new Map();  // id -> registered additive palette id

/** Subscribe to library changes (an import, a save, a delete). */
export function onLibrary(cb) {
  listeners.push(cb);
  if (LIB.ready) cb(LIB);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}
function emit() { for (const cb of listeners.slice()) cb(LIB); }

/* ---- index -------------------------------------------------------------- */

/**
 * Compact entry for one preset.
 *
 * The card grid only needs a name pair, a category, a mode and enough numbers
 * to frame a thumbnail; the full object stays in `objById` so opening a card is
 * a lookup rather than a parse.
 */
function itemOf(obj, forceCat) {
  const p = obj.parameters || {};
  const g = readGlobals(p);
  /* readParams resets to INITIALCOLORS before applying the file, so a
   * thumbnail must use the *resolved* table, not a literal copy of `colors`
   * (eight shipped presets omit `rgb` on purpose). */
  const cols = readColors(p);
  const julia = !!(obj.flags && obj.flags.julia) ||
                Number(p.juliamode) === 2 ||
                !!(obj.spec && obj.spec.mode === 'j');
  return {
    f: obj.id,
    n: obj.name || obj.id,
    nz: obj.nameZh || obj.name || obj.id,
    c: forceCat || obj.category || 'reference',
    m: julia ? 'j' : 'm',
    /* `zo` drives the card's framing and its iteration budget, so it has to be
     * the same decade the view opens at (see showZoom). */
    x: obj.x, y: obj.y, zo: obj.showZoom != null ? obj.showZoom : obj.zoom,
    bf: g.briFinite, bi: g.briInfinite,
    /* The file's global log-frequency / phase travel with the table: the
     * thumbnail applies exp(f_i + F) exactly like the main render does. */
    cf: g.frequency, ci: g.initial,
    /* [r,g,b,frequency,initial] — the shape the thumbnail palette wants. */
    col: cols.map(c => [c.r, c.g, c.b, c.frequency, c.initial]),
    cg: !!(p.colorscheme && String(p.colorscheme.codegl || '').trim()),
    an: !!obj.animation,
    obj
  };
}

function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(o => o && o.id) : [];
  } catch {
    return [];
  }
}

function saveUser(list) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(list));
  } catch (e) {
    /* Quota or a locked profile: the preset still applies for this session,
     * it just will not be there next time.  Reporting it through the return
     * value is the caller's cue to say so. */
    return false;
  }
  return true;
}

function rebuild() {
  const user = loadUser();
  objById.clear();
  LIB.items = PRESET_LIB.map(o => { objById.set(o.id, o); return itemOf(o); });
  /* The 200 cards this program authored.  They join the same two tabs the
   * reference's own pictures live in — there is no third category: a card is
   * either a Mandelbrot or a Julia, exactly like the files it sits beside.
   * Same patch shape, same loader, same thumbnails, so a card that opens takes
   * the identical code path as the reference's own JSON. */
  for (const o of MORE_LIB) {
    objById.set(o.id, o);
    LIB.items.push(itemOf(o, o.flags && o.flags.julia ? 'j' : 'm'));
  }
  /* The families beside Mandelbrot and Julia: tricorn, burning ship, celtic,
   * perpendicular and the higher multibrots.  They sit in their own tab
   * because the *shape* is the point — a tricorn card filed under
   * "Mandelbrot" would just look like a wrong Mandelbrot.  Same loader, same
   * thumbnail path, so a card opens exactly like any other. */
  for (const o of SET_LIB) {
    objById.set(o.id, o);
    LIB.items.push(itemOf(o, 'other'));
  }
  for (const o of user) {
    objById.set(o.id, o);
    LIB.items.push(itemOf(o, 'mine'));
  }
  LIB.count = LIB.items.length;
}

rebuild();

/* ---- reading ------------------------------------------------------------ */

export function find(id) {
  return LIB.items.find(it => it.f === id) || null;
}

/** The parsed object for an id.  Synchronous by construction. */
export function readObject(id) {
  const o = objById.get(id);
  return o ? Promise.resolve(o) : Promise.reject(new Error('no preset ' + id));
}

/* ---- the view a preset describes --------------------------------------- */

/**
 * Everything the app needs in order to *open* a preset: where to look, through
 * which formula, with which colours.  The colours come back in both forms the
 * renderer understands — the additive `colors` table (which is what the file
 * actually stores) and, when the file carries one, its GLSL scheme.
 */
export function patchOf(obj) {
  const p = importRefPreset(obj);
  const cs = (obj.parameters && obj.parameters.colorscheme) || {};
  return {
    mode: p.mode || 'm',
    center: p.center,
    span: p.span,
    rotation: p.rotation,
    julia: p.julia,
    juliaView: p.juliaView,
    juliaSeed: p.juliaSeed,
    /* readParams (005472c0) resets params->color[] to INITIALCOLORS on every
     * load, so a file with no `colors` key still has the three-term default
     * table — it does not inherit the palette of the previously opened view. */
    colors: (p.colors && p.colors.length) ? p.colors : defaultRefColors(),
    /* Global log-frequency / phase from the file (00546630.c:79/:87).
     * They travel with the raw colour table; without them exp() would be
     * applied against the program's default and the palette would drift. */
    colorFreq: p.colorFreq,
    colorInit: p.colorInit,
    briFinite: p.briFinite,
    briInfinite: p.briInfinite,
    briFactor: p.briFactor,
    glsl: p.glsl || '',
    hlsl: p.hlsl || '',
    schemeName: p.schemeName || cs.name || '',
    /* A file that only *names* a built-in scheme (Example 5 asks for "Distance
     * and iteration levels" and ships no source) still has to reach that
     * shader; the name is what the app resolves it by. */
    schemeBuiltin: p.schemeBuiltin || '',
    nparam: p.nparam,
    samples: p.samples,
    channels: p.channels,
    auxfile: p.auxfile || '',
    builtin: p.builtin,
    param: p.param,
    inverse: p.inverse === true || (obj.flags && obj.flags.inverse === true),
    juliamode: p.juliamode,
    juliaDock: p.juliaDock,
    initialZoom: p.initialZoom,
    realmFlags: p.realmFlags,
    animation: p.animation || null,
    /* Our own extension: an edited gradient ramp.  The reference format has no
     * ramp, and rewriting one as a sum of sinusoids is lossy, so a hand-edited
     * ramp travels as itself and the reference program simply ignores it. */
    ramp: Array.isArray(obj.ramp)
      ? obj.ramp.map(c => ({ pos: +c[0], r: +c[1], g: +c[2], b: +c[3] }))
      : null,
    name: obj.name || '',
    nameZh: obj.nameZh || '',
    category: obj.category || '',
    id: obj.id || '',
    /* Our own extension: the formula a card renders.  The reference's files are
     * all z^2 + c and carry nothing to say so; the other-set cards must, or
     * they open as a Mandelbrot view of another set's coordinates. */
    spec: obj.spec || null
  };
}

export function loadPatch(id) { return readObject(id).then(patchOf); }

/* ---- thumbnails --------------------------------------------------------- */

/**
 * Palette id a card's thumbnail should render with, registering the preset's
 * own additive table on first use.
 *
 * A shader-based preset cannot be thumbnailed by the CPU path, but its `colors`
 * table is still a faithful first approximation — and a card is a hint, not a
 * picture.  Opening the preset always uses the shader.
 */
export function thumbPalette(item) {
  if (paletteIds.has(item.f)) return paletteIds.get(item.f);
  const cols = (item.col || []).map(c => ({
    r: c[0], g: c[1], b: c[2], frequency: c[3], initial: c[4]
  }));
  if (!cols.length) return null;
  const id = 'lib:' + item.f;
  registerAdditivePalette(id, cols, item.bf, item.bi, item.n || item.f,
                          { gf: item.cf, gi: item.ci });
  paletteIds.set(item.f, id);
  return id;
}

/* ---- writing ------------------------------------------------------------ */

/**
 * Build the reference-shaped object for the current view.
 *
 * Every field the reference can express is written, including the ones that are
 * not visible in the picture (the Julia view and seed are recorded even from a
 * Mandelbrot view, exactly as the shipped files do).  Anything we add is
 * additive: a file written here is still loadable by the original program, and
 * our own `format`/`name`/`ramp` keys are ignored by it.
 */
export function buildObject(view) {
  const obj = exportRefPreset({
    center: view.center,
    span: view.span,
    rotation: view.rotation,
    julia: view.julia,
    juliaView: view.juliaView,
    mode: view.mode,
    colors: view.colors,
    colorFreq: view.colorFreq,
    colorInit: view.colorInit,
    briFinite: view.briFinite,
    briInfinite: view.briInfinite,
    briFactor: view.briFactor != null ? view.briFactor : 1,
    inverse: view.inverse,
    glsl: view.glsl || '',
    hlsl: view.hlsl || '',
    schemeName: view.schemeName || undefined,
    samples: view.samples,
    nparam: view.nparam,
    channels: view.channels,
    auxfile: view.auxfile,
    builtin: view.builtin,
    param: view.param,
    juliamode: view.juliamode,
    realmFlags: view.realmFlags,
    initialZoom: view.initialZoom,
    animation: view.animation
  });
  obj.format = 'retinamandelbrot/preset-1';
  obj.id = view.id || slug(view.name || 'preset');
  if (view.name) obj.name = view.name;
  if (view.nameZh) obj.nameZh = view.nameZh;
  obj.category = view.category || 'user';
  if (Array.isArray(view.ramp) && view.ramp.length) {
    obj.ramp = view.ramp.map(c => [
      Math.round(+(c.pos != null ? c.pos : c[0]) * 1000) / 1000,
      +(c.r != null ? c.r : c[1]), +(c.g != null ? c.g : c[2]),
      +(c.b != null ? c.b : c[3])
    ]);
  }
  return obj;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
}

/** A unique id for a user preset, derived from its title. */
function uniqueId(obj) {
  const base = obj.id || slug(obj.name || 'preset');
  const used = new Set(loadUser().map(o => o.id));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Store a preset in "mine".
 *
 * `id` names an existing user preset to overwrite; anything else gets a fresh
 * id.  Built-in entries are never modified — saving over one writes a copy,
 * which is what "save as" means and keeps the shipped library immutable.
 */
export function savePreset(obj, id, title, cb) {
  const user = loadUser();
  const rec = JSON.parse(JSON.stringify(obj));
  if (title) { rec.name = title; rec.nameZh = rec.nameZh || title; }
  const at = id ? user.findIndex(o => o.id === id) : -1;
  if (at >= 0) {
    rec.id = id;
    user[at] = rec;
  } else {
    rec.id = uniqueId({ ...rec, id: id || rec.id });
    user.unshift(rec);
  }
  const ok = saveUser(user);
  rebuild();
  emit();
  if (cb) cb({ ok, name: rec.id });
  return true;
}

/** Remove a user preset.  A built-in one is refused, not silently ignored. */
export function deletePreset(id, cb) {
  const user = loadUser();
  const at = user.findIndex(o => o.id === id);
  if (at < 0) {
    if (cb) cb({ ok: false, name: id, builtin: true });
    return false;
  }
  user.splice(at, 1);
  const ok = saveUser(user);
  paletteIds.delete(id);
  rebuild();
  emit();
  if (cb) cb({ ok, name: id });
  return true;
}

/** Re-index (after an import).  Always immediate; there is nothing to scan. */
export function refresh() {
  rebuild();
  emit();
  return true;
}

/** Kept for the panel's "folder" button, which the embedded library has not. */
export function revealFolder() { return false; }

/* ---- animation --------------------------------------------------------- */

/**
 * Evaluate a preset's `animation` block at normalised time `t` (0..1).
 *
 * Zoom is interpolated geometrically: a linear interpolation of a zoom factor
 * spends most of its time in the last few percent, which reads as a lurch at
 * the end.  Everything else is linear, and the centre is interpolated per
 * component in the same decimal space the file uses.
 */
export function sampleAnimation(anim, t) {
  if (!anim || !Array.isArray(anim.keys) || !anim.keys.length) return null;
  const keys = anim.keys.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const tt = anim.loop === false ? Math.min(1, Math.max(0, t)) : ((t % 1) + 1) % 1;
  let i = 0;
  while (i < keys.length - 1 && tt > (keys[i + 1].t != null ? keys[i + 1].t : 1)) i++;
  const a = keys[i];
  const b = keys[Math.min(i + 1, keys.length - 1)];
  const ta = a.t != null ? a.t : 0;
  const tb = b.t != null ? b.t : 1;
  const f = tb > ta ? Math.min(1, Math.max(0, (tt - ta) / (tb - ta))) : 1;
  const ease = anim.easing === 'linear' ? f : f * f * (3 - 2 * f);

  const lerp = (u, v) => (u == null ? v : v == null ? u : u + (v - u) * ease);
  const zoom = (() => {
    const za = Number(a.zoom), zb = Number(b.zoom);
    if (!isFinite(za) || !isFinite(zb) || za <= 0 || zb <= 0) return null;
    return Math.exp(Math.log(za) + (Math.log(zb) - Math.log(za)) * ease);
  })();
  return {
    x: Number(lerp(Number(a.x), Number(b.x))),
    y: Number(lerp(Number(a.y), Number(b.y))),
    zoom,
    rotation: lerp(a.rotation, b.rotation),
    offset: lerp(a.offset, b.offset)
  };
}

/** How many presets there are — the number the badge shows. */
export function libraryCount() { return LIB.count; }
