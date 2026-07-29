# 04. Security and Privacy

An app with no server has a smaller attack surface and a stranger one.

---

## 1. Threat model

Be clear from the start about who you are defending against, and about what you
cannot defend against at all.

### In scope

| Threat | Vector |
|---|---|
| Malicious input data | An imported file or pasted content executes code or corrupts state. |
| Supply chain compromise | A CDN or npm dependency ships hostile code. |
| Exfiltration | The app quietly sends user data somewhere. |
| Tampering in transit | The file is modified between author and user. |
| Cross-app storage collision | Another `file://` document reads your `localStorage`. |
| Credential leakage | A user-supplied API key ends up somewhere it should not. |

### Out of scope, structurally

**You cannot hide anything from the user.** Every byte is readable. No secrets,
no hidden logic, no licence check that cannot be measured and removed. Design on that basis.

**You cannot prevent modification.** Anyone can edit the file and pass it on.

**You cannot enforce anything server-side**, because there is no server. Rate
limits, quotas, entitlements and validation are all advisory once they run on
somebody else's machine.

Need any of those? Then you need a server, and that is an architecture decision
rather than a bug waiting to be patched.

### What you can actually promise

An SFWA cannot keep secrets *from* its user, and it is unusually good at keeping
its user's secrets from everybody else, you included. A Level 1 app with
`connect-src 'none'` is incapable of exfiltration, and you can demonstrate that
instead of asserting it. A competent reviewer confirms it in about two minutes. Very little hosted software can make that claim. Lean on it, because it
is the strongest privacy argument the form has.

---

## 2. Content Security Policy in a `<meta>` tag

HTTP headers are usually off the table, since the file may well be opened from
disk. CSP through `<meta http-equiv>` still works and is worth the six lines.

### Recommended baseline for a Level 1 app

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'unsafe-inline';
  style-src 'unsafe-inline';
  img-src data: blob:;
  font-src data:;
  media-src data: blob:;
  connect-src 'none';
  worker-src blob:;
  base-uri 'none';
  form-action 'none';
">
```

`'unsafe-inline'` looks alarming and is unavoidable when your script is inline.
Read past it, because the other directives are the ones doing the work.

`default-src 'none'` means no external resource of any kind loads.

`connect-src 'none'` blocks `fetch`, `XMLHttpRequest`, WebSocket and
`sendBeacon` outright, so injected code has nowhere to send anything. This is
the line that turns your privacy claim from a promise into something
enforceable.

`base-uri 'none'` stops an injected `<base>` tag redirecting every relative URL
in the document.

`form-action 'none'` stops an injected form posting anywhere.

### If the app must call an API

```
connect-src https://api.anthropic.com;
```

Name every host. Never `connect-src *`. Your CSP allowlist is a
machine-readable version of your privacy policy, and reviewers will read it that
way whether or not you intended it.

### Limitations of meta-tag CSP

⚠️ These are **ignored** in a `<meta>` tag and need real headers:

- `frame-ancestors`
- `report-uri` and `report-to`
- `sandbox`

⚠️ The meta tag **must come before anything it governs**, so put it immediately
after `<meta charset>`. A CSP declared below your `<style>` block does nothing
for that block.

### Hash-based CSP for bundled builds

If you bundle, you can drop `'unsafe-inline'` entirely by hashing the script at
build time:

```js
import { createHash } from 'node:crypto';
const hash = createHash('sha256').update(scriptText).digest('base64');
// script-src 'sha256-<hash>'
```

Now only your exact script runs. Anything injected, including something written
into the file by a compromised toolchain, is refused. That is the strongest
posture available to a single-file app and it costs about six lines of build
script.

---

## 3. Subresource Integrity

For Level 0 apps pulling from a CDN, SRI is not optional.

```html
<script src="https://cdn.example.com/lib@1.2.3/dist/lib.min.js"
        integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
        crossorigin="anonymous"></script>
```

Generate:

```bash
curl -sL https://cdn.example.com/lib@1.2.3/dist/lib.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

⚠️ SRI does not cover ES modules loaded through an import map in every engine
today, and it never covers *transitive* imports. A CDN module that imports a
second module can have that second module swapped underneath it, hash intact.
This is exactly why CDN dependencies cap you at Level 0: the artifact is no
longer the whole story.

⚠️ While you are auditing subresource URLs, check the scheme.
[htpad](https://iamsingle.app/entry/htpad) is a 3 KB handwritten-notes app that
loads d3 from `http://d3js.org`, over plain HTTP. Browsers block that as mixed
content on any https page, so the dependency never arrives and whatever needed
it does not work. Insecure subresources stay quiet in local testing and then fail
in production, which is the ordering that costs you the most time.

---

## 4. XSS in an app with no server

Losing the server changes who pays for an XSS bug. Injected code runs with full
access to local data, and in an offline app the local data is all the data there
is.

### The rule

**`innerHTML` is for build-time constants only.** Anything derived from user
input, imported files, URLs or the clipboard goes through `textContent`,
`setAttribute` or node construction.

```js
// Safe: escaped by the platform
node.textContent = item.label;
node.setAttribute('title', item.label);
node.append(document.createTextNode(item.label));

// Unsafe with any runtime-derived value
node.innerHTML = `<b>${item.label}</b>`;
node.insertAdjacentHTML('beforeend', userText);
element.setAttribute('onclick', handler);
```

### Sinks people forget

| Sink | Why it is dangerous |
|---|---|
| `element.setAttribute('href', url)` | `javascript:` URLs execute. |
| `element.setAttribute('src', url)` | Same, plus `data:text/html`. |
| `new Function(str)`, `eval(str)` | Obvious in isolation, and they hide inside "formula" and "template" features. |
| `<svg>` from user input | SVG carries `<script>` and event handlers. |
| `JSON.parse` reviver | Runs user-influenced code paths. |
| `URL.createObjectURL(blob)` with user MIME | A `text/html` blob URL runs as your origin. |

The directory is full of that third row.
[FuzzyGraph](https://iamsingle.app/entry/fuzzygraph) is a graphing app, so
evaluating user-entered equations is the entire product, and the automated audit
duly flags an `eval()` call in it.
[TiddlyWiki](https://iamsingle.app/entry/tiddlywiki) trips both `eval()` and
`new Function()` for a related reason: a plugin system has to run code it was
not shipped with. Both are places a reviewer has to stop and think, which is why the audit reports
them instead of failing them.

If you find yourself writing a formula evaluator, the safe version is a parser
you control, never the JavaScript engine. More work, and it cannot be
talked into reading `localStorage`.

URL validation:

```js
function safeUrl(raw) {
  try {
    const u = new URL(raw, location.href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}
```

### If you must render rich text

Some apps genuinely need to display Markdown or HTML. Three options, in order of
preference:

1. Render into a sandboxed iframe with `sandbox` and neither `allow-scripts` nor
   `allow-same-origin`. Strongest, and it needs no dependency.
2. Sanitise with a maintained library (DOMPurify) inlined into the build.
3. Do not write your own sanitiser. It will be wrong, and your own testing will
   not be what tells you.

```html
<iframe sandbox srcdoc="" id="preview" referrerpolicy="no-referrer"></iframe>
```

```js
preview.srcdoc = renderedHtml;   // scripts cannot run; no access to parent
```

---

## 5. Supply chain

The single-file form hands you an unusually strong position here, so use it.

**Reduce.** Every dependency is code a reviewer has to read inside your
artifact. A 50-line hand-rolled date formatter genuinely beats a 12 KB library
in this context, because the reviewability of the whole file is the product you
are selling.

**Pin.** Exact versions, committed lockfile, `npm ci`.

**Vendor deliberately.** For one small critical dependency, copying the source
in with a version comment and a licence header is defensible. You review it once
instead of trusting every release that follows.

**Audit the output, not just the input.** Your artifact is one file, so you can
grep it before release:

```bash
grep -nE "fetch\(|XMLHttpRequest|sendBeacon|WebSocket|new Function|eval\(|atob\(" dist/index.html
```

Every hit should be something you can explain in a sentence. This check takes
seconds on a single-file app and is close to impossible on a chunked SPA, which
is one of the quieter advantages of the form. Put it in CI. It is roughly what
the directory runs against every submission.

**Preserve licences.** `legalComments: 'inline'` in esbuild. Stripping licence
headers out of MIT-licensed dependencies is a licence violation, and most
minifier configurations do it by default.

---

## 6. Handling user-supplied API keys (BYOK)

The right pattern for an SFWA that talks to a paid API: the user brings their
own credential and you never see it.

### Storage tiers, worst to best

| Approach | Risk | Use when |
|---|---|---|
| Hardcoded in the file | Catastrophic. The key is public. | Never. |
| In the URL hash | Leaks via screenshots, shared links, history. | Never. |
| `localStorage`, plaintext | Readable by any script that achieves injection, and it persists indefinitely. | Convenience mode, disclosed. |
| `sessionStorage` | Cleared when the tab closes. Smaller window. | Reasonable default. |
| In memory only | Retyped every session. | Sensitive keys, short sessions. |
| Encrypted with a passphrase | Best available. See [02-persistence §10](02-persistence.md#10-encryption-at-rest). | Long-lived, high-value keys. |

### Non-negotiables

1. **Say exactly where the key goes**, in one sentence next to the input:
   *"Your key is stored in this browser only and is sent only to
   api.example.com."*
2. **Constrain it in CSP.** `connect-src https://api.example.com` makes the key
   structurally incapable of going anywhere else. Say so in the UI, because it
   is a checkable claim and worth far more than a privacy policy.
3. **Never log it.** Not to `console`, not in an error message, not in an export
   file. Strip it explicitly on the export path.
4. **Give people a clear-key button** that is visible, never buried in
   settings.
5. **`type="password"` and `autocomplete="off"`** on the input.
6. **Mask it after entry.** Show `sk-…4f2a` and never the whole thing.

```js
const redact = (k) => k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '';
const persistable = ({ apiKey, ...rest }) => rest;   // key never enters exports
```

⚠️ **CORS is the constraint that will actually stop you.** Plenty of APIs refuse
browser-origin requests outright, and some accept them only from an allowlisted
origin, which a file on somebody's desktop does not have. Check before you
design around it.

There is a way around this worth knowing:
[paper-viewer-local-llm](https://iamsingle.app/entry/paper-viewer-local-llm)
talks to LM Studio or Ollama running on the user's own machine. The API is
local, the key problem disappears, and nothing leaves the device. Declare it
honestly, with `sfwa:network` set to `declared` and the localhost endpoint
listed in `sfwa:hosts`.

---

## 7. Privacy defaults

The form invites a strong privacy position. Take the whole thing.

**No telemetry.** None at all. Not anonymous analytics, not error reporting, not
a version-check ping. People choose these apps for the silence.

**`connect-src 'none'`** wherever you can manage it, and say so in the README.

**No third-party fonts, scripts or images.** A Google Font is a request to
Google carrying the user's IP address and referrer, every time the app opens.

**`referrerpolicy="no-referrer"`** on outbound links, or the destination learns
the URL, which in a hash-state app can mean it learns the user's data.

**Hash, not query string,** for URL state, because fragments are never
transmitted.

**Say all this inside the document**, not only in a repository README that
somebody with a downloaded copy will never see:

```html
<footer>
  <p>This app runs entirely in your browser. It makes no network requests
     and stores nothing outside this device. <a href="#/privacy">Details</a>.</p>
</footer>
```

---

## 8. Distribution integrity

A file that travels by email and USB stick needs some way to prove it is the
file you shipped.

- **Publish `sha256sum` with every release**, per
  [03-build-tooling §5](03-build-tooling.md#5-continuous-integration).
- **Consider signing.** A `minisign` or GPG signature over the artifact can be
  verified without trusting GitHub.
- **Embed version and commit** in metadata so somebody can identify the copy in
  front of them.
- **Document the verification command** somewhere users will actually see it.

```md
    sha256sum index.html
    # 4f3a9c…  compare with SHA256SUMS in the v2.3.0 release
```

None of this stops a determined attacker from circulating a modified copy under
your name. It does make the honest path checkable, which is as far as anyone can get.

---

## 9. `file://` specific hazards

⚠️ **Storage may be shared.** Some browsers have historically treated every
`file://` document as one origin, so another downloaded HTML file could read
your app's `localStorage`. Namespace your keys, and never put credentials in
`file://` browser storage.

⚠️ **Modules and `fetch` are blocked**, by design. See
[03-build-tooling §2.1](03-build-tooling.md#21-the-skeleton).

⚠️ **No service workers.** Offline caching is both unavailable and unnecessary.

⚠️ **Secure-context APIs vary.** `crypto.subtle` and `crypto.randomUUID` work on
`file://` in current Chrome and Firefox, which treat it as potentially
trustworthy. That is not universal and it has changed before, so feature-detect:

```js
const uuid = () => crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
```

---

## 10. Security review checklist

Run before every release.

- [ ] CSP present, placed before all other content, with `connect-src` set to
      `'none'` or an explicit allowlist
- [ ] `base-uri 'none'` and `form-action 'none'` set
- [ ] No `innerHTML`, `insertAdjacentHTML` or `outerHTML` with runtime-derived
      values
- [ ] No `eval`, `new Function` or `setTimeout(string)`, or a written
      justification wherever they are unavoidable
- [ ] All URLs from user data validated against a protocol allowlist
- [ ] Every subresource on `https://`, never `http://`
- [ ] Imported files validated *and* schema-checked before use
- [ ] Embedded state stored as `application/json`, never as executable JS
- [ ] `<` escaped as `\u003c` in any serialised state
- [ ] No credentials in source, exports, logs or URLs
- [ ] Dependencies pinned, lockfile committed, licences preserved
- [ ] `grep` audit of network and dynamic-eval sinks passing in CI
- [ ] Checksum published, version embedded in metadata
- [ ] Privacy behaviour stated inside the app, not only in the repository
