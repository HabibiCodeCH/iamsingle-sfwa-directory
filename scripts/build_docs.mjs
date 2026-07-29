#!/usr/bin/env node
// Pre-renders the SFWA docs (docs/content/*.md) into static pages, one per
// doc, the same way build_pages.mjs pre-renders one static page per
// directory entry: so crawlers that don't execute JavaScript (most LLM
// crawlers) see the real content, not an empty shell waiting on fetch().
//
// The markdown itself is parsed by the project's own safe-markdown renderer
// (vendored in docs/vendor/markdown-renderer.min.js) run inside a tiny DOM
// shim, so build-time rendering and the browser-side renderer used on
// /resources are the exact same parser. The shim only implements the handful
// of DOM calls emit.js actually makes: createElement, createTextNode,
// createDocumentFragment, setAttribute, appendChild, textContent, style.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://iamsingle.app';

const DOCS = [
  { file: '00-spec.md', slug: 'spec', title: 'The SFWA Specification',
    desc: 'What actually counts as a single-file app? Four conformance levels with a test procedure.' },
  { file: '01-architecture.md', slug: 'architecture', title: 'Architecture',
    desc: 'How do you structure 2,000 lines of app in one file without it rotting?' },
  { file: '02-persistence.md', slug: 'persistence', title: 'Persistence and State',
    desc: 'Where does data live when there is no server? Includes the self-saving document pattern.' },
  { file: '03-build-tooling.md', slug: 'build-tooling', title: 'Build and Tooling',
    desc: 'No-build vs. bundle-to-one-file. Vite, esbuild, and a 40-line inliner.' },
  { file: '04-security.md', slug: 'security', title: 'Security and Privacy',
    desc: 'Threat model, CSP in a meta tag, SRI, BYOK keys, local encryption.' },
  { file: '05-distribution.md', slug: 'distribution', title: 'Distribution',
    desc: 'Hosting, offline use, file:// gotchas, metadata conventions, getting listed.' },
  { file: '06-cookbook.md', slug: 'cookbook', title: 'Cookbook',
    desc: 'Sixteen copy-paste recipes: reactive state, inline workers, inline WASM, URL state, undo stacks.' },
  { file: '07-checklist.md', slug: 'checklist', title: 'Review Checklist',
    desc: 'The quality bar. Use it before shipping, or when reviewing someone else’s submission.' },
];

// Doc 0 (the spec) has no separate landing page in front of it — /docs/ IS
// doc 0. Every other doc gets its own /docs/<slug>/.
const routeOf = (index) => (index === 0 ? '/docs/' : `/docs/${DOCS[index].slug}/`);
const FILE_TO_ROUTE = Object.fromEntries(DOCS.map((d, i) => [d.file, routeOf(i)]));

// ---- minimal DOM shim: just enough for emit.js ----
class TextNode {
  constructor(value) { this.nodeType = 3; this.value = String(value); }
}
class Frag {
  constructor() { this.nodeType = 11; this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
}
class El {
  constructor(tag) {
    this.nodeType = 1; this.tag = tag; this.children = []; this.attrs = {}; this._style = {};
    const self = this;
    this.style = new Proxy({}, { set(_, k, v) { self._style[k] = v; return true; } });
  }
  setAttribute(name, val) { this.attrs[name] = String(val); }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.children = [new TextNode(v)]; }
}
const shimDocument = {
  createElement: (tag) => new El(tag),
  createTextNode: (v) => new TextNode(v),
  createDocumentFragment: () => new Frag(),
};

const bundleSrc = readFileSync(join(ROOT, 'docs/vendor/markdown-renderer.min.js'), 'utf8');
const sandbox = { document: shimDocument };
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: 'markdown-renderer.min.js' });
const render = sandbox.markdown.render;

// ---- heading-id + link rewriting over the shimmed tree ----
function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.value;
  return (node.children || []).map(textOf).join('');
}

// GitHub-style slug: lowercase, strip punctuation, one hyphen per literal
// space (not collapsed) — matches the anchors already hand-written into the
// cross-doc links throughout sfwa-docs-extracted, e.g. "3.1 One store" ->
// "31-one-store", "3. Preact + htm" -> "3-preact--htm" (double hyphen).
function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
}

function assignHeadingIds(node, used) {
  if (!node || !node.children) return;
  if (node.nodeType === 1 && /^h[1-6]$/.test(node.tag)) {
    let id = slugify(textOf(node));
    if (used.has(id)) {
      let n = 1;
      while (used.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    used.add(id);
    node.setAttribute('id', id);
  }
  for (const child of node.children) assignHeadingIds(child, used);
}

// A reference to a directory entry (https://iamsingle.app/entry/<slug>)
// becomes an inline pill: logo + name, instead of a plain text link — so a
// name like "vicco" or "FuzzyGraph" reads as a recognisable app, not just
// blue underlined text in the middle of a sentence.
const ENTRY_LINK = /^https:\/\/iamsingle\.app\/entry\/([a-z0-9-]+)\/?$/;

function pillifyEntryLinks(node) {
  if (!node || !node.children) return;
  if (node.nodeType === 1 && node.tag === 'a') {
    const m = ENTRY_LINK.exec(node.attrs.href || '');
    if (m) {
      const slug = m[1];
      node.attrs.class = 'entry-pill';
      const img = new El('img');
      img.setAttribute('src', `/assets/logos/${slug}.png`);
      img.setAttribute('alt', '');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('width', '18');
      img.setAttribute('height', '18');
      img.setAttribute('class', 'entry-pill-logo');
      const label = new El('span');
      label.setAttribute('class', 'entry-pill-name');
      label.children = node.children;
      node.children = [img, label];
    }
  }
  for (const child of node.children) pillifyEntryLinks(child);
}

const ESC = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ESC_ATTR = (s) => ESC(s).replace(/"/g, '&quot;');
const VOID = new Set(['hr', 'br', 'img']);
const KEBAB = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

function toHTML(node) {
  if (node.nodeType === 3) return ESC(node.value);
  if (node.nodeType === 11) return node.children.map(toHTML).join('');
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${ESC_ATTR(v)}"`).join('');
  const styleKeys = Object.keys(node._style);
  const style = styleKeys.length
    ? ` style="${styleKeys.map(k => `${KEBAB(k)}:${node._style[k]}`).join(';')}"`
    : '';
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}${style}>`;
  const inner = node.children.map(toHTML).join('');
  return `<${node.tag}${attrs}${style}>${inner}</${node.tag}>`;
}

// Rewrite `NN-name.md` / `NN-name.md#anchor` cross-doc links, written against
// the source filenames, to the site routes (`/docs/<slug>/`) before parsing —
// simplest to do as text substitution on the raw markdown, since the pattern
// only ever appears inside a `](...)` link target.
function rewriteCrossDocLinks(md) {
  return md.replace(/\]\((\d\d-[a-z-]+\.md)(#[^)]*)?\)/g, (whole, file, anchor) => {
    const route = FILE_TO_ROUTE[file];
    if (!route) return whole;
    return `](${route}${anchor || ''})`;
  });
}

// ---- sidebar + pager, shared shell ----
function sidebarHTML(activeIndex) {
  const items = DOCS.map((d, i) => {
    const current = i === activeIndex ? ' aria-current="page"' : '';
    return `<li><a href="${routeOf(i)}"${current}>${String(i).padStart(2, '0')}. ${ESC(d.title)}</a></li>`;
  }).join('\n      ');
  return `<nav class="docs-sidebar">
    <div class="docs-sidebar-label">SFWA docs</div>
    <ol>
      ${items}
    </ol>
  </nav>`;
}

function pagerHTML(index) {
  const prev = DOCS[index - 1];
  const next = DOCS[index + 1];
  const prevHTML = prev
    ? `<a href="${routeOf(index - 1)}"><span class="dir">&larr; previous</span>${ESC(prev.title)}</a>` : '<span></span>';
  const nextHTML = next
    ? `<a class="next" href="${routeOf(index + 1)}"><span class="dir">next &rarr;</span>${ESC(next.title)}</a>` : '<span></span>';
  return `<div class="docs-pager">${prevHTML}${nextHTML}</div>`;
}

function page(doc, index, contentHTML) {
  const url = `${SITE_URL}${routeOf(index)}`;
  const title = index === 0
    ? `SFWA Docs — iamsingle.app`
    : `${doc.title} — SFWA Docs — iamsingle.app`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/favicon-180.png">
<title>${ESC(title)}</title>
<meta name="description" content="${ESC_ATTR(doc.desc)}">
<link rel="canonical" href="${url}">
<link rel="alternate" type="application/rss+xml" title="iamsingle.app — new entries" href="/feed.xml">

<meta property="og:type" content="article">
<meta property="og:site_name" content="iamsingle.app">
<meta property="og:title" content="${ESC_ATTR(title)}">
<meta property="og:description" content="${ESC_ATTR(doc.desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/assets/iamsingle.app.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ESC_ATTR(title)}">
<meta name="twitter:description" content="${ESC_ATTR(doc.desc)}">
<meta name="twitter:image" content="${SITE_URL}/assets/iamsingle.app.png">

<link rel="stylesheet" href="/docs/docs.css">
</head>
<body>
<div class="wrap">

  <nav class="crumb"><a href="/">iamsingle.app</a><span class="sep">›</span>${
    index === 0
      ? `<span class="current">SFWA Docs</span>`
      : `<a href="/docs/">SFWA Docs</a><span class="sep">›</span><span class="current">${ESC(doc.title)}</span>`
  }</nav>

  <div class="docs-shell">
    ${sidebarHTML(index)}
    <main class="docs-content">
${contentHTML}
      ${pagerHTML(index)}
    </main>
  </div>

</div>
</body>
</html>
`;
}

for (const [index, doc] of DOCS.entries()) {
  const raw = readFileSync(join(ROOT, 'docs/content', doc.file), 'utf8');
  const rewritten = rewriteCrossDocLinks(raw);
  const fragment = render(rewritten, {});
  pillifyEntryLinks(fragment);
  assignHeadingIds(fragment, new Set());
  const contentHTML = toHTML(fragment);

  const html = page(doc, index, contentHTML);
  if (index === 0) {
    writeFileSync(join(ROOT, 'docs/index.html'), html);
    console.log('docs/index.html');
  } else {
    const outDir = join(ROOT, 'docs', doc.slug);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.html'), html);
    console.log(`docs/${doc.slug}/index.html`);
  }
}
