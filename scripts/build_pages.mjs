#!/usr/bin/env node
// Pre-renders the catalog list and one static page per entry so crawlers
// that don't execute JavaScript (most LLM crawlers) can see the actual
// directory content, not just the empty #catalog shell. The client-side
// script in index.html is unchanged: it still fetches data/entries.json
// and re-renders on top of whatever is baked in here.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://iamsingle.app';

const entries = JSON.parse(readFileSync(join(ROOT, 'data/entries.json'), 'utf8'));
const stars = existsSync(join(ROOT, 'data/stars.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data/stars.json'), 'utf8'))
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
function formatCreated(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
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
  const line2 = 'verified sfwa';
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

// Mirrors the embed-badge block added to renderDetail() in index.html's client script.
function embedBadgeHtml(slug, checks, passed) {
  if (!checks.length) return '';
  return `
    <div class="embed-badge">
      <div class="detail-checks-label">Embed this badge</div>
      <img class="badge-preview" src="${SITE_URL}/badge/${slug}.svg" alt="iamsingle.app — verified sfwa — ${passed}/${checks.length}">
      <textarea class="badge-snippet" id="badgeSnippet" readonly rows="2">[![iamsingle.app — verified sfwa — ${passed}/${checks.length}](${SITE_URL}/badge/${slug}.svg)](${SITE_URL}/entry/${slug})</textarea>
      <button type="button" class="btn-outline" id="copyBadgeBtn">Copy markdown</button>
    </div>`;
}

function logoSrc(e, size) {
  const homepageFavicon = 'https://www.google.com/s2/favicons?sz=' + size + '&domain_url=' + encodeURIComponent(e.url);
  return e.repo ? 'https://github.com/' + e.repo.split('/')[0] + '.png?size=' + size : homepageFavicon;
}

// Mirrors render()'s per-card markup in index.html's client script.
function renderCard(e, i) {
  const starInfo = e.repo ? stars[e.repo] : null;
  const absent = e.repo && !starInfo;
  const starsText = !e.repo ? '' : absent ? 'n/a' : '★ ' + formatStars(starInfo.stars);
  const dateText = !e.repo ? '' : absent ? 'n/a' : formatCreated(starInfo.created);
  const owner = e.repo ? e.repo.split('/')[0] : '';
  const ghPill = e.repo ? `<span class="gh-pill">
      <a class="gh-pill-icon" href="https://github.com/${e.repo}" target="_blank" rel="noopener" aria-label="${escapeHtml(e.repo)} on GitHub">${GH_ICON_SVG}</a>
      <span class="gh-stars">${starsText}</span>
      <span class="gh-date">${dateText}</span>
      <a class="gh-pill-by" href="https://github.com/${owner}" target="_blank" rel="noopener" title="${escapeHtml(owner)}">by ${escapeHtml(owner)}</a>
    </span>` : '';

  const checks = e.checks || [];
  const passed = checks.filter(c => c.status === 'pass').length;
  const hasChecks = checks.length > 0;
  const badgeLabel = checks.length ? `${passed}/${checks.length}` : '';
  const badgeColor = checks.length ? scoreColor(passed / checks.length) : '#8A8578';

  const rankLabel = pad(i + 1);

  const featuredHtml = (e.featured || []).map(f => f.platform === 'Hacker News'
    ? `<a class="hn-badge" href="${f.url}" target="_blank" rel="noopener" title="${escapeHtml(f.title || '')}"><span class="hn-y">Y</span>▲ ${f.points ?? '?'}</a>`
    : `<a class="hn-badge" href="${f.url}" target="_blank" rel="noopener" title="${escapeHtml(f.title || '')}">Featured on ${escapeHtml(f.platform)} ↗</a>`
  ).join('');
  const entrySlug = slugify(e.name);

  return `
    <div class="card">
      <div class="stub"><span class="n">${rankLabel}</span></div>
      <img class="logo" alt="" loading="lazy" src="${logoSrc(e, 64)}">
      <div class="meta">
        <p class="name">
          <a href="/entry/${entrySlug}" data-nav>${escapeHtml(e.name)}</a>
          ${ghPill}
        </p>
        <p class="desc">${escapeHtml(e.desc)}</p>
        <div class="tags">${featuredHtml}${e.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
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
    statParts.push(createdVal === 'n/a' ? '<span class="stat-word">created </span>n/a' : `<svg class="stat-date-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg><span class="stat-word">created </span>${createdVal}`);
    statParts.push(`<a class="stat-repo-link" href="https://github.com/${e.repo}" target="_blank" rel="noopener">${GH_ICON_SVG}${escapeHtml(e.repo.split('/')[1] || e.repo)} ↗</a>`);
  } else {
    statParts.push('no public repo linked');
  }
  if (hasChecks) {
    statParts.push(`<span class="badge" style="color:${badgeColor};border-color:${badgeColor};">${badgeLabel}</span>`);
  }
  const statStripHtml = `<div class="stat-strip">${statParts.join(' <span class="sep">·</span> ')}</div>`;

  const langHtml = languages.length ? `
    <div class="lang-bar">${languages.map((l, i) => `<span style="width:${l.pct}%;background:${langColor(l.name, i)};"></span>`).join('')}</div>
    <div class="lang-legend">${languages.map((l, i) => `<span class="lang-dot" style="background:${langColor(l.name, i)};"></span>${escapeHtml(l.name)} ${l.pct}%`).join(' <span class="sep">·</span> ')}</div>` : '';

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
            <h1>${escapeHtml(e.name)}</h1>
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
    ${hasChecks ? `<div class="detail-checks-label" id="audit-results">Security audit — full results</div><div class="detail-checks">${testsHtml}</div>` : ''}
    ${embedBadgeHtml(slug, checks, passed)}
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

function replaceBetweenMarkers(str, markerName, content) {
  const start = `<!-- BUILD:${markerName}:START -->`;
  const end = `<!-- BUILD:${markerName}:END -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(str)) {
    throw new Error(`build_pages: markers ${start} / ${end} not found in template`);
  }
  return str.replace(re, `${start}${content}${end}`);
}

const templateSrc = readFileSync(join(ROOT, 'index.html'), 'utf8');

// --- homepage: inject the pre-rendered catalog + ItemList JSON-LD ---
let home = templateSrc;
home = replaceBetweenMarkers(home, 'CATALOG', sorted.map(renderCard).join('\n'));
home = replaceBetweenMarkers(home, 'JSONLD', `<script type="application/ld+json">${jsonLdItemList()}</script>`);
writeFileSync(join(ROOT, 'index.html'), home);

// --- per-entry static pages + badges ---
const entryDir = join(ROOT, 'entry');
rmSync(entryDir, { recursive: true, force: true });
const badgeDir = join(ROOT, 'badge');
rmSync(badgeDir, { recursive: true, force: true });
mkdirSync(badgeDir, { recursive: true });

const TITLE_ANCHOR = '<title>iamsingle.app - single-file web app directory</title>';
const DESC_ANCHOR = '<meta name="description" content="A working directory of SFWAs (single-file web apps) — apps that ship as one HTML file, no install, no build, no server required. Ranked by GitHub stars, searchable by what it does.">';
const CANONICAL_ANCHOR = '<link rel="canonical" href="https://iamsingle.app/">';
const OG_TITLE_ANCHOR = '<meta property="og:title" content="iamsingle.app - single-file web app directory">';
const OG_DESC_ANCHOR = '<meta property="og:description" content="A working directory of SFWAs (single-file web apps) — no install, no build, no server required.">';
const OG_URL_ANCHOR = '<meta property="og:url" content="https://iamsingle.app/">';
const TW_TITLE_ANCHOR = '<meta name="twitter:title" content="iamsingle.app - single-file web app directory">';
const TW_DESC_ANCHOR = '<meta name="twitter:description" content="A working directory of SFWAs (single-file web apps) — no install, no build, no server required.">';
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

  let page = templateSrc; // fresh copy each time, not the homepage's populated `home`
  page = mustReplace(page, TITLE_ANCHOR, `<title>${escapeHtml(e.name)} — iamsingle.app</title>`);
  page = mustReplace(page, DESC_ANCHOR, `<meta name="description" content="${escapeHtml(metaDesc)}">`);
  page = mustReplace(page, CANONICAL_ANCHOR, `<link rel="canonical" href="${SITE_URL}/entry/${slug}">`);
  page = mustReplace(page, OG_TITLE_ANCHOR, `<meta property="og:title" content="${escapeHtml(e.name)} — iamsingle.app">`);
  page = mustReplace(page, OG_DESC_ANCHOR, `<meta property="og:description" content="${escapeHtml(metaDesc)}">`);
  page = mustReplace(page, OG_URL_ANCHOR, `<meta property="og:url" content="${SITE_URL}/entry/${slug}">`);
  page = mustReplace(page, TW_TITLE_ANCHOR, `<meta name="twitter:title" content="${escapeHtml(e.name)} — iamsingle.app">`);
  page = mustReplace(page, TW_DESC_ANCHOR, `<meta name="twitter:description" content="${escapeHtml(metaDesc)}">`);
  page = replaceBetweenMarkers(page, 'CATALOG', ''); // don't bloat every entry page with the full hidden catalog
  page = replaceBetweenMarkers(page, 'JSONLD', `<script type="application/ld+json">${jsonLdForEntry(e)}</script>`);
  page = mustReplace(page, CATALOGVIEW_ANCHOR, '<div id="catalogView" style="display:none;">');
  page = mustReplace(page, DETAILVIEW_ANCHOR, `<div id="detailView">${renderDetailHtml(e, slug)}</div>`);

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
