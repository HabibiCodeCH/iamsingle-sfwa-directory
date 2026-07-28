#!/usr/bin/env node
// Pre-renders the catalog list and one static page per entry so crawlers
// that don't execute JavaScript (most LLM crawlers) can see the actual
// directory content, not just the empty #catalog shell. The client-side
// script in index.html also gets the full entries+stars dataset inlined
// (INLINE_DATA below) so every generated page is self-contained and
// works over file://, no fetch() needed.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://iamsingle.app';

const entries = JSON.parse(readFileSync(join(ROOT, 'data/entries.json'), 'utf8'));
const stars = existsSync(join(ROOT, 'data/stars.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data/stars.json'), 'utf8'))
  : {};
const sizes = existsSync(join(ROOT, 'data/sizes.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data/sizes.json'), 'utf8'))
  : {};
// Per-entry network profile from scripts/screenshot.mjs — drives the
// "single file" badge and the third-party contact disclosure.
// Vendored and inlined rather than hotlinked: the site's own pitch is that a
// page ships as one file, and the "download the whole directory" button would
// otherwise produce a file with a dead image in it. nicklaunches.com's stated
// condition for a free listing is that the *backlink* stays live, which the
// anchor below preserves exactly.
const NL_BADGE_DATA_URI = `data:image/png;base64,${readFileSync(join(ROOT, 'assets/nicklaunches-featured.png')).toString('base64')}`;

const network = existsSync(join(ROOT, 'data/network.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data/network.json'), 'utf8'))
  : {};
// Verified fix credits, written by api/recheck.js when someone reports a fix
// and GitHub confirms who authored the commit. Kept in its own file because
// screenshot.mjs rewrites network.json wholesale on every re-measurement.
const fixes = existsSync(join(ROOT, 'data/fixes.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data/fixes.json'), 'utf8'))
  : {};

// Kept in sync by hand with the identical function in index.html's client
// script and api/submit.js's slugify() — no shared module between the three.
function slugify(s) {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'entry');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1).trimEnd() + '…';
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatStars(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
// Mirrors formatSize() in index.html's client script and scripts/screenshot.mjs.
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
function formatCreated(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function formatAdded(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
// Mirrors scoreColor() in index.html's client script.
function scoreColor(ratio) {
  const red = [168, 51, 29], green = [63, 107, 63];
  const mix = (a, b) => Math.round(a + (b - a) * ratio);
  return `rgb(${mix(red[0], green[0])}, ${mix(red[1], green[1])}, ${mix(red[2], green[2])})`;
}
// GitHub Linguist's canonical per-language colors, so the bar reads as
// familiar rather than arbitrary. Unlisted languages cycle through a small
// neutral fallback instead of a random hue.
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#563d7c',
  Python: '#3572A5', Swift: '#F05138', Go: '#00ADD8', Rust: '#dea584',
  Java: '#b07219', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
  Ruby: '#701516', PHP: '#4F5D95', Shell: '#89e051', Vue: '#41b883',
  Svelte: '#ff3e00', Dart: '#00B4AB', Kotlin: '#A97BFF', 'Objective-C': '#438eff',
  Lua: '#000080', Perl: '#0298c3', Elixir: '#6e4a7e', Clojure: '#db5855',
  Haskell: '#5e5086', Scala: '#c22d40', R: '#198CE7', 'Jupyter Notebook': '#DA5B0B',
  Dockerfile: '#384d54', Makefile: '#427819', TeX: '#3D6117',
};
const LANG_FALLBACK = ['#8A8578', '#A39C8A', '#C9C3B2', '#57534A', '#201E19'];
function langColor(name, i) {
  return LANG_COLORS[name] || LANG_FALLBACK[i % LANG_FALLBACK.length];
}
const GH_ICON_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.744.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.303-5.467-1.334-5.467-5.93 0-1.31.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .319.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>';
// Webfont sources. A font is still an external request, so it bars an entry
// from being certified, but it isn't the app's logic: block it and the app
// runs identically in a fallback typeface. Treating it like fetching React
// from a CDN would put an app whose code genuinely is in one file into the
// same bucket as one that isn't.
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'use.typekit.net']);
const FIX_LIST_MAX = 8;
const LIB_CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Splits code dependencies into { fonts, logic }, deduplicated by URL.
 *  The same file fetched twice is still one file the app needs, and counting
 *  requests instead made the verdict disagree with the fix list below it. */
function classifyDeps(deps) {
  const fonts = [];
  const logic = [];
  const seen = new Set();
  for (const d of deps || []) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    (d.type === 'font' || FONT_HOSTS.has(hostOf(d.url)) ? fonts : logic).push(d);
  }
  return { fonts, logic };
}

/** The single verdict every entry gets, so no card is left blank.
 *  'sfa' | 'certified' | 'nearly' | 'no' | null (not measurable) */
function sfwaStatus(e, net) {
  if (e.kind === 'sfa') return 'sfa';
  if (!net || net.mode === 'unmeasurable') return null;
  if (net.selfContained) return 'certified';
  // One stray dependency, or nothing but fonts, is "nearly there".
  return classifyDeps(net.codeDeps).logic.length <= 1 ? 'nearly' : 'no';
}

/** Turns one dependency into a concrete, actionable step rather than a
 *  generic "inline your dependencies". Deduplicated by the caller. */
function fixFor(dep, docOrigin) {
  const host = hostOf(dep.url);
  const file = dep.url.split('/').pop().split('?')[0] || dep.url;
  if (dep.url.startsWith('http://')) {
    return `Load \`${file}\` over https — it currently comes in over plain http and can be modified in transit`;
  }
  if (/google-analytics|googletagmanager|plausible|segment|mixpanel/.test(host)) {
    return `Drop the analytics beacon (\`${host}\`) — it reports every visitor to a third party`;
  }
  if (host === 'cdn.tailwindcss.com') {
    return 'Replace the Tailwind CDN script with a compiled stylesheet inlined in a `<style>` tag';
  }
  if (FONT_HOSTS.has(host)) {
    return `Self-host the webfont as a base64 \`@font-face\`, or fall back to a system font stack (currently \`${host}\`)`;
  }
  if (LIB_CDN_HOSTS.has(host)) {
    return `Inline \`${file}\` into a \`<script>\`/\`<style>\` tag instead of fetching it from \`${host}\``;
  }
  if (docOrigin && dep.url.startsWith(docOrigin)) {
    return `Inline \`${file}\` — it's already your own file, it just needs to move into the HTML`;
  }
  return `Inline \`${file}\` from \`${host}\` so it ships with the app`;
}


/** Credit for whoever fixed an entry. Only rendered when the entry is
 *  certified now — a recorded fix that didn't work earns nothing. */
function fixCreditHtml(slug, status) {
  const f = fixes[slug];
  if (status !== 'certified' || !f || !f.by) return '';
  const when = f.date ? formatAdded(f.date) : '';
  const label = `fixed by @${escapeHtml(f.by)}${when ? ` · ${when}` : ''}`;
  return f.url
    ? `<a class="fix-credit" href="${escapeHtml(f.url)}" target="_blank" rel="noopener" title="View the commit that fixed this">${label}</a>`
    : `<span class="fix-credit">${label}</span>`;
}

/** One badge per status, shared by the catalog card and the entry heading so
 *  the two can't drift apart. Mirrored in index.html's client script. */
function statusBadgeHtml(status, e) {
  switch (status) {
    case 'sfa':
      return `<span class="sfa-tag" title="A single-file app, but it needs ${escapeHtml(e.runtime)} to run — not a browser-only single-file web app">sfa · ${escapeHtml(e.runtime)}</span>`;
    // Icon carries the verdict, the word stays short enough not to wrap on a
    // phone. The title attribute holds the full explanation.
    case 'certified':
      return `<span class="sf-badge" title="Certified: the entire app sits in one file. No imports, no server calls, no build."><span class="sf-mark">\u{1F3C5}</span>sfwa</span>`;
    case 'nearly':
      return `<span class="sf-badge sf-badge-near" title="Nearly: its own code is in one file, but it still pulls something in."><span class="sf-mark">\u{1F90F}</span>sfwa</span>`;
    case 'no':
      return `<span class="sf-badge sf-badge-no" title="Not a SFWA: the app fetches code it needs from elsewhere."><span class="sf-mark">\u{1F6AB}</span>sfwa</span>`;
    default:
      return '';
  }
}

/** Backticked spans in the fix text become <code>, after escaping. */
function fixText(s) {
  return escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function fixesFor(net) {
  const { fonts, logic } = classifyDeps(net.codeDeps);
  const seen = new Set();
  const out = [];
  for (const d of [...logic, ...fonts]) {
    const tip = fixFor(d, net.measured ? new URL(net.measured).origin : null);
    if (!seen.has(tip)) { seen.add(tip); out.push(tip); }
  }
  return out;
}

// Document glyph with a "1" — the single-file mark, matching the site favicon.
const SF_ICON_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M6 2h9l5 5v15H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><path d="M15 2v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><text x="12" y="18" font-size="9" font-family="ui-monospace,monospace" font-weight="bold" text-anchor="middle" fill="currentColor">1</text></svg>';

// Three finder-pattern corners + a few data modules — a minimal QR glyph.
const QR_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.8"></rect><rect x="15" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.8"></rect><rect x="3" y="15" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.8"></rect><rect x="15" y="15" width="2.5" height="2.5" fill="currentColor"></rect><rect x="18.5" y="15" width="2.5" height="2.5" fill="currentColor"></rect><rect x="15" y="18.5" width="2.5" height="2.5" fill="currentColor"></rect></svg>';

function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/\S+)/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}
function iconFor(s) { return s === 'pass' ? '✓' : s === 'fail' ? '✗' : '–'; }

// Default catalog sort is "date added" (newest first) — mirrors currentList()
// with sortEl.value === 'added', which is now the <select>'s default option.
const sorted = entries.slice().sort((a, b) => {
  const ca = a.added ?? '';
  const cb = b.added ?? '';
  if (ca === cb) return a.name.localeCompare(b.name);
  return cb.localeCompare(ca);
});

const NOW_MS = Date.now();
// Mirrors isNew() in index.html's client script, but computed once at build
// time — the client re-checks live on every pageview, this is just the
// crawler-visible approximation, refreshed on the next data-triggered rebuild.
function isNew(e) {
  if (!e.added) return false;
  const addedMs = new Date(e.added + 'T00:00:00Z').getTime();
  return (NOW_MS - addedMs) <= 7 * 24 * 60 * 60 * 1000;
}

// Left segment: two stacked, left-aligned lines (brand + "verified sfwa").
// Right segment: score, vertically centered across the full badge height,
// colored by pass ratio. Character-width is approximated (no font metrics
// library) rather than measured, same tradeoff most zero-dependency badge
// generators make.
function svgBadge(passed, total) {
  const color = scoreColor(passed / total);
  const line1 = 'iamsingle.app';
  // Says what the number actually is. It used to read "verified sfwa", which
  // claimed something this score doesn't measure — an entry loading 24 files
  // from CDNs could still embed a badge implying it was a verified SFWA.
  // That claim now lives on its own badge (svgCertifiedBadge), which is only
  // generated for entries that earn it.
  const line2 = 'security audit';
  const value = `${passed}/${total}`;
  const charW1 = 5.1, padL = 10;
  const charW2 = 7.8, padR = 14;
  const leftW = Math.round(Math.max(line1.length, line2.length) * charW1) + padL * 2;
  const rightW = Math.round(value.length * charW2) + padR * 2;
  const totalW = leftW + rightW;
  const h = 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}" role="img" aria-label="${line1} — ${line2}: ${value}">
  <clipPath id="r"><rect width="${totalW}" height="${h}" rx="4" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="${h}" fill="#201E19"/>
    <rect x="${leftW}" width="${rightW}" height="${h}" fill="${color}"/>
  </g>
  <g font-family="Verdana,Geneva,DejaVu Sans,sans-serif">
    <text x="${padL}" y="15" font-size="9" fill="#EEEBE2">${line1}</text>
    <text x="${padL}" y="26" font-size="9" fill="#B8B4A8">${line2}</text>
    <text x="${leftW + rightW / 2}" y="${Math.round(h / 2 + 5)}" font-size="14" font-weight="bold" fill="#fff" text-anchor="middle">${value}</text>
  </g>
</svg>
`;
}

/** The earned badge: no number, because it isn't a score — either the whole
 *  app is in one file or it isn't. Only generated for entries that pass, so
 *  there's nothing to embed unless it's true. */
function svgCertifiedBadge() {
  const line1 = 'iamsingle.app';
  const line2 = 'certified sfwa';
  const charW = 5.1, padL = 10, padR = 16;
  const leftW = Math.round(line2.length * charW) + padL * 2;
  const rightW = 30;
  const totalW = leftW + rightW;
  const h = 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}" role="img" aria-label="${line1} — ${line2}">
  <clipPath id="r"><rect width="${totalW}" height="${h}" rx="4" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="${h}" fill="#201E19"/>
    <rect x="${leftW}" width="${rightW}" height="${h}" fill="#3F6B3F"/>
  </g>
  <g font-family="Verdana,Geneva,DejaVu Sans,sans-serif">
    <text x="${padL}" y="15" font-size="9" fill="#EEEBE2">${line1}</text>
    <text x="${padL}" y="26" font-size="9" font-weight="bold" fill="#fff">${line2}</text>
    <text x="${leftW + rightW / 2 - 1}" y="${Math.round(h / 2 + 6)}" font-size="17" font-weight="bold" fill="#fff" text-anchor="middle">✓</text>
  </g>
</svg>
`;
}

// Mirrors the embed-badge block added to renderDetail() in index.html's client script.
function embedBadgeHtml(slug, checks, passed, certified) {
  if (!checks.length) return '';
  const certifiedBlock = certified ? `
      <div class="detail-checks-label" style="margin-top:22px;">Embed the certified badge</div>
      <img class="badge-preview" src="${SITE_URL}/certified/${slug}.svg" alt="iamsingle.app — certified sfwa">
      <textarea class="badge-snippet" id="certifiedSnippet" readonly rows="2">[![iamsingle.app — certified sfwa](${SITE_URL}/certified/${slug}.svg)](${SITE_URL}/entry/${slug})</textarea>
      <button type="button" class="btn-outline" id="copyCertifiedBtn">Copy markdown</button>` : '';
  return `
    <div class="embed-badge">
      <div class="detail-checks-label">Embed this badge</div>
      <img class="badge-preview" src="${SITE_URL}/badge/${slug}.svg" alt="iamsingle.app — security audit — ${passed}/${checks.length}">
      <textarea class="badge-snippet" id="badgeSnippet" readonly rows="2">[![iamsingle.app — security audit — ${passed}/${checks.length}](${SITE_URL}/badge/${slug}.svg)](${SITE_URL}/entry/${slug})</textarea>
      <button type="button" class="btn-outline" id="copyBadgeBtn">Copy markdown</button>${certifiedBlock}
    </div>`;
}

/** Pre-filled GitHub issue inviting the author to inline their dependencies.
 *
 * An issue rather than a PR: GitHub can't pre-fill a pull request from a URL
 * (that needs a fork, a branch and an actual diff), so this opens a populated
 * "new issue" form on the project's own repo instead. Mirrored in
 * index.html's renderDetail().
 */
// Asks for a re-measurement; structurally cannot assert a verdict. See api/recheck.js.
function recheckBtnHtml(slug) {
  // Opens the re-check modal (static markup in index.html), which explains
  // what happens next and takes the optional handle.
  return `<button type="button" class="btn-outline recheck-btn" data-recheck-slug="${slug}">I fixed it ↻</button>`;
}

function suggestFixHtml(e, slug, fixes) {
  // The GitHub buttons need a repo; the re-check button doesn't — a hosted
  // app with no linked repo can still be fixed and re-measured.
  if (!e.repo) {
    return `<div class="fix-suggest">${recheckBtnHtml(slug)}</div>`;
  }
  // Capped because the whole issue travels in a URL, which has a practical
  // length limit — the entry page carries the complete list and is linked.
  const shown = fixes.slice(0, FIX_LIST_MAX);
  const more = fixes.length - shown.length;
  const list = shown.map(f => `- [ ] ${f}`).join('\n')
    + (more > 0 ? `\n- [ ] …and ${more} more — full list: ${SITE_URL}/entry/${slug}#network` : '');
  const body = [
    `Spotted via [iamsingle.app](${SITE_URL}), a directory of single-file web apps.`,
    '',
    'This one loads files it needs from elsewhere. Suggested changes:',
    '',
    list,
    '',
    'Doing that would make it fully self-contained: no imports, no server calls, no build,',
    'and it would qualify as a certified SFWA in the directory.',
    '',
    `Entry: ${SITE_URL}/entry/${slug}`,
  ].join('\n');
  const url = `https://github.com/${e.repo}/issues/new`
    + `?title=${encodeURIComponent('Make this a true single-file web app?')}`
    + `&body=${encodeURIComponent(body)}`;
  const issueBtn = `<a class="btn-outline" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open issue ↗</a>`;
  return `<div class="fix-suggest">${issueBtn}${recheckBtnHtml(slug)}</div>`;
}

// Prefers the vendored copy (assets/logos/<slug>.png, fetched once by
// scripts/screenshot.mjs) so the page stops handing GitHub and Google a
// request log of every visitor. Falls back to the remote URL only when the
// vendored file is missing, e.g. a brand-new entry before the next build.
function logoSrc(e, size) {
  const slug = slugify(e.name);
  if (existsSync(join(ROOT, 'assets/logos', `${slug}.png`))) return `/assets/logos/${slug}.png`;
  const homepageFavicon = 'https://www.google.com/s2/favicons?sz=' + size + '&domain_url=' + encodeURIComponent(e.url);
  return e.repo ? 'https://github.com/' + e.repo.split('/')[0] + '.png?size=' + size : homepageFavicon;
}

// Mirrors render()'s per-card markup in index.html's client script.
function renderCard(e, i) {
  const entrySlug = slugify(e.name);
  const starInfo = e.repo ? stars[e.repo] : null;
  const absent = e.repo && !starInfo;
  const starsText = !e.repo ? '' : absent ? 'n/a' : '★ ' + formatStars(starInfo.stars);
  const dateText = !e.repo ? '' : absent ? 'n/a' : formatCreated(starInfo.created);
  const sizeText = sizes[entrySlug] != null ? formatSize(sizes[entrySlug]) : '';
  const owner = e.repo ? e.repo.split('/')[0] : '';
  const ghPill = e.repo ? `<span class="gh-pill">
      <a class="gh-pill-icon" href="https://github.com/${e.repo}" target="_blank" rel="noopener" aria-label="${escapeHtml(e.repo)} on GitHub">${GH_ICON_SVG}</a>
      <span class="gh-stars">${starsText}</span>
      ${sizeText ? `<span class="gh-size">${sizeText}</span>` : ''}
      <span class="gh-date">${dateText}</span>
      <a class="gh-pill-by" href="https://github.com/${owner}" target="_blank" rel="noopener" title="${escapeHtml(owner)}">by ${escapeHtml(owner)}</a>
    </span>` : (sizeText ? `<span class="gh-pill"><span class="gh-size">${sizeText}</span></span>` : '');

  const checks = e.checks || [];
  const passed = checks.filter(c => c.status === 'pass').length;
  const hasChecks = checks.length > 0;
  const badgeLabel = checks.length ? `${passed}/${checks.length}` : '';
  const badgeColor = checks.length ? scoreColor(passed / checks.length) : '#8A8578';

  const rankLabel = pad(i + 1);
  // Certified at zero external code deps, "nearly" at exactly one — past
  // that it's a different claim about the project and gets no badge.
  // Every measurable entry carries exactly one verdict badge — a blank card
  // read as "we failed to check" rather than "this didn't qualify".
  // Credit is deliberately entry-page only — the catalog row already carries
  // a status badge, tags and stats, and a second attribution there is noise.
  const sfBadge = statusBadgeHtml(sfwaStatus(e, network[entrySlug]), e);
  const hasQr = existsSync(join(ROOT, 'qr', `${entrySlug}.png`));
  const qrBtn = hasQr ? `<button type="button" class="qr-btn" data-qr-slug="${entrySlug}" data-qr-name="${escapeHtml(e.name)}" aria-label="Scan to run ${escapeHtml(e.name)} from a QR code">${QR_ICON_SVG}</button>` : '';

  return `
    <div class="card">
      <div class="stub"><span class="n">${rankLabel}</span></div>
      <img class="logo" alt="" loading="lazy" src="${logoSrc(e, 64)}">
      <div class="meta">
        <p class="name">
          <a href="/entry/${entrySlug}" data-nav>${escapeHtml(e.name)}</a>
          ${qrBtn}
        </p>
        <p class="desc">${escapeHtml(e.desc)}</p>
        <div class="tags">${ghPill}${sfBadge}${e.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      </div>
      ${hasChecks ? `<div class="audit"><span class="audit-label">security audit</span><a class="badge" href="/entry/${entrySlug}#audit-results" data-nav style="color:${badgeColor};border-color:${badgeColor};">${badgeLabel}</a></div>` : ''}
    </div>`;
}

// Mirrors renderDetail()'s markup in index.html's client script.
function renderDetailHtml(e, slug) {
  const starInfo = e.repo ? stars[e.repo] : null;
  const absent = e.repo && !starInfo;
  const starsVal = !e.repo ? 'n/a' : absent ? 'n/a' : '★ ' + formatStars(starInfo.stars);
  const createdVal = !e.repo ? 'n/a' : absent ? 'n/a' : formatCreated(starInfo.created);

  const checks = e.checks || [];
  const passed = checks.filter(c => c.status === 'pass').length;
  const hasChecks = checks.length > 0;
  const badgeColor = checks.length ? scoreColor(passed / checks.length) : '#8A8578';
  const testsHtml = checks.map(c =>
    `<div class="t-${c.status}">${iconFor(c.status)} ${escapeHtml(c.label)}${c.detail ? ' — ' + linkify(c.detail) : ''}</div>`
  ).join('');

  const owner = e.repo ? e.repo.split('/')[0] : '';
  const badgeLabel = checks.length ? `${passed}/${checks.length}` : '';
  const forksVal = (e.repo && !absent && starInfo.forks != null) ? starInfo.forks : null;
  const contributorsVal = (e.repo && !absent && starInfo.contributors != null) ? starInfo.contributors : null;
  const languages = (e.repo && !absent && starInfo.languages && starInfo.languages.length) ? starInfo.languages : [];

  const statParts = [];
  if (e.repo) {
    statParts.push(starsVal === 'n/a' ? '<span class="stat-word">stars </span>n/a' : `${starsVal}<span class="stat-word"> stars</span>`);
    if (forksVal != null) statParts.push(`<span class="stat-forks-text">${forksVal} fork${forksVal === 1 ? '' : 's'}</span><svg class="stat-forks-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg><span class="stat-forks-num">${forksVal}</span>`);
    if (contributorsVal != null) statParts.push(`<span class="stat-contrib-text">${contributorsVal} contributor${contributorsVal === 1 ? '' : 's'}</span><svg class="stat-contrib-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 20v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path></svg><span class="stat-contrib-num">${contributorsVal}</span>`);
  } else {
    statParts.push('no public repo linked');
  }
  if (sizes[slug] != null) {
    statParts.push(`<svg class="stat-size-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5z"></path><path d="M3 8v8l9 5 9-5V8"></path><path d="M12 13v8"></path></svg>${formatSize(sizes[slug])}`);
  }
  if (e.repo) {
    statParts.push(createdVal === 'n/a' ? '<span class="stat-word">created </span>n/a' : `<svg class="stat-date-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg><span class="stat-word">created </span>${createdVal}`);
    statParts.push(`<a class="stat-repo-link" href="https://github.com/${e.repo}" target="_blank" rel="noopener">${GH_ICON_SVG}${escapeHtml(e.repo.split('/')[1] || e.repo)} ↗</a>`);
  }
  const statStripHtml = `<div class="stat-strip">${statParts.join(' <span class="sep">·</span> ')}</div>`;

  const langHtml = languages.length ? `
    <div class="lang-bar">${languages.map((l, i) => `<span style="width:${l.pct}%;background:${langColor(l.name, i)};"></span>`).join('')}</div>
    <div class="lang-legend">${languages.map((l, i) => `<span class="lang-dot" style="background:${langColor(l.name, i)};"></span>${escapeHtml(l.name)} ${l.pct}%`).join(' <span class="sep">·</span> ')}</div>` : '';

  // Informational, deliberately not part of the pass/fail audit score: this
  // comes from one passive page load, so a request that only fires on user
  // interaction wouldn't be seen. Reported as observation, not verdict.
  const net = network[slug];
  let networkHtml = '';
  if (net) {
    const status = sfwaStatus(e, net);
    const { fonts, logic } = classifyDeps(net.codeDeps);
    // One source of truth for "how many files": the verdict and the fix list
    // below it are both derived from this, so they can't disagree.
    const fixes = fixesFor(net);
    const rows = [];
    let extras = '';
    const headingBadge = status ? ' ' + statusBadgeHtml(status, e) + fixCreditHtml(slug, status) : '';

    if (status === 'sfa') {
      rows.push(`<div class="t-skip">– No. It's a single-file app, but it needs ${escapeHtml(e.runtime)} to run, so it can't open straight from disk in a browser.</div>`);
    } else if (!status) {
      rows.push(`<div class="t-skip">– Not checked — ${escapeHtml(net.reason || 'no measurable target')}</div>`);
    } else if (status === 'certified') {
      rows.push('<div class="t-pass">✓ Yes, the entire app sits in one file. No imports, no server calls, no build.</div>');
    } else if (status === 'nearly') {
      // Each verdict opens by answering the heading's question, so the three
      // states read as parallel answers rather than one answer and two lists.
      rows.push(logic.length === 0
        ? `<div class="t-fail">✗ Nearly. Its own code is all in one file, but it loads ${fonts.length} font file${fonts.length === 1 ? '' : 's'} from elsewhere.</div>`
        : '<div class="t-fail">✗ Nearly. Its own code is all in one file, but it still pulls in 1 file from elsewhere.</div>');
    } else {
      rows.push(`<div class="t-fail">✗ No, this is not a single-file web app. It needs ${fixes.length} file${fixes.length === 1 ? '' : 's'} from elsewhere.</div>`);
    }

    if (status !== 'sfa' && status) {
      for (const host of net.thirdPartyHosts || []) {
        rows.push(`<div class="t-skip">– Contacts <code>${escapeHtml(host)}</code></div>`);
      }
    }
    for (const u of net.insecure || []) {
      rows.push(`<div class="t-fail">✗ Loaded over plain http, modifiable in transit: ${escapeHtml(u)}</div>`);
    }

    // Concrete steps rather than a generic nudge — the same list populates
    // the pre-filled GitHub issue below.
    if (status === 'nearly' || status === 'no') {
      if (fixes.length) {
        // Native <details> so the toggle needs no JS and behaves the same in
        // the pre-rendered page and the client-rendered one.
        const head = fixes.slice(0, FIX_LIST_MAX);
        const rest = fixes.slice(FIX_LIST_MAX);
        const row = f => `<div class="t-skip">→ ${fixText(f)}</div>`;
        extras = `<div class="detail-checks-label">How to fix it</div><div class="detail-checks">`
          + head.map(row).join('')
          + (rest.length
            ? `<details class="fix-more"><summary>Show full list (${fixes.length})</summary>${rest.map(row).join('')}</details>`
            : '')
          + `</div>${suggestFixHtml(e, slug, fixes)}`;
      }
    }

    networkHtml = `<div class="detail-checks-label" id="network">Is it a true single-file web app?</div><div class="detail-checks">${rows.join('')}</div>${extras}`;
  }

  const screenshotHtml = existsSync(join(ROOT, 'screenshot', `${slug}.png`)) ? `
    <a class="screenshot-link" href="${e.url}" target="_blank" rel="noopener">
      <img class="entry-screenshot" src="${SITE_URL}/screenshot/${slug}.png" alt="Screenshot of ${escapeHtml(e.name)}" loading="lazy">
    </a>` : '';

  return `
    <nav class="crumb"><a href="/" data-nav>iamsingle.app</a><span class="sep">›</span><span class="current">${escapeHtml(e.name)}</span></nav>
    <div class="detail-header">
      <div class="detail-title">
        <img class="detail-logo" alt="" id="detailLogoImg" src="${logoSrc(e, 128)}">
        <div class="detail-title-text">
          <div class="detail-name-row">
            <h1>${escapeHtml(e.name)}</h1>${sfwaStatus(e, net) ? statusBadgeHtml(sfwaStatus(e, net), e) : ''}
            <div class="detail-actions">
              <button type="button" class="btn-outline" id="shareBtn" aria-label="Share"><svg class="btn-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg><span class="btn-label">Share</span></button>
              <a class="btn-solid" href="${e.url}" target="_blank" rel="noopener" aria-label="Visit"><span class="btn-label">Visit</span> ↗</a>
            </div>
          </div>
          ${owner ? `<a class="detail-by" href="https://github.com/${owner}" target="_blank" rel="noopener">by ${escapeHtml(owner)}</a>` : ''}
          <p class="detail-desc">${escapeHtml(e.desc)}</p>
          <div class="tags" style="margin-top:10px;">${e.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
      </div>
    </div>
    ${screenshotHtml}
    ${statStripHtml}
    ${langHtml}
    ${networkHtml}
    ${hasChecks ? `<div class="detail-checks-label" id="audit-results">Security audit — full results <span class="badge" style="color:${badgeColor};border-color:${badgeColor};">${badgeLabel}</span></div><div class="detail-checks">${testsHtml}</div>` : ''}
    ${embedBadgeHtml(slug, checks, passed, !!network[slug]?.selfContained)}
    <a href="/" data-nav class="back-link sub">← back to the full catalog</a>
  `;
}

function jsonLdItemList() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'iamsingle.app — single-file web apps',
    itemListElement: sorted.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE_URL}/entry/${slugify(e.name)}`,
      name: e.name,
    })),
  });
}

function jsonLdForEntry(e) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: e.name,
    description: e.desc,
    url: e.url,
    applicationCategory: 'WebApplication',
    operatingSystem: 'Any (browser)',
  };
  if (e.repo) data.codeRepository = `https://github.com/${e.repo}`;
  return JSON.stringify(data);
}

function mustReplace(str, from, to) {
  if (!str.includes(from)) {
    throw new Error(`build_pages: expected to find ${JSON.stringify(from.slice(0, 80))} in template — index.html may have changed shape`);
  }
  return str.replace(from, to);
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Leaves start/end markers in place around the substituted content so
// re-running the build against its own prior output (index.html is both
// the template source and the write target) finds them again idempotently.
function replaceBetween(str, start, end, content) {
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
  if (!re.test(str)) {
    throw new Error(`build_pages: markers ${start} / ${end} not found in template`);
  }
  return str.replace(re, `${start}${content}${end}`);
}

function replaceBetweenMarkers(str, markerName, content) {
  return replaceBetween(str, `<!-- BUILD:${markerName}:START -->`, `<!-- BUILD:${markerName}:END -->`, content);
}

let templateSrc = readFileSync(join(ROOT, 'index.html'), 'utf8');
// Same footer badge on every generated page.
templateSrc = replaceBetweenMarkers(
  templateSrc,
  'FOOTERBADGE',
  `<a href="https://nicklaunches.com/products/iamsingle-app/?utm_source=iamsingle.app&amp;utm_medium=badge&amp;utm_campaign=featured" target="_blank" rel="noopener">`
    + `<img src="${NL_BADGE_DATA_URI}" alt="iamsingle.app on Nick Launches" width="244" height="56"></a>`
);

const INLINE_DATA_START = '/* BUILD:INLINE_DATA:START */';
const INLINE_DATA_END = '/* BUILD:INLINE_DATA:END */';
// Entries small enough to have a scan-and-run QR code (see scripts/screenshot.mjs).
const qrSlugs = entries.map(e => slugify(e.name)).filter(slug => existsSync(join(ROOT, 'qr', `${slug}.png`)));
// </script sequences are escaped defensively since check details/descriptions
// are free text that could otherwise break out of the inline <script> tag.
// Only the fields the client actually renders — the full per-request URL
// lists in data/network.json would bloat every page for no benefit.
const networkSlim = Object.fromEntries(Object.entries(network).map(([slug, v]) => {
  const { fonts, logic } = classifyDeps(v.codeDeps);
  return [slug, {
    mode: v.mode,
    reason: v.reason,
    selfContained: v.selfContained,
    fontCount: fonts.length,
    logicCount: logic.length,
    // Pre-computed here so the client doesn't need a second copy of the
    // host-classification rules; capped so a 24-dependency entry doesn't
    // inline its whole list into all 22 pages.
    fixes: fixesFor(v),
    thirdPartyHosts: v.thirdPartyHosts || [],
    insecure: v.insecure || [],
  }];
}));
const logoSlugs = entries.map(e => slugify(e.name)).filter(slug => existsSync(join(ROOT, 'assets/logos', `${slug}.png`)));
const inlineDataJs = `const INLINE_DATA = ${JSON.stringify({ entries, stars, sizes, qrSlugs, network: networkSlim, fixes, logoSlugs }).replace(/<\/script/gi, '<\\/script')};`;

// --- homepage-only highlight cards: smallest file, most stars, last added ---
function renderHighlights() {
  let smallest = null;
  for (const e of entries) {
    const slug = slugify(e.name);
    if (sizes[slug] == null) continue;
    if (!smallest || sizes[slug] < sizes[slugify(smallest.name)]) smallest = e;
  }
  let mostStars = null, mostStarsVal = -1;
  for (const e of entries) {
    const s = e.repo ? stars[e.repo]?.stars : null;
    if (s != null && s > mostStarsVal) { mostStarsVal = s; mostStars = e; }
  }
  let lastAdded = null;
  for (const e of entries) {
    if (!e.added) continue;
    if (!lastAdded || e.added > lastAdded.added) lastAdded = e;
  }

  const card = (label, e, statText) => {
    if (!e) return '';
    const slug = slugify(e.name);
    return `
      <div class="highlight-card">
        <div class="highlight-label">${label}</div>
        <div class="highlight-row">
          <img class="highlight-icon" alt="" loading="lazy" src="${logoSrc(e, 64)}">
          <div class="highlight-text">
            <a class="highlight-name" href="/entry/${slug}" data-nav>${escapeHtml(e.name)}</a>
            <div class="highlight-stat">${statText}</div>
          </div>
        </div>
      </div>`;
  };

  return [
    card('Smallest file size', smallest, smallest ? formatSize(sizes[slugify(smallest.name)]) : ''),
    card('Most stars', mostStars, mostStars ? '★ ' + formatStars(mostStarsVal) : ''),
    card('Last added', lastAdded, lastAdded ? formatAdded(lastAdded.added) : ''),
  ].join('');
}

// --- homepage: inject the pre-rendered catalog + ItemList JSON-LD ---
let home = templateSrc;
home = replaceBetweenMarkers(home, 'CATALOG', sorted.map(renderCard).join('\n'));
home = replaceBetweenMarkers(home, 'HIGHLIGHTS', renderHighlights());
home = replaceBetweenMarkers(home, 'JSONLD', `<script type="application/ld+json">${jsonLdItemList()}</script>`);
home = replaceBetween(home, INLINE_DATA_START, INLINE_DATA_END, inlineDataJs);
// Size of the self-contained downloadable file — same label shown on every
// page's (hidden, on entry pages) download button, since they all link to
// this one homepage file.
const downloadSizeLabel = `${Math.round(Buffer.byteLength(home, 'utf8') / 1024)} KB`;
home = replaceBetweenMarkers(home, 'DLSIZE', downloadSizeLabel);
writeFileSync(join(ROOT, 'index.html'), home);

// --- per-entry static pages + badges ---
const entryDir = join(ROOT, 'entry');
rmSync(entryDir, { recursive: true, force: true });
const badgeDir = join(ROOT, 'badge');
rmSync(badgeDir, { recursive: true, force: true });
mkdirSync(badgeDir, { recursive: true });
// Regenerated from scratch each build so a badge disappears the moment an
// entry stops qualifying — a stale "certified" file would be a false claim.
const certifiedDir = join(ROOT, 'certified');
rmSync(certifiedDir, { recursive: true, force: true });
mkdirSync(certifiedDir, { recursive: true });

const TITLE_ANCHOR = '<title>iamsingle.app - single-file web app directory</title>';
const DESC_ANCHOR = '<meta name="description" content="A working directory of SFWAs (single-file web apps) — apps that ship as one HTML file, no install, no build, no server required. Ranked by GitHub stars, searchable by what it does.">';
const CANONICAL_ANCHOR = '<link rel="canonical" href="https://iamsingle.app/">';
const OG_TITLE_ANCHOR = '<meta property="og:title" content="iamsingle.app - single-file web app directory">';
const OG_DESC_ANCHOR = '<meta property="og:description" content="A working directory of SFWAs (single-file web apps) — no install, no build, no server required.">';
const OG_URL_ANCHOR = '<meta property="og:url" content="https://iamsingle.app/">';
const TW_TITLE_ANCHOR = '<meta name="twitter:title" content="iamsingle.app - single-file web app directory">';
const TW_DESC_ANCHOR = '<meta name="twitter:description" content="A working directory of SFWAs (single-file web apps) — no install, no build, no server required.">';
const OG_IMAGE_ANCHOR = '<meta property="og:image" content="https://iamsingle.app/assets/iamsingle.app.png">';
const TW_IMAGE_ANCHOR = '<meta name="twitter:image" content="https://iamsingle.app/assets/iamsingle.app.png">';
const DETAILVIEW_ANCHOR = '<div id="detailView" style="display:none;"></div>';
const CATALOGVIEW_ANCHOR = '<div id="catalogView">';

for (const e of sorted) {
  const slug = slugify(e.name);
  const metaDesc = truncate(e.desc, 155);

  const checks = e.checks || [];
  if (checks.length) {
    const passed = checks.filter(c => c.status === 'pass').length;
    writeFileSync(join(badgeDir, `${slug}.svg`), svgBadge(passed, checks.length));
  }
  if (network[slug]?.selfContained) {
    writeFileSync(join(certifiedDir, `${slug}.svg`), svgCertifiedBadge());
  }

  let page = templateSrc; // fresh copy each time, not the homepage's populated `home`
  page = mustReplace(page, TITLE_ANCHOR, `<title>${escapeHtml(e.name)} — iamsingle.app</title>`);
  page = mustReplace(page, DESC_ANCHOR, `<meta name="description" content="${escapeHtml(metaDesc)}">`);
  page = mustReplace(page, CANONICAL_ANCHOR, `<link rel="canonical" href="${SITE_URL}/entry/${slug}">`);
  page = mustReplace(page, OG_TITLE_ANCHOR, `<meta property="og:title" content="${escapeHtml(e.name)} — iamsingle.app">`);
  page = mustReplace(page, OG_DESC_ANCHOR, `<meta property="og:description" content="${escapeHtml(metaDesc)}">`);
  page = mustReplace(page, OG_URL_ANCHOR, `<meta property="og:url" content="${SITE_URL}/entry/${slug}">`);
  page = mustReplace(page, TW_TITLE_ANCHOR, `<meta name="twitter:title" content="${escapeHtml(e.name)} — iamsingle.app">`);
  page = mustReplace(page, TW_DESC_ANCHOR, `<meta name="twitter:description" content="${escapeHtml(metaDesc)}">`);
  if (existsSync(join(ROOT, 'og', `${slug}.png`))) {
    page = mustReplace(page, OG_IMAGE_ANCHOR, `<meta property="og:image" content="${SITE_URL}/og/${slug}.png">`);
    page = mustReplace(page, TW_IMAGE_ANCHOR, `<meta name="twitter:image" content="${SITE_URL}/og/${slug}.png">`);
  }
  page = replaceBetweenMarkers(page, 'CATALOG', ''); // don't bloat every entry page with the full hidden catalog
  page = replaceBetweenMarkers(page, 'HIGHLIGHTS', ''); // homepage-only
  page = replaceBetweenMarkers(page, 'JSONLD', `<script type="application/ld+json">${jsonLdForEntry(e)}</script>`);
  page = mustReplace(page, CATALOGVIEW_ANCHOR, '<div id="catalogView" style="display:none;">');
  page = mustReplace(page, DETAILVIEW_ANCHOR, `<div id="detailView">${renderDetailHtml(e, slug)}</div>`);
  page = replaceBetween(page, INLINE_DATA_START, INLINE_DATA_END, inlineDataJs);
  page = replaceBetweenMarkers(page, 'DLSIZE', downloadSizeLabel);

  const dir = join(entryDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), page);
}

// --- sitemap.xml ---
const urls = [`${SITE_URL}/`, ...sorted.map(e => `${SITE_URL}/entry/${slugify(e.name)}`)];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
  + urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')
  + `\n</urlset>\n`;
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap);

// --- robots.txt ---
const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
writeFileSync(join(ROOT, 'robots.txt'), robots);

// --- feed.xml (RSS 2.0, newest-added first) ---
function rfc822(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toUTCString();
}
const byAdded = entries.filter(e => e.added).slice().sort((a, b) => b.added.localeCompare(a.added));
const feedItems = byAdded.map(e => {
  const slug = slugify(e.name);
  return `  <item>
    <title>${escapeHtml(e.name)}</title>
    <link>${SITE_URL}/entry/${slug}</link>
    <guid isPermaLink="true">${SITE_URL}/entry/${slug}</guid>
    <description>${escapeHtml(e.desc)}</description>
    <pubDate>${rfc822(e.added)}</pubDate>
  </item>`;
}).join('\n');
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>iamsingle.app — new entries</title>
  <link>${SITE_URL}/</link>
  <description>New single-file web apps added to the iamsingle.app catalog.</description>
  <language>en</language>
  <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${feedItems}
</channel>
</rss>
`;
writeFileSync(join(ROOT, 'feed.xml'), feed);

// --- llms.txt (https://llmstxt.org convention) ---
const llmsLines = [
  '# iamsingle.app',
  '',
  '> A working directory of SFWAs (single-file web apps) — apps that ship as one HTML file, no install, no build, no server required. Ranked by GitHub stars, searchable by what it does.',
  '',
  '## Catalog',
  '',
  ...sorted.map(e => `- [${e.name}](${SITE_URL}/entry/${slugify(e.name)}): ${e.desc}`),
  '',
];
writeFileSync(join(ROOT, 'llms.txt'), llmsLines.join('\n'));

const badgeCount = sorted.filter(e => (e.checks || []).length).length;
console.log(`Generated: index.html, ${sorted.length} entry pages, ${badgeCount} badges, sitemap.xml, robots.txt, llms.txt, feed.xml`);
