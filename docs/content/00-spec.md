# 00. The SFWA Specification

> Status: working draft. Keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY
> are to be interpreted as in RFC 2119.

---

## 1. Definition

A **single-file web app (SFWA)** is a web application whose complete
distributable form is exactly one HTML document.

To qualify at any level, an artifact:

- **MUST** be a single file with an `.html` or `.htm` extension.
- **MUST** be a valid HTML document that renders a usable interface when opened
  in a browser.
- **MUST NOT** require a build step, install step, or package manager on the
  part of the person running it.
- **MUST NOT** require a companion file of any kind for its core function
  (no sibling `app.js`, no `styles.css`, no `config.json`).
- **SHOULD** be human-readable via `view-source:`. Minification is permitted,
  but a readable source **SHOULD** be published alongside it.

Read "core function" carefully. An app that can optionally import a CSV the
user picked still qualifies. An app that cannot start until it has fetched a
sibling `data.json` fails the test.

Two boundaries come up constantly.

The first is runtime. [vicco](https://iamsingle.app/entry/vicco) is a blog in
one file, no database and no build, which is the same instinct exactly, but the
file is PHP and needs a server that speaks it.
[httprd](https://iamsingle.app/entry/httprd) does remote desktop from a single
Python script and runs into the same wall. Both are single-file *apps*, and good
ones, but not single-file *web* apps under §1, because a browser cannot open
them on its own. The directory tags them `sfa` to keep the distinction visible.

The second is companion files.
[minimal-pwa](https://iamsingle.app/entry/minimal-pwa) is about as small as a
web app gets and it still ships a manifest and a service worker beside the HTML,
because installability requires them. That manifest is exactly the companion
file the rule prohibits. [05-distribution §3](05-distribution.md#3-offline) has
the compromise if you want both.

---

## 2. Conformance levels

The distinctions worth drawing are about *what the file depends on at runtime*.
Four levels, each strictly stronger than the last.

### Level 0: Single artifact

One file, but it may fetch code, styles, fonts or data over the network while it
loads: a CDN, an import map pointing at `esm.sh`, an API.

- **MUST** satisfy §1.
- **MAY** load remote subresources.
- Remote subresources **MUST** be version-pinned (no `@latest`, no floating
  major-version ranges).
- Remote script and style subresources **SHOULD** carry Subresource Integrity
  hashes.

*Use when:* you want no-build authoring and your users always have
connectivity.

*Do not claim more than this if you use a CDN.* Level 0 is the most commonly
overstated level by a wide margin, and it is usually overstated by accident.
Six apps in the directory sit here.
[codeflow](https://iamsingle.app/entry/codeflow) pulls fifteen scripts including
React and a full Babel compiler.
[Agent-Architecture](https://iamsingle.app/entry/agent-architecture) is
self-contained in every other respect and loses Level 1 to a single Google Font.

### Level 1: Self-contained

Everything needed to run is already in the file. Open it with the network
switched off and you get a working app.

- **MUST** satisfy Level 0.
- **MUST NOT** issue any network request during load or first render.
- **MUST** function fully when opened over `file://`.
- **MAY** make network requests afterwards, but only when the user asks for one
  (they paste an API key and press *Fetch*, say).
- Fonts, icons and images **MUST** be inlined as data URLs or inline SVG, or
  degrade to system equivalents.

*This is the level most people mean when they say "single-file app,"* and it is
the sensible default. [xlsx2md](https://iamsingle.app/entry/xlsx2md) is a good
small example at 16 KB;
[orbital-notebook](https://iamsingle.app/entry/orbital-notebook) a good larger
one at 63 KB.

⚠️ Level 1 is where ES modules will bite you. `<script type="module">` is
subject to CORS, and a `file://` document has no origin that can satisfy it, so
the app silently fails to start when somebody double-clicks it. A Level 1 app
**MUST** therefore use a classic inline `<script>` as its entry point, or be
bundled into one. See
[03-build-tooling §2](03-build-tooling.md#2-the-no-build-path).

### Level 2: Portable

Self-contained, and the user's data can travel without a server.

- **MUST** satisfy Level 1.
- **MUST** provide an explicit export producing a file or URL that holds the
  complete user state.
- **MUST** provide the matching import.
- The export format **MUST** be documented and versioned.
- The export format **SHOULD** be something plain and non-proprietary (JSON,
  CSV, Markdown) rather than an opaque blob.

*Use when:* the app holds data somebody would be annoyed to lose, which is
nearly every app that holds data at all.
[Hypervault](https://iamsingle.app/entry/hypervault) pushes the idea further
than most and ships its decryption logic alongside the encrypted payload, so the
exported artifact still opens years later without the original app.

### Level 3: Self-modifying

The file persists state by rewriting itself. You save the document, and the
document contains your work.

- **MUST** satisfy Level 2.
- **MUST** be able to emit a new copy of itself with current state embedded.
- **MUST** embed state in a form that does not execute (`<script
  type="application/json">`, never a JS literal).
- **MUST** validate and version-check embedded state on load, and **MUST**
  fall back to empty state rather than crash on a mismatch.
- **SHOULD** warn before overwriting, and **SHOULD** nudge people towards
  versioned filenames.

This is the [TiddlyWiki](https://iamsingle.app/entry/tiddlywiki) lineage, going
back to 2004 and still the reference implementation. Three apps in the directory
have been checked against this level and pass.

TiddlyWiki emits a byte-for-byte-sized copy of itself when you save, and keeps
its state in a `<script type="application/json">` block, exactly as described
below. [nash](https://iamsingle.app/entry/nash) does the full round trip in
27 KB: type a note, save, and the file you get back is a working copy of the app
carrying your text, which reopens offline with the note intact.
[Bento](https://iamsingle.app/entry/bento) is the most elaborate of the three,
with a readable JSON document at the top of the file and a deflate-compressed
runtime beneath it. Its save button rewrites the file in place through the File
System Access API, falling back to a download where that is unavailable.

It is the purest expression of the form and the easiest to get subtly wrong, so
read [02-persistence §6](02-persistence.md#6-the-self-saving-document) before you
attempt it.

---

## 3. Declaring conformance

Put the level in your document metadata so directories, crawlers and reviewers
do not have to work it out for themselves.

```html
<meta name="sfwa:level"    content="1">
<meta name="sfwa:version"  content="2.3.0">
<meta name="sfwa:license"  content="MIT">
<meta name="sfwa:source"   content="https://github.com/you/app">
<meta name="sfwa:network"  content="none">
```

`sfwa:network` takes one of:

| Value | Meaning |
|---|---|
| `none` | Never makes a network request. |
| `user` | Only on explicit user action, to a host the user names. |
| `declared` | Only to the hosts listed in `sfwa:hosts`. |
| `cdn` | Fetches subresources at load (Level 0 only). |

If `declared`, add `<meta name="sfwa:hosts" content="api.example.com,cdn.example.net">`.

---

## 4. Verification procedure

A conformance claim only means something if it can be falsified, so run this.

**Level 0**
1. Serve the file from a static host. Open it. It works.
2. `grep` the subresource URLs for `@latest`, `@^` and `@~`. Nothing found.

**Level 1**
1. Copy the file on its own into an empty directory, on a machine that holds no
   other copy of it.
2. Disconnect the network. Actually disconnect it. DevTools throttling has lied
   to people before.
3. Double-click the file. It opens over `file://` and does everything it should.
4. Reconnect, then reload with the Network panel open and the cache disabled.
   Requests for anything other than the document itself: zero.

**Level 2**
1. Enter some representative data. Export.
2. Clear all site data, IndexedDB and Local Storage included.
3. Import. What comes back means the same thing, even if the bytes differ.
4. Open the export in a text editor. You can tell what it says.

**Level 3**
1. Enter data. Save a new copy of the file.
2. Open that copy in a *different* browser profile. The data is there.
3. Corrupt the embedded state block by hand and reopen. The app starts empty and
   explains itself. It does not show a white screen.

Record what happened in the repository as `CONFORMANCE.md`, and re-run it before
every release. Level 1 regressions slip in easily and stay invisible on a
developer machine with a warm cache, which is the whole problem with them.

---

## 5. Non-goals

Things this specification deliberately does not ask of you:

- **Small file size.** A 900 KB self-contained app is more conformant than a
  40 KB app pulling three CDN scripts, and the directory bears that out.
  [TiddlyWiki](https://iamsingle.app/entry/tiddlywiki) at 6.6 MB and
  [FuzzyGraph](https://iamsingle.app/entry/fuzzygraph) at 1.3 MB both reach
  Level 1, while several apps a fraction of their size do not. Size is a quality
  attribute, covered in
  [03-build-tooling §6](03-build-tooling.md#6-size-budgets). It is not a
  conformance criterion.
- **No build step for the author.** The prohibition covers the *user*. Compiling
  a multi-file source tree down to one shipped file is entirely conformant, and
  past roughly 1,500 lines it is usually the right call.
- **Framework abstinence.** Preact, Alpine, Van, Mithril and Svelte's compiled
  output all fit comfortably. Portability is the goal, not purity.
- **Single-page-ness.** An SFWA can have as many views as it likes.
  [Bento](https://iamsingle.app/entry/bento) carries an editor, a viewer and the
  slide data in one file. "Single file" and "single page" are unrelated
  properties that happen to share an initial.
- **Offline-first UX.** Level 1 hands you offline capability. Designing a good
  offline experience is a separate craft.

---

## 6. Exit criteria

Move away from the single-file form when one of these becomes true. They are
signals, not failures.

| Signal | Why the form breaks |
|---|---|
| Shared mutable state between users | Somebody has to be the server of record; conflict resolution cannot live purely in the artifact. |
| Secrets that must be withheld from the operator | Everything in the file is readable. There is no such thing as a hidden key. |
| Regulatory audit trails | Append-only logs need a party the user cannot edit. |
| Sustained bundle over ~1 MB uncompressed | Parse and memory cost stop being free; code-splitting starts earning its complexity. |
| More than ~3 concurrent editors | Single-file merge conflicts scale badly. |
| Test suite bigger than the app | Keep the source multi-file and ship the build as one file. Still conformant. |

The first row needs a caveat, because [Bento](https://iamsingle.app/entry/bento)
does live collaboration and is still one self-contained file, because the
collaboration transport sits outside the artifact while the app itself stays
whole. Shared state pushes you out of the form only when the *app* has to become
a client of a server it cannot function without.

The last row is where most people go wrong. Source layout and distribution
artifact are two separate decisions, and conflating them is the most common
mistake in this entire document. Author however you like. Ship one file.

---

## 7. Glossary

- **SFWA.** Single-file web app, per §1.
- **Inlining.** Replacing a reference to a subresource with the thing itself.
- **Import map.** A `<script type="importmap">` block mapping bare specifiers to
  URLs. Level 0 only, unless the URLs it maps to are data URLs.
- **Self-saving.** Level 3 behaviour, where the document writes out an updated
  copy of itself.
- **BYOK.** Bring your own key. The user supplies their own API credential,
  which never leaves their machine except to reach the API it belongs to.
- **Level regression.** A change that quietly drops the artifact to a lower
  level. Adding a Google Font is the classic cause, and
  [Agent-Architecture](https://iamsingle.app/entry/agent-architecture) is a live
  example: self-contained apart from one font request.
