# 01. Architecture

How to keep two thousand lines in one file legible.

---

## 1. The canonical document order

Use the same physical layout every time. Somebody who has read one SFWA should
be able to find their way around any other, and the order below maps to load
order as well as to the order questions occur to a reader.

```
1.  <!doctype html> + <html lang>
2.  <meta charset>, <meta viewport>            must be the first bytes in <head>
3.  <meta http-equiv="Content-Security-Policy">
4.  <title>, description, SFWA metadata
5.  <style>                                    design tokens, then layout, then components
6.  Inline data blocks (JSON, base64 assets, worker source)
7.  <body>: semantic shell, empty mount point
8.  <template> elements
9.  <script>  §A Config    constants, feature flags, version
              §B Utils     pure helpers, no DOM
              §C State     the store and its mutations
              §D Persist   load/save/export/import
              §E Render    state to DOM
              §F Events    DOM to state
              §G Boot      one init() call, one entry point
```

Give each script section a banner comment. Editors fold on them, `Ctrl+F` finds
them, and diffs stay local instead of sprawling.

```js
// ═══════════════════════════════════════════════════════════
// §C  STATE
// ═══════════════════════════════════════════════════════════
```

**One rule holds all of this together:** dependencies point *up* the list and
never back down. `Render` can call `Utils`. `Utils` must never call `Render`.
Break that and the file stops being readable, and the length will get blamed for
it.

---

## 2. Choosing a rendering strategy

Pick one and stay with it. Two rendering strategies in one file is the second
fastest way to rot an SFWA.

### 2.1 Direct DOM (no library)

Good for anything with fewer than about ten distinct interactive regions.

```js
const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}
```

A dozen lines, no dependency, and it covers most of what JSX would give you.
Text goes in via `append`, which escapes for you, so `innerHTML` never enters
the picture.

**What it costs:** you do reconciliation by hand. That is fine when you
re-render small regions wholesale, and unpleasant for lists that need to keep
focus and scroll position.

### 2.2 Template plus full re-render

Good for dashboards and anything read-mostly.

```js
function render() {
  root.replaceChildren(...view(state));
}
```

Re-rendering the entire tree naively is fast enough below roughly a thousand
nodes, so measure before you optimise. What will actually hurt is losing focus,
selection and scroll position. Re-render regions instead of the root, and
restore focus deliberately:

```js
function renderPreservingFocus(container, nodes) {
  const active = document.activeElement;
  const id = active?.id, start = active?.selectionStart, end = active?.selectionEnd;
  container.replaceChildren(...nodes);
  if (id) {
    const next = document.getElementById(id);
    next?.focus();
    if (next && start != null && 'setSelectionRange' in next) {
      next.setSelectionRange(start, end);
    }
  }
}
```

### 2.3 A tiny VDOM library

Preact with `htm` buys you real components and reconciliation for about 5 KB
gzipped, no JSX transform, no build step.

```html
<script type="module">
  import { h, render } from 'https://esm.sh/preact@10.24.3';
  import htm from 'https://esm.sh/htm@3.1.1';
  const html = htm.bind(h);

  const App = ({ items }) => html`
    <ul>${items.map(i => html`<li key=${i.id}>${i.label}</li>`)}</ul>
  `;
  render(html`<${App} items=${data} />`, document.getElementById('app'));
</script>
```

⚠️ As written that is **Level 0**. It fetches from a CDN and uses a module
script, so it will not run over `file://`. For Level 1, either vendor the
library into the file at build time (see
[03-build-tooling](03-build-tooling.md)) or map the specifier to a data URL.

### 2.4 Attribute-driven (Alpine, petite-vue)

Worth it when the app is mostly a form over a small state object and you want
the markup to keep reading as markup.

```html
<div x-data="{ open: false }">
  <button @click="open = !open">Toggle</button>
  <p x-show="open">Content</p>
</div>
```

**What it costs:** logic scatters into attributes where you cannot grep it,
test it or refactor it. Pleasant up to about 300 lines of app. It gets bad
quickly after that.

### 2.5 Selection guide

| Situation | Use |
|---|---|
| Utility, one screen, < 500 lines | Direct DOM (§2.1) |
| Dashboard, read-mostly, few inputs | Full re-render (§2.2) |
| Editor, many inputs, list-heavy | Preact + htm (§2.3) |
| Form-shaped app, markup-first | Alpine (§2.4) |
| Canvas or WebGL at the centre | Direct DOM for the chrome, an imperative loop for the canvas |

That last row covers more of the directory than you might expect.
[FuzzyGraph](https://iamsingle.app/entry/fuzzygraph) and
[orbital-notebook](https://iamsingle.app/entry/orbital-notebook) both put a
canvas at the centre and keep the surrounding controls deliberately plain, which
is the right instinct. There is nothing to gain from a reactive framework
wrapped around a render loop that owns its own pixels.

---

## 3. State

### 3.1 One store, plain object

```js
const initial = Object.freeze({
  schema: 3,
  items: [],
  filter: 'all',
  ui: { selectedId: null, dialog: null },
});
```

Keep `schema` as a required top-level integer. It costs nothing now and saves
you the day you change the shape, which you will. See
[02-persistence §5](02-persistence.md#5-versioning-and-migration).

Keep `ui` separate from domain data. Only domain data gets exported and
persisted. Skip this and every export you produce will carry a record of which
dialog happened to be open, and every import will helpfully reopen it.

### 3.2 Reactivity with a Proxy

```js
let state = structuredClone(initial);
let dirty = false;

const store = new Proxy(state, {
  set(target, key, value) {
    if (Object.is(target[key], value)) return true;
    target[key] = value;
    schedule();
    return true;
  },
  deleteProperty(target, key) { delete target[key]; schedule(); return true; },
});

function schedule() {
  if (dirty) return;
  dirty = true;
  queueMicrotask(() => { dirty = false; render(); });
}
```

⚠️ **This proxy is shallow.** `store.items.push(x)` will not trigger a render,
because the mutation lands on the inner array and the proxy never sees it. Two
honest ways out:

- **Immutable updates.** `store.items = [...store.items, x]`. Predictable, a
  little wasteful, correct. Use this one.
- **A deep proxy.** Wrap nested objects on `get`. That is twenty more lines,
  some genuinely confusing identity bugs, and `structuredClone` of a proxied
  object throws when it meets a function. Avoid it until you have measured a
  reason.

### 3.3 Actions, not scattered mutation

Route every state change through a named function. This is what makes undo,
logging and persistence possible later without a rewrite.

```js
const actions = {
  addItem(label) {
    store.items = [...store.items, { id: crypto.randomUUID(), label, done: false }];
  },
  toggleItem(id) {
    store.items = store.items.map(i => i.id === id ? { ...i, done: !i.done } : i);
  },
  setFilter(filter) { store.filter = filter; },
};
```

`crypto.randomUUID()` needs a secure context, and current Chrome and Firefox
treat `file://` as one. Feature-detect anyway and fall back to a counter if you
still support older Safari.

### 3.4 Derived state

Compute it, do not store it. Stored derived values are how you end up with two
sources of truth that disagree at the worst possible moment.

```js
const visibleItems = () => {
  const { items, filter } = store;
  if (filter === 'active') return items.filter(i => !i.done);
  if (filter === 'done')   return items.filter(i => i.done);
  return items;
};
```

Memoise once profiling shows the derivation is hot, and not before. A one-key
cache on the input reference usually does it.

---

## 4. Routing

Use the hash. It behaves identically over `http://`, `https://` and `file://`,
and it needs no server configuration, which no other option can claim.

```js
const routes = {
  '': renderList,
  '#/settings': renderSettings,
  '#/about': renderAbout,
};

function router() {
  const view = routes[location.hash] ?? routes[''];
  view();
}
addEventListener('hashchange', router);
```

For routes with parameters, parse them yourself:

```js
function parseRoute(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { segments: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}
```

⚠️ `history.pushState` runs happily over `file://` and produces a URL nobody can
reload. Keep the History API out of a Level 1 app.

---

## 5. Styling

### 5.1 Tokens first

```css
:root {
  color-scheme: light dark;

  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 1rem;
  --space-4: 1.5rem;  --space-5: 2.5rem;

  --radius: 8px;
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;

  --bg:      light-dark(#fdfdfc, #16161a);
  --surface: light-dark(#ffffff, #1e1e24);
  --text:    light-dark(#1a1a1a, #e8e8e6);
  --muted:   light-dark(#6b6b70, #9a9aa2);
  --accent:  light-dark(#2f5fd0, #7aa2f7);
  --border:  light-dark(#e2e2df, #2e2e36);
}
```

`color-scheme` plus `light-dark()` gets you dark mode in one declaration each,
following the OS preference for free. For a manual override, set `color-scheme`
on a wrapper element and leave the palette alone.

### 5.2 Cascade layers

Six hundred lines of CSS in one `<style>` block needs as much internal structure
as the JavaScript does.

```css
@layer reset, base, layout, components, utilities, overrides;

@layer reset   { *, *::before, *::after { box-sizing: border-box; } }
@layer base    { body { font: 16px/1.5 var(--font-ui); background: var(--bg); color: var(--text); } }
@layer layout  { .stack > * + * { margin-block-start: var(--space-3); } }
@layer components { /* ... */ }
```

Layers make specificity stop mattering. Anything in `overrides` beats anything
in `components` no matter how the selectors weigh up, which heads off the
`!important` spiral that single-file CSS drifts into.

### 5.3 Native nesting

Supported everywhere current, and it removes most of the reason people used to
reach for a preprocessor.

```css
@layer components {
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);

    & > h3 { margin: 0 0 var(--space-2); font-size: 1rem; }
    &:has(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }

    @media (width < 40rem) { padding: var(--space-2); }
  }
}
```

### 5.4 What to avoid

**Tailwind Play CDN.** It is a development convenience that ships an entire
compiler to the browser. It drops you to Level 0, costs hundreds of kilobytes,
and flashes unstyled content on the way in.
[gemini-chat-organizer-hub](https://iamsingle.app/entry/gemini-chat-organizer-hub)
is otherwise a tidy 58 KB offline-first app, and `cdn.tailwindcss.com` is one of
the twelve things it fetches before it can render. If you want Tailwind, compile
it and inline the output.

**Web fonts.** One WOFF2 weight runs 20 to 60 KB once base64-inlined, which is
rarely worth it. `system-ui` looks native everywhere, and native usually looks
better than the font you picked.

**Icon fonts.** Use an inline SVG `<symbol>` sprite instead. See
[06-cookbook §15](06-cookbook.md#15-inline-svg-sprite).

---

## 6. Components inside one file

One file per component is off the table. Components are not.

```js
// ── Component: ItemRow ───────────────────────────────────────
// props: { item, onToggle, onDelete }
function ItemRow({ item, onToggle, onDelete }) {
  return h('li', { class: 'row', 'data-id': item.id },
    h('input', { type: 'checkbox', checked: item.done, onChange: () => onToggle(item.id) }),
    h('span', { class: item.done ? 'done' : '' }, item.label),
    h('button', { onClick: () => onDelete(item.id), 'aria-label': `Delete ${item.label}` }, '×'),
  );
}
```

Take one props object and destructure it in the signature, so the interface
documents itself. Put a one-line comment above each component stating the props
contract. Have components take callbacks instead of calling `actions` directly,
which keeps them testable and puts the data flow where you can see it at the
call site. And have them return nodes, leaving the appending to whoever called
them.

When a component is mostly markup, `<template>` beats string concatenation:

```html
<template id="tpl-row">
  <li class="row">
    <input type="checkbox">
    <span class="label"></span>
    <button class="del" aria-label="Delete">×</button>
  </li>
</template>
```

```js
const tplRow = document.getElementById('tpl-row');
function ItemRow(item) {
  const node = tplRow.content.firstElementChild.cloneNode(true);
  node.dataset.id = item.id;
  node.querySelector('.label').textContent = item.label;   // escaped, safe
  node.querySelector('input').checked = item.done;
  return node;
}
```

---

## 7. Event handling

One delegated listener per container, not one per row. It survives re-renders,
costs nothing to attach, and keeps all the wiring in a block you can read at
once.

```js
root.addEventListener('click', (e) => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.matches('.del'))       actions.deleteItem(id);
  else if (e.target.matches('input')) actions.toggleItem(id);
});
```

Keyboard shortcuts belong in a single declarative map, never a chain of
conditionals. See [06-cookbook §12](06-cookbook.md#12-keyboard-shortcut-map).

---

## 8. Errors

There is no error-reporting backend here and nobody watching logs. The user is
the only observer you have, so failures need to be visible and recoverable.

```js
addEventListener('error', (e) => reportFailure(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => reportFailure(e.reason));

function reportFailure(err) {
  console.error(err);
  const bar = document.getElementById('errorbar');
  bar.textContent = `Something went wrong: ${err?.message ?? err}. Your data is still saved.`;
  bar.hidden = false;
}
```

Never white-screen. A blank page in a file somebody double-clicked is
indistinguishable from a download that failed halfway.

Say whether the data survived, because that is the only thing they want to know.

Keep the export path alive when rendering dies. Wrap the render call and leave the
persistence layer alone, so a broken view still allows a rescue. A keyboard
shortcut that dumps state to the console or downloads a JSON file, registered
first thing in boot, has saved people's work more than once.

---

## 9. Boot sequence

One entry point, one order, and no top-level side effects anywhere else.

```js
function init() {
  installErrorHandlers();   // first: everything after this can fail safely
  installRescueShortcut();
  const loaded = loadState();
  if (loaded.ok) Object.assign(store, loaded.value);
  else notice(`Starting fresh: ${loaded.error}`);
  bindEvents();
  router();
  render();
  document.body.dataset.ready = 'true';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
```

`document.body.dataset.ready` gives CSS something to fade in on and gives
end-to-end tests something to wait for. One line, two uses.

---

## 10. Keeping the file navigable

**Put a table of contents at the top of the script**, one line per section with
a short summary. Twelve lines will make a 2,000-line file browsable.

**Cap the file around 3,000 lines.** Hand-editing gets uncomfortable well
before that, somewhere near 1,500, which is where you should switch to authoring
in several files and bundling. Neither move changes your conformance level, per
[00-spec §5](00-spec.md#5-non-goals).

**Keep functions under 50 lines.** With no module boundaries to lean on, long
functions get disproportionately harder to follow than they would elsewhere.

**Name consistently by section.** `renderX` in §E, `onX` in §F, `loadX` and
`saveX` in §D. Do that and you can find any function by guessing what it is
called.

**Keep the CSS component order matching the JS component order.** Somebody
reading `ItemRow` should be able to find `.row` by position, without searching
for it.
