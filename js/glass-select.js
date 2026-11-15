/* ==========================================================
   Self-drawn glass select
   -----------------------------------------------------------
   The OS draws the pop-up of a native <select>; that layer cannot be
   frosted or themed.  So the native control is demoted to a pure data
   model (kept in the DOM, invisible, still carrying .value/.onchange for
   all existing code) and this module draws every visible pixel:

     · frosted trigger (chevron rotates while open)
     · portal pop-up, fixed-positioned so the scrolling console cannot clip
     · blur + translucency + rounded corners + fade-in (see app.css)
     · hover and keyboard highlight share one `.active` state
     · ArrowUp/Down/Home/End/Enter/Esc/Tab, click-outside to close
     · light & dark via the existing --dd-* design tokens

   Programmatic writes stay in sync because the `value` setter is
   instrumented and option rebuilds are watched by a MutationObserver.
   ========================================================== */

const entries = new Map();      // <select> -> { sel, btn, label }
let pop = null;                 // shared portal pop-up
let openEntry = null;
let activeIndex = -1;           // index into the *option* list
let items = [];                 // rendered option buttons, parallel to options

function ensurePop() {
  if (pop) return;
  pop = document.createElement('div');
  pop.className = 'gsel-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'listbox');
  document.body.appendChild(pop);
}

function sync(entry) {
  const sel = entry.sel;
  const opt = sel.options[sel.selectedIndex];
  entry.label.textContent = opt ? opt.textContent.trim() : '';
  entry.btn.title = entry.label.textContent;
  entry.btn.disabled = !!sel.disabled;
  if (openEntry === entry) rebuild(entry);
}

function rebuild(entry) {
  const sel = entry.sel;
  pop.textContent = '';
  items = [];
  activeIndex = -1;
  let group = null;
  for (let i = 0; i < sel.options.length; i++) {
    const opt = sel.options[i];
    const parent = opt.parentNode;
    if (parent && parent.tagName === 'OPTGROUP' && parent !== group) {
      group = parent;
      const head = document.createElement('div');
      head.className = 'gsel-group';
      head.textContent = parent.label || '';
      pop.appendChild(head);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gsel-item' + (i === sel.selectedIndex ? ' on' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
    b.dataset.idx = String(i);
    b.textContent = opt.textContent.trim();
    b.addEventListener('click', () => choose(entry, i));
    pop.appendChild(b);
    items.push(b);
  }
  setActive(sel.selectedIndex, false);
}

function setActive(i, scroll = true) {
  activeIndex = i;
  items.forEach((b, k) => b.classList.toggle('active', k === i));
  const b = items[i];
  if (b && scroll) {
    const top = b.offsetTop, bottom = top + b.offsetHeight;
    if (top < pop.scrollTop) pop.scrollTop = top - 6;
    else if (bottom > pop.scrollTop + pop.clientHeight) pop.scrollTop = bottom - pop.clientHeight + 6;
  }
}

function place(entry) {
  const r = entry.btn.getBoundingClientRect();
  const w = Math.max(r.width, 176);
  pop.style.width = w + 'px';
  pop.style.left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - w - 8)) + 'px';
  pop.hidden = false;
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const h = Math.min(pop.scrollHeight + 12, 300);
  if (below >= h || below >= above) {
    pop.style.maxHeight = Math.min(300, Math.max(90, below)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  } else {
    pop.style.maxHeight = Math.min(300, Math.max(90, above)) + 'px';
    pop.style.top = (r.top - 6 - Math.min(h, Math.max(90, above))) + 'px';
  }
}

function openPopup(entry) {
  ensurePop();
  if (openEntry === entry) { closePopup(); return; }
  closePopup();
  openEntry = entry;
  rebuild(entry);
  entry.btn.classList.add('open');
  entry.btn.setAttribute('aria-expanded', 'true');
  place(entry);
}

function closePopup() {
  if (!openEntry) return;
  openEntry.btn.classList.remove('open');
  openEntry.btn.setAttribute('aria-expanded', 'false');
  openEntry = null;
  pop.hidden = true;
  pop.textContent = '';
  items = [];
  activeIndex = -1;
}

function choose(entry, i) {
  const sel = entry.sel;
  if (i >= 0 && i < sel.options.length) {
    sel.selectedIndex = i;
    // Native selects fire `change`; every call site in app.js listens to it.
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  sync(entry);
  closePopup();
  entry.btn.focus();
}

function onDocKey(e) {
  if (!openEntry) return;
  const n = items.length;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault(); e.stopPropagation();
      if (n) setActive((activeIndex + 1) % n);
      break;
    case 'ArrowUp':
      e.preventDefault(); e.stopPropagation();
      if (n) setActive((activeIndex - 1 + n) % n);
      break;
    case 'Home':
      e.preventDefault(); e.stopPropagation();
      if (n) setActive(0);
      break;
    case 'End':
      e.preventDefault(); e.stopPropagation();
      if (n) setActive(n - 1);
      break;
    case 'Enter':
    case ' ':
      e.preventDefault(); e.stopPropagation();
      if (activeIndex >= 0) choose(openEntry, activeIndex);
      break;
    case 'Escape':
      e.preventDefault(); e.stopPropagation();
      {
        const entry = openEntry;
        closePopup();
        entry.btn.focus();
      }
      break;
    case 'Tab':
      closePopup();
      break;
    default:
      break;
  }
}

function onDocPointer(e) {
  if (!openEntry) return;
  if (pop.contains(e.target) || openEntry.btn.contains(e.target)) return;
  closePopup();
}

function decorate(sel) {
  if (entries.has(sel)) return;
  const wrap = document.createElement('div');
  wrap.className = 'gsel';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('gsel-native');
  sel.setAttribute('tabindex', '-1');
  sel.setAttribute('aria-hidden', 'true');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gsel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<span class="gsel-label"></span>' +
    '<svg class="gsel-chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">' +
    '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  wrap.appendChild(btn);

  const entry = { sel, btn, label: btn.querySelector('.gsel-label') };
  entries.set(sel, entry);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPopup(entry);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPopup(entry);
    } else if (e.key === 'Escape') {
      closePopup();
    }
  });

  // Keep .value readable/writable exactly like a native select, but repaint
  // the custom trigger whenever the code assigns a new selection.
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', {
    configurable: true,
    enumerable: false,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); sync(entry); }
  });

  // fillSelects() rewrites innerHTML on language / palette changes.
  new MutationObserver(() => sync(entry)).observe(sel, { childList: true, subtree: true });

  sync(entry);
}

export function initGlassSelects() {
  const list = [...document.querySelectorAll('select.ctl')];
  if (!list.length) return;
  ensurePop();
  list.forEach(decorate);
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onDocKey, true);
  window.addEventListener('resize', closePopup, { passive: true });
  window.addEventListener('scroll', (e) => {
    if (openEntry && !pop.contains(e.target)) closePopup();
  }, true);
}
