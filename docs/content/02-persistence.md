# 02. Persistence and State

Where data lives when there is no server.

---

## 1. The storage ladder

Climb only as far as you need. Every rung costs you complexity and buys either
capacity or durability.

| Rung | Mechanism | Capacity | Sync? | Survives clearing site data? | Works on `file://` |
|---|---|---|---|---|---|
| 0 | In-memory only | RAM | n/a | No | Yes |
| 1 | URL hash | ~2–8 KB practical | Sync | Yes (it is in the link) | Yes |
| 2 | `localStorage` | ~5 MB, strings only | Sync (blocking) | No | ⚠️ unreliable |
| 3 | `IndexedDB` | Quota-based, often hundreds of MB | Async | No | ⚠️ varies |
| 4 | OPFS | Quota-based | Async | No | ⚠️ varies |
| 5 | Download / upload files | Unbounded | Async, manual | Yes | Yes |
| 6 | File System Access API | Unbounded | Async | Yes | Chromium only |
| 7 | Self-modifying document | Unbounded | Async, manual | Yes | Yes |

For most apps: rung 2 or 3 for working state, plus rung 5 as the durable export.
Browser storage is a cache wearing a filing cabinet's clothes. Assume it gets
wiped without warning, because sooner or later it will be.

⚠️ **`file://` and browser storage.** Behaviour varies by browser and has
changed over the years. Some treat every `file://` document as one shared
origin, so two unrelated apps end up fighting over the same `localStorage`.
Others hand out an opaque origin, so nothing persists at all. Never let a Level
1 app *depend* on browser storage over `file://`. Use it when it happens to
work, detect when it does not, and fall back to an explicit file export.

```js
const storageAvailable = (() => {
  try {
    const k = '__probe__';
    localStorage.setItem(k, k);
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
})();
```

---

## 2. localStorage, done properly

The obvious version loses data. This one does not.

```js
const KEY = 'myapp/v1';

function saveState() {
  if (!storageAvailable) return { ok: false, error: 'storage unavailable' };
  try {
    localStorage.setItem(KEY, JSON.stringify(persistable(store)));
    return { ok: true };
  } catch (err) {
    // QuotaExceededError, or Safari private mode historically
    return { ok: false, error: err.name };
  }
}

function loadState() {
  if (!storageAvailable) return { ok: false, error: 'storage unavailable' };
  const raw = localStorage.getItem(KEY);
  if (!raw) return { ok: false, error: 'no saved data' };
  try {
    return { ok: true, value: migrate(JSON.parse(raw)) };
  } catch {
    // Never throw away the bad data: somebody may want it recovered.
    // Quarantining can itself fail on a full quota, so it must not throw.
    try { localStorage.setItem(`${KEY}/corrupt/${Date.now()}`, raw); } catch {}
    return { ok: false, error: 'saved data was unreadable; a copy was kept' };
  }
}

// Strip transient UI state before persisting.
const persistable = ({ schema, items, filter }) => ({ schema, items, filter });
```

A few details there tend to be missing from the version people write first. The
key is namespaced and versioned (`myapp/v1`, not `data`). Quota errors are
caught, because an uncaught throw inside a save handler silently kills every
save that would have followed. Corrupt data gets quarantined instead of
discarded. And only domain state gets written, per
[01-architecture §3.1](01-architecture.md#31-one-store-plain-object).

### Debounce writes

`localStorage` is synchronous and blocks the main thread, so do not write on
every keystroke.

```js
const debounce = (fn, ms = 400) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const scheduleSave = debounce(saveState, 400);

// And always flush on the way out:
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState();
});
addEventListener('pagehide', saveState);
```

⚠️ Use `visibilitychange` and `pagehide` rather than `beforeunload`. Mobile
browsers discard tabs without ever firing `beforeunload`, and the data is gone
before you knew there was a problem.

---

## 3. IndexedDB without a library

You need it above about 5 MB, or for binary blobs, or when synchronous writes
start hurting. The raw API is genuinely unpleasant to use directly, and forty
lines of promise wrapper fixes that for good.

```js
function openDB(name = 'myapp', version = 1) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('docs')) {
        const s = db.createObjectStore('docs', { keyPath: 'id' });
        s.createIndex('updated', 'updated');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('database blocked by another tab'));
  });
}

function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
  });
}

const idbGet = (db, k)    => tx(db, 'kv', 'readonly',  s => s.get(k));
const idbSet = (db, k, v) => tx(db, 'kv', 'readwrite', s => s.put(v, k));
const idbDel = (db, k)    => tx(db, 'kv', 'readwrite', s => s.delete(k));
```

The reason to reach for IndexedDB is usually not capacity. It stores
structured-cloneable values directly, so `Blob`, `File`, `ArrayBuffer`, `Map`
and `Date` all survive a round trip with no serialisation code of your own.

### Ask for persistence

Browser storage is evictable by default when the device gets tight. Ask for
better:

```js
if (navigator.storage?.persist) {
  const persisted = await navigator.storage.persisted();
  if (!persisted) {
    await navigator.storage.persist();
    // Grant heuristics vary: engagement, installation, notification permission.
    // Never assume it worked, and never tell the user their data is "safe"
    // on the strength of it.
  }
}
```

And show people where they stand:

```js
const { usage, quota } = await navigator.storage.estimate();
```

---

## 4. Export and import: the Level 2 requirement

The highest-value feature in any offline app. Build it early, while the state
shape is still small enough to think about.

### Export

```js
function exportState() {
  const payload = {
    format: 'myapp.export',
    schema: store.schema,
    exportedAt: new Date().toISOString(),
    appVersion: document.querySelector('meta[name="sfwa:version"]')?.content ?? 'dev',
    data: persistable(store),
  };
  download(
    JSON.stringify(payload, null, 2),
    `myapp-${new Date().toISOString().slice(0, 10)}.json`,
    'application/json'
  );
}

function download(text, filename, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);   // revoking synchronously can cancel the download
}
```

Those envelope fields are not ceremony. `format` lets you reject somebody else's
JSON with a message that helps them. `schema` drives migration. `appVersion` and
`exportedAt` turn a ten-minute support conversation into a ten-second one.

### Import

```js
async function importFromFile(file) {
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('That file is not valid JSON.'); }

  if (payload?.format !== 'myapp.export') {
    throw new Error('That file was not exported from this app.');
  }
  if (payload.schema > CURRENT_SCHEMA) {
    throw new Error(`That file was made with a newer version (schema ${payload.schema}). Update the app first.`);
  }
  const data = migrate({ schema: payload.schema, ...payload.data });
  if (!validate(data)) throw new Error('The file is readable but its contents are malformed.');
  return data;
}
```

⚠️ **Confirm before replacing.** Import destroys whatever was there. Ask first,
or better, export the current state automatically and tell the user where that
copy went.

### Accept files three ways

People will try all three, and supporting them costs about fifteen lines.
[xlsx2md](https://iamsingle.app/entry/xlsx2md) is a good model for how far this
can be pushed: the whole app is a file-in, Markdown-out pipeline in 16 KB, and
the import path is most of what it does.

```js
// 1. Picker
fileInput.addEventListener('change', e => e.target.files[0] && handleFile(e.target.files[0]));

// 2. Drag and drop
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// 3. Paste
document.addEventListener('paste', e => {
  const file = [...e.clipboardData.files][0];
  if (file) return handleFile(file);
  const text = e.clipboardData.getData('text/plain');
  if (text.trimStart().startsWith('{')) handleText(text);
});
```

---

## 5. Versioning and migration

Every persisted shape carries an integer `schema`, and migrations form a chain
of pure functions that each move it forward exactly one step.

```js
const CURRENT_SCHEMA = 4;

const migrations = {
  1: (s) => ({ ...s, filter: 'all', schema: 2 }),
  2: (s) => ({ ...s, items: s.items.map(i => ({ ...i, createdAt: i.createdAt ?? null })), schema: 3 }),
  3: (s) => ({ ...s, items: s.items.map(({ text, ...rest }) => ({ ...rest, label: text })), schema: 4 }),
};

function migrate(state) {
  let s = { schema: 1, ...state };
  while (s.schema < CURRENT_SCHEMA) {
    const step = migrations[s.schema];
    if (!step) throw new Error(`No migration from schema ${s.schema}`);
    s = step(s);
  }
  return s;
}
```

Migrations are append-only, so never edit one that has shipped, add another
instead. Never migrate downward either: refuse a newer file with a clear message
(see §4). Keep every migration forever, because somebody will open a two-year-old
export, and three lines of code is a cheap insurance premium. And test the whole
chain, because one test that runs a schema-1 fixture all the way to current
catches the entire class of bug.

### Validation

Migration gets the shape right and validation confirms it. Hand-write the
validator. It will be smaller than a schema library, it adds no dependency, and
the messages it produces will be better than anything generic.

```js
function validate(s) {
  if (typeof s !== 'object' || s === null) return false;
  if (!Array.isArray(s.items)) return false;
  return s.items.every(i =>
    typeof i?.id === 'string' &&
    typeof i?.label === 'string' &&
    typeof i?.done === 'boolean'
  );
}
```

---

## 6. The self-saving document

The Level 3 pattern, where the running app emits a new copy of its own HTML
with the current state baked in. [TiddlyWiki](https://iamsingle.app/entry/tiddlywiki)
has done this since 2004 and [nash](https://iamsingle.app/entry/nash) is a
recent, much smaller take on it.

### Storage slot

```html
<script type="application/json" id="app-state">{"schema":4,"items":[]}</script>
```

`type="application/json"` earns its keep here. The browser will not execute it,
so even a hostile payload sits there inert until you parse it. **Never**
serialise state into an executable `<script>`. That is an injection vector by
construction, not by accident.

Both production examples do exactly this.
[TiddlyWiki](https://iamsingle.app/entry/tiddlywiki) stores its tiddlers in
`<script class="tiddlywiki-tiddler-store" type="application/json">`, and
[Bento](https://iamsingle.app/entry/bento) uses
`<script type="application/bento+json" id="bento-doc">` for the document with a
deflate-compressed runtime in sibling blocks below it.

Keeping the block legible is worth more than it looks. Bento's readable JSON
sits at the top of the file, above the compressed shell, so you can open a deck
in a text editor and read the content even if the app itself has bit-rotted.
That is a real recovery path, and it costs nothing to design in.

### Reading on boot

```js
function readEmbeddedState() {
  const node = document.getElementById('app-state');
  if (!node) return null;
  try {
    const parsed = JSON.parse(node.textContent || '{}');
    const migrated = migrate(parsed);
    return validate(migrated) ? migrated : null;
  } catch { return null; }
}
```

### Writing a new copy

```js
function serializeSelf() {
  const doc = document.documentElement.cloneNode(true);

  // 1. Write current state into the slot.
  const slot = doc.querySelector('#app-state');
  slot.textContent = JSON.stringify(persistable(store))
    .replaceAll('<', '\\u003c');            // cannot terminate the script element

  // 2. Reset the DOM to its pristine, pre-render form. The app rebuilds
  //    everything from state on boot, so shipping rendered DOM is wrong.
  doc.querySelector('#app').replaceChildren();
  doc.querySelectorAll('[data-transient]').forEach(n => n.remove());
  doc.querySelector('body')?.removeAttribute('data-ready');

  return '<!doctype html>\n' + doc.outerHTML;
}

function saveSelf() {
  const name = (store.title || 'document').replace(/[^\w-]+/g, '-').toLowerCase();
  download(serializeSelf(), `${name}-${new Date().toISOString().slice(0,10)}.html`, 'text/html');
}
```

### Where this goes wrong

1. **Rendered DOM leaking into the saved copy.** Clone the live document without
   resetting it and every save doubles the rendered markup, quietly, until
   somebody notices the file is 40 MB. Step 2 above is not optional. It also
   implies an architectural precondition: the app must render *entirely* from
   state, with no DOM authored by hand at runtime and left lying around.

2. **`</script>` inside serialised data.** Somebody types `</script>` into a
   text field, the state block terminates early, and the file is corrupt.
   Escaping `<` as `\u003c` fixes it, and the result is still valid JSON that
   parses to exactly the same string.

3. **The browser cannot overwrite the original.** `download()` writes a *new*
   file, usually landing as `app (3).html`. People then edit the wrong copy and
   lose an afternoon's work. Either be loud about this in the UI or use the File
   System Access API (§7) to write back in place where it exists.

4. **Growth.** Every save embeds the full state, and base64 images inside a
   self-saving document will push it into the megabytes faster than you expect.
   Cap embedded binary size, and move large assets to IndexedDB with a clear
   warning that they will not travel with the file.

---

## 7. File System Access API

Where it exists, this gives you a real open-edit-save loop with no downloads
folder sitting in the middle of it.

```js
const canUseFS = 'showSaveFilePicker' in window;   // Chromium desktop today

let handle = null;

async function openFile() {
  [handle] = await showOpenFilePicker({
    types: [{ description: 'MyApp document', accept: { 'application/json': ['.json'] } }],
    multiple: false,
  });
  const file = await handle.getFile();
  return JSON.parse(await file.text());
}

async function saveFile(text) {
  if (!handle) {
    handle = await showSaveFilePicker({
      suggestedName: 'document.json',
      types: [{ description: 'MyApp document', accept: { 'application/json': ['.json'] } }],
    });
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}
```

Pickers need a user gesture, so calling one outside a click handler throws. Handles can be stashed in IndexedDB and reused across
sessions, but permission has to be re-requested through
`handle.queryPermission()` and `requestPermission()`. And feature-detect, always,
falling back to the download and upload pair from §4. An API with partial
support should never be your only save path.

### OPFS

The Origin Private File System is a sandboxed, fast filesystem the user cannot
browse. It suits large working data, a scratch database or a video buffer, and
it is emphatically not a durable user-visible store.

```js
const root = await navigator.storage.getDirectory();
const fh = await root.getFileHandle('scratch.bin', { create: true });
const w = await fh.createWritable();
await w.write(bytes);
await w.close();
```

⚠️ `createWritable` and `createSyncAccessHandle` (worker-only) have different
availability across engines. Detect both and pick per environment.

---

## 8. State in the URL

For small state the URL beats everything else. It is shareable, bookmarkable,
survives a wiped browser profile, and asks nobody for permission.

```js
async function encodeState(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes); writer.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function decodeState(str) {
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes); writer.close();
  const out = await new Response(ds.readable).text();
  return JSON.parse(out);
}
```

Use the hash, never the query string. Fragments never reach a server, so the
state stays on the user's machine even when the app is hosted. That is a privacy
guarantee you get for free.

Budget about 2,000 characters. Longer URLs work fine in browsers and then break
in chat clients, email and the occasional proxy.

Use `history.replaceState` for continuous updates, unless you want every
keystroke in the back button.

Compression usually takes 60 to 80% off JSON, which is the only reason any of
this is viable for structured state.

---

## 9. Cross-tab coordination

Two tabs of the same app will happily overwrite each other. Two lines stop
them.

```js
const bus = new BroadcastChannel('myapp');
bus.onmessage = (e) => {
  if (e.data.type === 'state') { Object.assign(store, e.data.value); render(); }
};
// after a local save:
bus.postMessage({ type: 'state', value: persistable(store) });
```

For something stricter, elect a single writer with the Web Locks API:

```js
let isPrimary = false;

navigator.locks.request('myapp-writer', { mode: 'exclusive' }, async () => {
  isPrimary = true;
  await new Promise(() => {});   // hold for the tab's lifetime
});
```

⚠️ `BroadcastChannel` does not work between `file://` documents in every
browser. Treat it as a nicety on hosted deployments and never depend on it at
Level 1.

---

## 10. Encryption at rest

If the app holds anything sensitive and the file might be shared, encrypt the
payload. The filesystem it happens to be sitting on deserves no trust at all.
[Hypervault](https://iamsingle.app/entry/hypervault) is the reference example in
the directory: it embeds a copy of the decryption logic alongside the encrypted
data, so the artifact stays openable without the original app.

```js
async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

async function encrypt(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(passphrase, salt);
  const ct   = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  ));
  return { v: 1, salt: [...salt], iv: [...iv], ct: [...ct] };
}

async function decrypt({ salt, iv, ct }, passphrase) {
  const key = await deriveKey(passphrase, new Uint8Array(salt));
  const pt  = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(ct)
  );
  return new TextDecoder().decode(pt);
}
```

A fresh IV for every encryption, without exception. Reusing one with AES-GCM is
not a weakening, it is a break.

Store the salt and IV next to the ciphertext. Neither is secret.

Version the envelope (`v: 1`) so you can raise the iteration count later. The
600,000 above is the current OWASP floor for PBKDF2-SHA-256, and floors rise.

`crypto.subtle` needs a secure context. `https://`, `localhost` and, in current
Chrome and Firefox, `file://` all qualify. Verify in the browsers you actually
target.

And say plainly, in the UI, before anything is encrypted, that a forgotten
passphrase means the data is gone. There is no recovery path and people will
assume there is one.
