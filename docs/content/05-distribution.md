# 05. Distribution

The unit of distribution is a file. Behave accordingly.

---

## 1. Channels

An SFWA travels by routes closed to ordinary web apps. Design for several of
them.

| Channel | Notes |
|---|---|
| Static hosting | GitHub Pages, Netlify, Cloudflare Pages, S3. Free, instant. |
| GitHub release asset | Versioned, checksummed, permanent URL. The canonical download. |
| Gist | Renders as source; pair it with a raw-HTML preview service. |
| Email attachment | ⚠️ Many corporate filters strip or quarantine `.html`. Zip it. |
| Chat, Slack, Signal | Works. Recipients open by downloading. |
| USB stick, network share | The original use case, and it still needs no setup. |
| Git repository | The file effectively is the repository. |
| Printed QR to a hosted copy | For workshops and conferences. |
| Pasted into a model context | The whole app fits. Underrated. |

[Offline-HTML-Games-Pack](https://iamsingle.app/entry/offline-html-games-pack)
shows what the last few rows are worth: three hundred small games, each its own
HTML file, playable from a folder on a school laptop with the wifi off. No
installer, no store, no account. Try shipping that any other way.

⚠️ The email filter problem is real and it will catch you out. Corporate
gateways block HTML attachments because phishing arrives that way. Ship a `.zip`
or a hosted link as your primary path and treat the attachment as a bonus.

---

## 2. Static hosting

### GitHub Pages

Free, and it is where much of the directory lives.
[xlsx2md](https://iamsingle.app/entry/xlsx2md),
[nash](https://iamsingle.app/entry/nash) and
[Hypervault](https://iamsingle.app/entry/hypervault) all publish from
`github.io`, which keeps the source and the running app one click apart.

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push: { branches: [main] }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    environment: github-pages
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci && npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

### Headers worth setting

Where your host supports custom headers (`_headers` on Netlify and Cloudflare
Pages, `netlify.toml`, or S3 metadata):

```
/index.html
  Cache-Control: public, max-age=0, must-revalidate
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(), camera=(), microphone=(), interest-cohort=()
```

`must-revalidate` matters more here than it would elsewhere. The single file is
the whole app, so a stale cache serves a stale application, and there is no
hashed asset filename to break the tie for you.

### Compression

Single-file apps compress beautifully, since all that inlined text is highly
redundant. Confirm your host is serving Brotli or gzip:

```bash
curl -sI -H 'Accept-Encoding: br, gzip' https://example.com/ | grep -i content-encoding
```

A 700 KB artifact routinely crosses the wire in well under 150 KB, which is why
raw size matters most for `file://` distribution, where nothing gets compressed
at all.

---

## 3. Offline

A Level 1 app is already offline. There is nothing to build, and the only thing
to get right is telling people they can keep the file.

```html
<p class="hint">
  Everything here runs locally.
  <button id="save-copy">Save a copy</button> and it will keep working offline.
</p>
```

```js
document.getElementById('save-copy').addEventListener('click', async () => {
  const res = await fetch(location.href);       // hosted context only
  download(await res.text(), 'app.html', 'text/html');
});
```

⚠️ That works when hosted. Over `file://`, `fetch` on the document is blocked,
so detect the situation and hide the button, or fall back to a link with the
`download` attribute pointed at the current URL.

### Installability (Level 0 only)

Want the app to appear as an installed application? You need a web app manifest
and a minimal service worker, and both are separate files, which costs you
single-file conformance for the *installed* experience.
[minimal-pwa](https://iamsingle.app/entry/minimal-pwa) is worth reading here,
because it strips that setup down to the fewest files anyone has managed and
makes the trade explicit.

An honest compromise: ship the pure single file as the canonical artifact and
offer an installable hosted variant as a separate deliverable, with its
conformance level stated plainly on both.

You can inline the manifest as a data URL, which does keep it to one file:

```html
<link rel="manifest" href='data:application/manifest+json,{"name":"App","start_url":"./","display":"standalone"}'>
```

Browser support for data-URL manifests is inconsistent. Test it before you build
anything on top of it.

---

## 4. Embedding

To let other people embed your app, make the sandbox contract explicit:

```html
<iframe src="https://example.com/app.html"
        sandbox="allow-scripts allow-downloads"
        referrerpolicy="no-referrer"
        title="Calculator"
        loading="lazy"></iframe>
```

Note the deliberate omission of `allow-same-origin`. Without it the iframe gets
an opaque origin, which means **no `localStorage` and no IndexedDB**. An app
meant for embedding therefore has to work from in-memory or URL state alone.
Design for that, or document that embedding turns persistence off.

To prevent embedding you need `X-Frame-Options` or `frame-ancestors`, and
neither is available from a `<meta>` tag. A hosted deployment can set them. A
file travelling on its own cannot.

---

## 5. Metadata conventions

Machine-readable metadata is what makes an app discoverable, catalogable and
reviewable. Put this in every artifact.

```html
<title>Ledger: offline double-entry bookkeeping</title>
<meta name="description" content="Double-entry bookkeeping in a single HTML file. No account, no network, no tracking.">
<meta name="author" content="Your Name">

<meta name="sfwa:level"    content="2">
<meta name="sfwa:version"  content="2.3.0">
<meta name="sfwa:license"  content="MIT">
<meta name="sfwa:source"   content="https://github.com/you/ledger">
<meta name="sfwa:network"  content="none">
<meta name="sfwa:updated"  content="2026-07-28">
<meta name="sfwa:tags"     content="finance,accounting,offline">

<link rel="license" href="https://spdx.org/licenses/MIT.html">
<link rel="canonical" href="https://you.github.io/ledger/">
```

### Structured data

For crawlers and directories:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Ledger",
  "applicationCategory": "FinanceApplication",
  "operatingSystem": "Any browser",
  "softwareVersion": "2.3.0",
  "license": "https://spdx.org/licenses/MIT.html",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }
}
</script>
```

### Licence header

Keep it in the source, at the top, in a comment. It survives copying in a way
that a `LICENSE` file sitting in a repository never will.

```html
<!--
  Ledger 2.3.0 · https://github.com/you/ledger
  Copyright (c) 2026 Your Name · MIT License
  Bundled dependencies and their licences are listed at the end of this file.
-->
```

---

## 6. Machine-readable app description

The whole app fits in a model's context window, so make it easy to reason about.
Add a short structured summary as a non-executing block:

```html
<script type="text/markdown" id="about">
# Ledger

Double-entry bookkeeping in one HTML file.

- **Level:** 2 (self-contained, portable)
- **Storage:** IndexedDB, plus JSON export
- **Network:** none
- **Entry point:** `init()`, search for `§G BOOT`
- **State shape:** see `initial` in `§C STATE`
- **Export format:** `ledger.export` v4, documented in `§D PERSIST`
</script>
```

Somebody opening `view-source:` gets oriented in ten seconds, and anybody
pointing a model at the file gets a map instead of two thousand lines of
undifferentiated text. If you publish an `llms.txt` at your hosted origin too,
keep the two consistent.

---

## 7. Versioning

Semantic versioning, with one addition specific to this form: **the export
schema version is a separate, independently incrementing integer.**

- App version changes on every release.
- Schema version changes only when the persisted shape changes.
- A major app version bump does not license a breaking schema change without a
  migration.

Surface the version in the UI as well as the metadata. Somebody holding a
downloaded copy has no other way to know what they have.

```js
document.getElementById('version').textContent =
  document.querySelector('meta[name="sfwa:version"]').content;
```

### Update notification without a network

A Level 1 app cannot check for updates, so do not pretend otherwise. What you
can do:

- Put a permanent link to the canonical source in the footer.
- Show the build date next to the version.
- If the app is hosted, an optional, clearly labelled, off-by-default version
  check is acceptable. It moves `sfwa:network` to `declared` and has to be
  disclosed.

---

## 8. Documentation to ship alongside

The file is self-contained. Its documentation should be too.

| Artifact | Contents |
|---|---|
| `README.md` | What it does, screenshot, download link, conformance level, reproduction instructions. |
| `CONFORMANCE.md` | Level claimed, date verified, browsers tested, verification output. |
| `CHANGELOG.md` | Per release. Call out schema changes prominently. |
| `SHA256SUMS` | One line per released artifact. |
| In-app help | A `#/help` route. Somebody with a downloaded copy cannot reach your README. |

That last row gets skipped more than any other and is needed more than any
other. A file that travels away from its repository has to carry its own
instructions.

---

## 9. Getting listed in the directory

[iamsingle.app](https://iamsingle.app) catalogues single-file web apps, and
submissions arrive as a pull request against the repository. An automated check
runs on every one of them, so it saves everybody time to run the same checks
yourself first.

What the review looks for:

1. **A public source repository**, with the shipped artifact reproducible from
   it.
2. **A live URL** where the app can be tried without downloading anything. Point
   this at the app itself, never at a landing page describing the app. Getting
   this wrong is common, and it makes every automated measurement about your
   entry meaningless, usually in your disfavour.
3. **A conformance level that matches what the artifact does.** An inaccurate
   Level 1 claim is the most common reason a submission bounces.
4. **A licence**, SPDX-identified.
5. **A one-line description** saying what the app does, with no mention of what
   it is built with.
6. **A screenshot** of the app in use.
7. **Clean automated review:** no secrets in the file, no obfuscated code, no
   undeclared network calls, no bundled analytics.

Passing entries get a security-audit badge they can embed, scored on those
checks. Anything flagged comes back with the specific finding attached, so you
can fix it and ask for a recheck.

Run this before submitting:

```bash
# undeclared network sinks
grep -nE "fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource" dist/index.html

# accidental credentials
grep -nEi "api[_-]?key|secret|password|bearer |sk-[a-z0-9]{20,}" dist/index.html

# level check
grep -c "https://" dist/index.html    # every hit should be a link a human clicks
```

The third command is the one that catches people. Every absolute URL in a Level
1 artifact should be a hyperlink somebody clicks, never something the browser
goes and fetches on its own.

---

## 10. Release checklist

- [ ] Version bumped in `package.json` and injected into metadata
- [ ] `CHANGELOG.md` updated, schema changes called out
- [ ] Level 1 verification re-run on a genuinely offline machine
- [ ] Tested in Chrome, Firefox and Safari, over `https://` and `file://`
- [ ] Tested on a phone, since a downloaded HTML file on mobile is a rough
      experience and worth confirming
- [ ] Export from the previous version imports cleanly into this one
- [ ] Size within budget, CI gate passing
- [ ] `SHA256SUMS` generated and attached
- [ ] Artifact attached to a tagged GitHub release
- [ ] Hosted copy updated and cache-busted
- [ ] In-app help reflects any new features
