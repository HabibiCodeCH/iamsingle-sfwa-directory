# 06. Cookbook

Sixteen recipes. All dependency-free unless stated. All Level 1 compatible
unless flagged.

**Contents**

1. [Minimal skeleton](#1-minimal-skeleton)
2. [Reactive state in 20 lines](#2-reactive-state-in-20-lines)
3. [Preact + htm without a build](#3-preact--htm-without-a-build) *(Level 0)*
4. [Inline web worker](#4-inline-web-worker)
5. [Inline WebAssembly](#5-inline-webassembly)
6. [Open and save files](#6-open-and-save-files)
7. [Self-saving document](#7-self-saving-document)
8. [State in the URL](#8-state-in-the-url)
9. [Dialogs and toasts](#9-dialogs-and-toasts)
10. [Theme switching](#10-theme-switching)
11. [Virtualised list](#11-virtualised-list)
12. [Keyboard shortcut map](#12-keyboard-shortcut-map)
13. [Undo and redo](#13-undo-and-redo)
14. [CSV import and export](#14-csv-import-and-export)
15. [Inline SVG sprite](#15-inline-svg-sprite)
16. [Print stylesheet](#16-print-stylesheet)

---

## 1. Minimal skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>App</title>
<meta name="sfwa:level" content="1">
<meta name="sfwa:version" content="0.1.0">
<meta name="sfwa:network" content="none">
<style>
@layer reset, base, components;
@layer reset { *,*::before,*::after { box-sizing: border-box; } body { margin: 0; } }
@layer base {
  :root {
    color-scheme: light dark;
    --bg: light-dark(#fdfdfc, #16161a);
    --text: light-dark(#1a1a1a, #e8e8e6);
    --accent: light-dark(#2f5fd0, #7aa2f7);
    --border: light-dark(#e2e2df, #2e2e36);
  }
  body {
    font: 16px/1.5 system-ui, sans-serif;
    background: var(--bg); color: var(--text);
    max-width: 46rem; margin-inline: auto; padding: 2rem 1rem;
    opacity: 0; transition: opacity .15s;
  }
  body[data-ready] { opacity: 1; }
}
</style>
</head>
<body>
<main id="app"></main>
<noscript><p>This app needs JavaScript. It runs entirely on your device.</p></noscript>
<script>
'use strict';
(() => {
  const app = document.getElementById('app');
  function init() {
    app.textContent = 'Hello.';
    document.body.dataset.ready = '';
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
</script>
</body>
</html>
```

---

## 2. Reactive state in 20 lines

```js
function createStore(initial, onChange) {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; onChange(state); });
  };
  const state = new Proxy({ ...initial }, {
    set(t, k, v) {
      if (Object.is(t[k], v)) return true;
      t[k] = v; schedule(); return true;
    },
    deleteProperty(t, k) { delete t[k]; schedule(); return true; },
  });
  return state;
}

const store = createStore({ count: 0, items: [] }, render);

// Shallow by design. Replace arrays and objects, never mutate them:
store.items = [...store.items, newItem];   // triggers
store.items.push(newItem);                 // does NOT trigger
```

`queueMicrotask` collapses every synchronous mutation in a turn into one render.
Swap in `requestAnimationFrame` if renders are expensive and you want to
coalesce across event handlers too.

---

## 3. Preact + htm without a build

⚠️ **Level 0.** Fetches from a CDN and uses a module script, so it will not work
over `file://`.

```html
<script type="importmap">
{"imports":{
  "preact":"https://esm.sh/preact@10.24.3",
  "preact/hooks":"https://esm.sh/preact@10.24.3/hooks",
  "htm/preact":"https://esm.sh/htm@3.1.1/preact"
}}
</script>
<script type="module">
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { html } from 'htm/preact';

function Counter() {
  const [n, setN] = useState(0);
  return html`
    <button onClick=${() => setN(n - 1)}>−</button>
    <output>${n}</output>
    <button onClick=${() => setN(n + 1)}>+</button>
  `;
}
render(html`<${Counter} />`, document.getElementById('app'));
</script>
```

For Level 1, bundle it with the toolchain in
[03-build-tooling §3](03-build-tooling.md#3-bundling-to-a-single-file).

---

## 4. Inline web worker

Keep the worker source in a non-executing block and instantiate it from a blob.

```html
<script type="text/worker" id="worker-src">
self.onmessage = (e) => {
  const { numbers } = e.data;
  let sum = 0;
  for (const n of numbers) sum += Math.sqrt(n);
  self.postMessage({ sum });
};
</script>
```

```js
const src = document.getElementById('worker-src').textContent;
const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
const worker = new Worker(url);
URL.revokeObjectURL(url);          // safe: the worker already holds the resource

function compute(numbers) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = reject;
    worker.postMessage({ numbers });
  });
}
```

⚠️ Three ways this goes wrong:

- CSP has to allow `worker-src blob:`.
- The literal string `</script>` inside the worker source terminates the block.
  Write `<\/script>` where you need it.
- Blob workers have no base URL, so `importScripts` with a relative path fails.
  Inline everything the worker needs.

For heavy work, transfer buffers instead of copying them:

```js
worker.postMessage({ buf }, [buf]);   // buf is neutered in the sender
```

---

## 5. Inline WebAssembly

```html
<script type="text/plain" id="wasm-b64">AGFzbQEAAAABBgFgAX8BfwMCAQAHBwEDYWRkAAAKCQEHACAAQQFqCw==</script>
```

```js
const b64 = document.getElementById('wasm-b64').textContent.trim();
const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const { instance } = await WebAssembly.instantiate(bytes, {});
console.log(instance.exports.add(41));   // 42
```

Base64 costs about 33% overhead, so past a few hundred KB, reconsider whether
Level 1 earns its weight. `WebAssembly.instantiate` on raw bytes works over
`file://`, while `instantiateStreaming` does not, since it wants a `Response`.
Bundlers can also emit the module as a compact typed-array literal instead of
base64, via the `binary` loader in
[03-build-tooling §3.3](03-build-tooling.md#33-inlining-assets-in-source).

---

## 6. Open and save files

Progressive enhancement: the modern API where it exists, the classic pair
everywhere else.

⚠️ Note the name `openFile`. A top-level `function open()` in a classic script
shadows `window.open` for the whole app, and you will not enjoy finding that out
three features later.

```js
const hasFS = 'showSaveFilePicker' in window;
let fileHandle = null;

async function openFile() {
  if (hasFS) {
    [fileHandle] = await showOpenFilePicker({
      types: [{ description: 'Document', accept: { 'application/json': ['.json'] } }],
    });
    return (await fileHandle.getFile()).text();
  }
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'),
      { type: 'file', accept: '.json,application/json' });
    input.onchange = () => input.files[0]?.text().then(resolve);
    input.click();
  });
}

async function save(text, suggestedName = 'document.json') {
  if (hasFS) {
    fileHandle ??= await showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Document', accept: { 'application/json': ['.json'] } }],
    });
    const w = await fileHandle.createWritable();
    await w.write(text);
    await w.close();
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: suggestedName });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
```

⚠️ Both pickers need a user gesture. Call them straight from a click handler,
never after an `await` that has already yielded to the event loop.

---

## 7. Self-saving document

The pattern behind [TiddlyWiki](https://iamsingle.app/entry/tiddlywiki) and
[nash](https://iamsingle.app/entry/nash).

```html
<script type="application/json" id="app-state">{"schema":1,"items":[]}</script>
```

```js
function loadEmbedded() {
  try {
    const parsed = JSON.parse(document.getElementById('app-state').textContent || '{}');
    return validate(parsed) ? parsed : null;
  } catch { return null; }
}

function serializeSelf() {
  const doc = document.documentElement.cloneNode(true);

  doc.querySelector('#app-state').textContent =
    JSON.stringify(persistable(store)).replaceAll('<', '\\u003c');

  // Reset to pristine DOM. The app rebuilds from state on boot.
  doc.querySelector('#app').replaceChildren();
  doc.querySelectorAll('[data-transient]').forEach(n => n.remove());
  doc.querySelector('body').removeAttribute('data-ready');

  return '<!doctype html>\n' + doc.outerHTML;
}

async function saveSelf() {
  const name = (store.title || 'document').replace(/[^\w-]+/g, '-').toLowerCase();
  await save(serializeSelf(), `${name}.html`);
}
```

Escaping `<` is what stops somebody typing `</script>` from destroying the file,
and the result is still valid JSON.

See [02-persistence §6](02-persistence.md#6-the-self-saving-document) for
everything else that can go wrong here.

---

## 8. State in the URL

```js
const enc = async (obj) => {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(JSON.stringify(obj))); w.close();
  const bytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const dec = async (s) => {
  const bytes = Uint8Array.from(
    atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return JSON.parse(await new Response(ds.readable).text());
};

// write (does not pollute history)
history.replaceState(null, '', '#' + await enc(persistable(store)));

// read on boot
if (location.hash.length > 1) {
  try { Object.assign(store, await dec(location.hash.slice(1))); }
  catch { notice('That link contained unreadable data.'); }
}
```

⚠️ `String.fromCharCode(...bytes)` blows the argument limit somewhere past
100 KB of compressed data. Chunk it if you must, though URLs that size are
unusable anyway. Keep the encoded string under about 2,000 characters.

---

## 9. Dialogs and toasts

`<dialog>` hands you a modal with focus trapping, `Escape` handling and a
backdrop, at no cost.

```html
<dialog id="confirm">
  <form method="dialog">
    <h2>Replace all data?</h2>
    <p>Importing will discard the current document.</p>
    <menu>
      <button value="cancel">Cancel</button>
      <button value="ok" autofocus>Replace</button>
    </menu>
  </form>
</dialog>
```

```js
function confirmDialog() {
  const dlg = document.getElementById('confirm');
  dlg.showModal();
  return new Promise(resolve =>
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}
```

```css
dialog::backdrop { background: rgb(0 0 0 / .4); backdrop-filter: blur(2px); }
dialog { border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; }
```

Toasts via the top layer, no library:

```js
function toast(message, ms = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  el.dataset.transient = '';           // excluded from self-save
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
```

`role="status"` gets it announced by screen readers without stealing focus.

---

## 10. Theme switching

Respect the OS by default, allow an override, remember the choice.

```css
:root { color-scheme: light dark; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
```

```js
const THEME_KEY = 'myapp/theme';
const applyTheme = (t) => {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
};
applyTheme(localStorage.getItem(THEME_KEY) ?? 'system');

select.addEventListener('change', (e) => {
  localStorage.setItem(THEME_KEY, e.target.value);
  applyTheme(e.target.value);
});
```

With `light-dark()` in your token definitions (see
[01-architecture §5.1](01-architecture.md#51-tokens-first)), setting
`color-scheme` is the whole implementation. No duplicated palette, no
`prefers-color-scheme` media query, no flash of the wrong theme.

---

## 11. Virtualised list

Past a few thousand rows, render only what is on screen.

```js
function virtualList({ container, items, rowHeight, renderRow, overscan = 5 }) {
  const spacer = document.createElement('div');
  const viewport = document.createElement('div');
  viewport.style.position = 'relative';
  spacer.style.height = `${items.length * rowHeight}px`;
  spacer.append(viewport);
  container.replaceChildren(spacer);

  function paint() {
    const start = Math.max(0, Math.floor(container.scrollTop / rowHeight) - overscan);
    const count = Math.ceil(container.clientHeight / rowHeight) + overscan * 2;
    const slice = items.slice(start, start + count);
    viewport.style.transform = `translateY(${start * rowHeight}px)`;
    viewport.replaceChildren(...slice.map((item, i) => {
      const node = renderRow(item, start + i);
      node.style.height = `${rowHeight}px`;
      return node;
    }));
  }

  container.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
  paint();
  return { refresh: paint };
}
```

Row height has to be fixed. Variable heights need measurement and a position
cache, and at that point ask whether the app should be paging instead.

---

## 12. Keyboard shortcut map

One declarative table beats a cascade of conditionals.

```js
const shortcuts = {
  'mod+s':     () => { saveSelf(); },
  'mod+z':     () => undo(),
  'mod+shift+z': () => redo(),
  'mod+k':     () => openCommandPalette(),
  '/':         () => searchInput.focus(),
  'Escape':    () => closeOverlays(),
};

const isMac = navigator.platform?.startsWith('Mac')
  || /Mac/.test(navigator.userAgentData?.platform ?? '');

document.addEventListener('keydown', (e) => {
  const inField = e.target.matches('input, textarea, select, [contenteditable]');
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  const combo = parts.join('+');

  if (inField && !combo.startsWith('mod') && combo !== 'Escape') return;
  const handler = shortcuts[combo];
  if (handler) { e.preventDefault(); handler(); }
});
```

Render the same object as your help screen and the documentation can never drift
from the implementation, since they are the same data.

---

## 13. Undo and redo

Snapshot-based. Simple, correct, and fine up to state sizes in the low
megabytes.

```js
// Not named `history`: that would shadow window.history, which recipe 8 uses.
const undoStack = { past: [], future: [], limit: 100 };

function commit(mutate) {
  const before = structuredClone(persistable(store));
  mutate();
  undoStack.past.push(before);
  if (undoStack.past.length > undoStack.limit) undoStack.past.shift();
  undoStack.future.length = 0;
}

function undo() {
  if (!undoStack.past.length) return;
  undoStack.future.push(structuredClone(persistable(store)));
  Object.assign(store, undoStack.past.pop());
  render();
}

function redo() {
  if (!undoStack.future.length) return;
  undoStack.past.push(structuredClone(persistable(store)));
  Object.assign(store, undoStack.future.pop());
  render();
}

// usage
commit(() => { store.items = [...store.items, item]; });
```

For text input, coalesce rapid edits into one entry so you are not snapshotting
per keystroke:

```js
let coalesceTimer = null;
function commitCoalesced(mutate, ms = 600) {
  if (coalesceTimer) { clearTimeout(coalesceTimer); mutate(); }
  else commit(mutate);
  coalesceTimer = setTimeout(() => { coalesceTimer = null; }, ms);
}
```

Once state passes a few megabytes, switch to storing inverse operations.

---

## 14. CSV import and export

A correct-enough parser that handles quotes, escaped quotes and embedded
newlines.

```js
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCSV(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}
```

⚠️ Prefix the export with a BOM if Excel is a target, or it mangles non-ASCII
characters:

```js
download('\uFEFF' + toCSV(rows), 'export.csv', 'text/csv');
```

⚠️ **CSV injection.** Spreadsheet software treats a cell beginning with `=`,
`+`, `-` or `@` as a formula. If the exported data came from untrusted input,
prefix those cells with an apostrophe.

---

## 15. Inline SVG sprite

One hidden sprite, referenced by `<use>`. Cacheable, styleable, no icon font.

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="i-save" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </symbol>
    <symbol id="i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </symbol>
  </defs>
</svg>
```

```html
<button aria-label="Save"><svg class="icon"><use href="#i-save"/></svg></button>
```

```css
.icon { width: 1.25em; height: 1.25em; }
```

`stroke="currentColor"` lets icons inherit text colour, so they follow theme
changes with no extra work.

---

## 16. Print stylesheet

Offline apps get printed. Fifteen lines keeps that from being embarrassing.

```css
@media print {
  @page { margin: 18mm; }

  :root { color-scheme: light; }
  body { max-width: none; padding: 0; font-size: 11pt; }

  nav, .toolbar, button, dialog, .toast, [data-transient] { display: none !important; }

  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 9pt; color: #555; }

  table { border-collapse: collapse; width: 100%; }
  thead { display: table-header-group; }     /* repeat headers across pages */
  tr, img, figure { break-inside: avoid; }
  h2, h3 { break-after: avoid; }
}
```

```js
document.getElementById('print').addEventListener('click', () => window.print());
```

Printing to PDF is also the cheapest export format you will ever implement, so
mention it in the UI next to your JSON export.
