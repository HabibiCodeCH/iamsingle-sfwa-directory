# 03. Build and Tooling

The user must never need a build. You often should.

---

## 1. Two legitimate paths

| | **No build** | **Bundle to one file** |
|---|---|---|
| Source layout | One file, edited directly | Many files, compiled to one |
| Highest level reachable | Level 1, with effort | Level 3, comfortably |
| Dependencies | Vendored by hand, or CDN (Level 0) | npm, tree-shaken |
| Editing loop | Save, refresh | Save, HMR |
| Practical ceiling | ~1,500 lines | No practical ceiling |
| Reviewability | Perfect: source *is* artifact | Requires publishing source |

Go **no build** when the app is small enough to hold in your head and you want
the source to be the artifact. Go **bundling** the moment you want types, tests,
npm dependencies, or a second author.

Both ship one file, both are fully conformant, and neither is more virtuous than
the other.

---

## 2. The no-build path

### 2.1 The skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>App</title>
<meta name="sfwa:level" content="1">
<meta name="sfwa:version" content="0.1.0">
<meta name="sfwa:network" content="none">
<style>/* … */</style>
</head>
<body>
<main id="app"></main>
<script>
'use strict';
/* … */
</script>
</body>
</html>
```

⚠️ **Classic script, not `type="module"`.** This is the most consequential
decision on the no-build path. Module scripts go through CORS, `file://` has no
origin to satisfy it, and the result is an app that silently does nothing when
double-clicked. If you want module *syntax* for your editor's benefit, you have
already chosen the bundling path, so skip to §3.

A classic script costs you top-level `await` (wrap async boot in an IIFE),
`import` and `export` (use an IIFE with explicit globals, or one big scope), and
automatic strict mode (write `'use strict'` yourself).

### 2.2 Import maps (Level 0 only)

If Level 0 is acceptable, import maps give you tidy dependency management with
no bundler at all.

```html
<script type="importmap">
{
  "imports": {
    "preact": "https://esm.sh/preact@10.24.3",
    "preact/hooks": "https://esm.sh/preact@10.24.3/hooks",
    "htm/preact": "https://esm.sh/htm@3.1.1/preact"
  }
}
</script>
<script type="module">
  import { render } from 'preact';
  import { html } from 'htm/preact';
  render(html`<h1>Hello</h1>`, document.getElementById('app'));
</script>
```

Pin exact versions. Never `@latest`, never a range. A CDN that starts serving a
new minor version can break an app you have not touched in a year, and you will
have no idea why.

Prefer a CDN that pins transitively. `esm.sh` rewrites nested imports to pinned
URLs. Not all of them do.

Declare it: `<meta name="sfwa:network" content="cdn">` plus
`<meta name="sfwa:hosts" content="esm.sh">`.

Add SRI where you can. Import maps still do not support integrity metadata for
mapped specifiers across all engines, which is precisely why this is Level 0 and
not Level 1.

### 2.3 Vendoring by hand

The bridge from Level 0 to Level 1 without taking on a bundler. Download the
dependency once, paste it into a `<script>` block, record the version and hash
next to it.

```html
<!-- vendor: preact 10.24.3, MIT, sha256-VOwCiOe…  -->
<script>/* pasted UMD build */</script>
```

Fine for one or two small UMD libraries. It stops being fine at about three, or
the first time you need to update one of them, and that is your cue to move to
§3.

---

## 3. Bundling to a single file

### 3.1 Vite plus vite-plugin-singlefile

Shortest path from a normal project to one HTML file.

```bash
npm create vite@latest my-app -- --template vanilla-ts
cd my-app
npm i -D vite-plugin-singlefile
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,   // inline every asset regardless of size
    chunkSizeWarningLimit: 2000,
    reportCompressedSize: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
```

`npm run build` gives you `dist/index.html` with everything in it.

⚠️ **Check the output.** Two things routinely escape
inlining: fonts referenced from CSS `@font-face` with absolute URLs, and assets
referenced by string concatenation instead of a static `import`. Run the Level 1
verification from [00-spec §4](00-spec.md#4-verification-procedure) on every
release and you will catch both.

### 3.2 esbuild plus a small inliner

Fewer moving parts, more explicit, no plugin ecosystem to track. esbuild does
not emit HTML, so you bundle JS and CSS and do the inlining yourself.

```json
{
  "scripts": {
    "build": "node build.mjs",
    "dev": "node build.mjs --watch"
  }
}
```

```js
// build.mjs
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: !watch,
  legalComments: 'inline',       // keep dependency licences in the artifact
  loader: {
    '.svg':  'text',             // import icon from './icon.svg'  → string
    '.png':  'dataurl',
    '.woff2':'dataurl',
    '.wasm': 'binary',
  },
  write: false,
};

async function build() {
  const js  = (await esbuild.build(options)).outputFiles[0].text;
  const css = (await esbuild.build({ ...options, entryPoints: ['src/main.css'] }))
                .outputFiles[0].text;
  const tpl = await readFile('src/index.html', 'utf8');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;

  // See the warning below. Without this, a bundled string containing
  // </script> closes the script element early and breaks the artifact.
  const safeJs = js.replaceAll('</script', '<\\/script');

  const html = tpl
    .replace('<!--CSS-->', `<style>\n${css}\n</style>`)
    .replace('<!--JS-->',  `<script>\n${safeJs}\n</script>`)
    .replace('__VERSION__', version);

  await mkdir('dist', { recursive: true });
  await writeFile('dist/index.html', html);
  console.log(`dist/index.html: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
}

await build();
if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  fsWatch('src', { recursive: true }, () => build().catch(console.error));
}
```

⚠️ **Escape the closing tag.** Any bundled string literal containing
`</script>` will terminate your script block where the parser finds it, not
where you meant. esbuild does not guard against this when you inline by hand,
so the `safeJs` line above is all that stands between you and a broken artifact.
The sequence `<\/script` is a valid JavaScript string escape that parses to
the same thing, so apply the replacement unconditionally and stop thinking about
it.

### 3.3 Inlining assets in source

With the loaders above:

```js
import iconSvg from './icons/save.svg';        // string
import logoPng from './logo.png';              // data: URL
import wasmBin from './engine.wasm';           // Uint8Array

document.querySelector('#save').innerHTML = iconSvg;   // trusted, build-time only
img.src = logoPng;
const { instance } = await WebAssembly.instantiate(wasmBin, imports);
```

`innerHTML` on a build-time-imported SVG is fine because nothing about the value
is user-controlled. Do not carry that reasoning over to runtime data. See
[04-security §4](04-security.md#4-xss-in-an-app-with-no-server).

Base64 inflates binary by about a third, so a 400 KB WASM module costs you
130 KB of pure encoding overhead. At that point either accept that Level 1 might
not be worth it, or use the `binary` loader, which emits a compact typed-array
literal instead of a data URL.

---

## 4. Development loop

### Serve locally

Do not develop against `file://`. Module scripts, `fetch` and workers all behave
differently there. Develop over HTTP and *verify* over `file://`.

```bash
npx serve dist          # or: python3 -m http.server -d dist
```

### Live reload without a framework

```html
<!-- dev only; stripped in production builds -->
<script>
  if (location.hostname === 'localhost') new EventSource('/esbuild').onerror = () => location.reload();
</script>
```

esbuild's serve mode exposes `/esbuild` as an SSE endpoint that closes on
rebuild. Using the close as a reload trigger is an accident of the design, and a
reliable one.

### Testing

Playwright is the right tool here because it drives the actual artifact rather
than a dev-server approximation of it.

```js
// tests/app.spec.js
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const FILE = pathToFileURL(resolve('dist/index.html')).href;

test('boots from file:// with no network', async ({ page }) => {
  const requests = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith('file:')) requests.push(url);
    route.continue();
  });
  await page.goto(FILE);
  await expect(page.locator('body[data-ready="true"]')).toBeVisible();
  expect(requests, `unexpected network: ${requests.join(', ')}`).toHaveLength(0);
});

test('state survives export and import', async ({ page }) => {
  await page.goto(FILE);
  await page.fill('#new-item', 'buy resin');
  await page.press('#new-item', 'Enter');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export'),
  ]);
  const path = await download.path();
  await page.click('#reset');
  await page.setInputFiles('#import-file', path);
  await expect(page.getByText('buy resin')).toBeVisible();
});
```

The first test is the one worth having. It turns your Level 1 claim from an
assertion into something that fails in CI the day a colleague adds a Google
Font.

---

## 5. Continuous integration

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run build
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test

      - name: Size report
        run: |
          SIZE=$(stat -c%s dist/index.html)
          GZIP=$(gzip -c dist/index.html | wc -c)
          echo "raw: $((SIZE/1024)) KB  gzip: $((GZIP/1024)) KB" | tee size.txt
          test "$SIZE" -lt 1048576 || { echo "::error::artifact exceeds 1 MB"; exit 1; }

      - name: Checksums
        run: sha256sum dist/index.html > dist/SHA256SUMS

      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/index.html
            dist/SHA256SUMS
            size.txt
```

`stat -c%s` is GNU syntax and works on `ubuntu-latest`. On a macOS runner it is
`stat -f%z`.

Shipping a checksum alongside the artifact is what turns "download this HTML
file and run it" from a leap of faith into a defensible instruction.

---

## 6. Size budgets

A quality measure. House rules, with real examples from the directory:

| Band | Uncompressed | Interpretation | In the wild |
|---|---|---|---|
| Green | < 100 KB | Loads instantly anywhere | [xlsx2md](https://iamsingle.app/entry/xlsx2md) 16 KB, [orbital-notebook](https://iamsingle.app/entry/orbital-notebook) 63 KB |
| Yellow | 100–500 KB | Normal for a framework app with inlined assets | [Hypervault](https://iamsingle.app/entry/hypervault) 178 KB |
| Orange | 500 KB – 1 MB | Justify it. Usually fonts, images or WASM | [Bento](https://iamsingle.app/entry/bento) 643 KB |
| Red | > 1 MB | Drop an asset, or accept that this wants to be several files | [FuzzyGraph](https://iamsingle.app/entry/fuzzygraph) 1.3 MB, [TiddlyWiki](https://iamsingle.app/entry/tiddlywiki) 6.6 MB |

Red still passes. TiddlyWiki carries twenty years of plugins in one file, sits
at Level 1, and opens instantly from disk. Treat the band as a prompt to justify
the weight.

Where the weight usually goes:

1. **Base64 images.** A single photograph can outweigh the entire rest of the
   app. Prefer SVG, and if you need raster, resize hard and reach for WebP or
   AVIF.
2. **Web fonts.** 20 to 60 KB per weight after base64. Subset aggressively or
   fall back to `system-ui`.
3. **A framework you are barely using.** Preact is around 5 KB gzipped, React
   with React-DOM closer to 45 KB. Weigh that against what you actually get.
4. **Icon libraries imported whole.** Import the six icons you use.
5. **Date and i18n libraries.** `Intl.DateTimeFormat` and
   `Intl.RelativeTimeFormat` are built in and free.

There is a sixth that deserves its own mention: **shipping a compiler**. Both
[codeflow](https://iamsingle.app/entry/codeflow) and
[hermes-ui](https://iamsingle.app/entry/hermes-ui) load Babel standalone at
runtime so they can transpile in the browser. It works, and it costs several
hundred kilobytes plus a CDN dependency plus your Level 1 claim. Transpile at
build time instead.

Inspect what you shipped:

```bash
npx esbuild src/main.js --bundle --minify --analyze --outfile=/dev/null
```

Gzip is unreasonably effective on inlined text, and an 800 KB single-file app
often crosses the wire in under 150 KB. Optimise raw size for parse cost and for
`file://` distribution, where nothing is compressed at all.

---

## 7. Reproducible builds

If you are asking people to trust an artifact, they should be able to rebuild it
to the same bytes.

- **Commit the lockfile** and install with `npm ci`.
- **Pin the Node version** in `.nvmrc` and in CI.
- **Avoid build-time nondeterminism.** No timestamps, no `Math.random()`, no git
  hashes in the output unless you record them too.
- **Set `SOURCE_DATE_EPOCH`** if any tool insists on embedding a date.
- **Publish the checksum** with the exact command that reproduces it:

```md
## Reproducing this build
    git checkout v2.3.0
    npm ci
    npm run build
    sha256sum dist/index.html
    # → 4f3a…  (matches SHA256SUMS in the v2.3.0 release)
```

---

## 8. Source maps

Inline source maps make debugging pleasant and roughly double the file size. The
compromise that suits most projects:

- Ship no source map in the release artifact.
- Publish `index.html.map` beside it in the GitHub release for anyone who wants
  to debug.
- Use inline maps in development builds only.

```js
minify: !dev,
sourcemap: dev ? 'inline' : 'external',
```

---

## 9. Tooling checklist

- [ ] `npm run build` produces exactly one file in `dist/`
- [ ] That file opens correctly by double-clicking
- [ ] Playwright "no network" test present and passing in CI
- [ ] `</script>` escaping applied to all inlined JS
- [ ] Version injected from `package.json` into `<meta name="sfwa:version">`
- [ ] Size gate enforced in CI
- [ ] Checksums published with each release
- [ ] Dependency licences preserved (`legalComments: 'inline'`)
- [ ] Reproduction instructions in the README
