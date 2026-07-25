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
const MEDALS = ['🥇', '🥈', '🥉'];

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
const GH_ICON_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.744.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.303-5.467-1.334-5.467-5.93 0-1.31.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .319.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>';

function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/\S+)/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}
function iconFor(s) { return s === 'pass' ? '✓' : s === 'fail' ? '✗' : '–'; }

// Default catalog sort is "stars" — mirrors currentList() with sortEl.value === 'stars'.
const sorted = entries.slice().sort((a, b) => {
  const sa = a.repo ? (stars[a.repo]?.stars ?? -1) : -1;
  const sb = b.repo ? (stars[b.repo]?.stars ?? -1) : -1;
  if (sa === sb) return a.name.localeCompare(b.name);
  return sb - sa;
});

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
  const testsHtml = checks.map(c =>
    `<div class="t-${c.status}">${iconFor(c.status)} ${escapeHtml(c.label)}${c.detail ? ' — ' + linkify(c.detail) : ''}</div>`
  ).join('');

  const rankLabel = i < 3 ? MEDALS[i] : pad(i + 1);

  const featuredHtml = (e.featured || []).map(f => f.platform === 'Hacker News'
    ? `<a class="hn-badge" href="${f.url}" target="_blank" rel="noopener" title="${escapeHtml(f.title || '')}"><span class="hn-y">Y</span>▲ ${f.points ?? '?'}</a>`
    : `<a class="hn-badge" href="${f.url}" target="_blank" rel="noopener" title="${escapeHtml(f.title || '')}">Featured on ${escapeHtml(f.platform)} ↗</a>`
  ).join('');

  return `
    <div class="card">
      <div class="stub"><span class="n">${rankLabel}</span></div>
      <img class="logo" alt="" loading="lazy" src="${logoSrc(e, 64)}">
      <div class="meta">
        <p class="name">
          <a href="${e.url}" target="_blank" rel="noopener">${escapeHtml(e.name)}</a>
          ${ghPill}
        </p>
        <p class="desc">${escapeHtml(e.desc)}</p>
        <div class="tags">${featuredHtml}${e.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      </div>
      ${hasChecks ? `<div class="audit"><span class="audit-label">security audit</span><span class="badge" data-toggle style="color:${badgeColor};border-color:${badgeColor};">${badgeLabel}</span></div>` : ''}
      ${hasChecks ? `<div class="tests">${testsHtml}</div>` : ''}
    </div>`;
}

// Mirrors renderDetail()'s markup in index.html's client script.
function renderDetailHtml(e) {
  const starInfo = e.repo ? stars[e.repo] : null;
  const absent = e.repo && !starInfo;
  const starsVal = !e.repo ? 'n/a' : absent ? 'n/a' : '★ ' + formatStars(starInfo.stars);
  const createdVal = !e.repo ? 'n/a' : absent ? 'n/a' : formatCreated(starInfo.created);
  const createdFull = (e.repo && !absent) ? starInfo.created : ' ';

  const checks = e.checks || [];
  const passed = checks.filter(c => c.status === 'pass').length;
  const hasChecks = checks.length > 0;
  const badgeColor = checks.length ? scoreColor(passed / checks.length) : '#8A8578';
  const testsHtml = checks.map(c =>
    `<div class="t-${c.status}">${iconFor(c.status)} ${escapeHtml(c.label)}${c.detail ? ' — ' + linkify(c.detail) : ''}</div>`
  ).join('');

  const repoCard = e.repo ? `
    <div class="stat-card">
      <div class="stat-label">Repository</div>
      <div class="stat-value mono">${escapeHtml(e.repo)}</div>
      <div class="stat-sub"><a href="https://github.com/${e.repo}" target="_blank" rel="noopener">View on GitHub ↗</a></div>
    </div>` : `
    <div class="stat-card">
      <div class="stat-label">Repository</div>
      <div class="stat-value mono">n/a</div>
      <div class="stat-sub">no public repo linked</div>
    </div>`;

  const auditCard = hasChecks ? `
    <div class="stat-card">
      <div class="stat-label">Security audit</div>
      <div class="stat-value" style="color:${badgeColor};">${passed}/${checks.length}</div>
      <div class="stat-sub">see checks below</div>
    </div>` : `
    <div class="stat-card">
      <div class="stat-label">Security audit</div>
      <div class="stat-value mono">n/a</div>
      <div class="stat-sub">not yet reviewed</div>
    </div>`;

  return `
    <nav class="crumb"><a href="/" data-nav>iamsingle.app</a><span class="sep">›</span><span class="current">${escapeHtml(e.name)}</span></nav>
    <div class="detail-header">
      <div class="detail-title">
        <img class="detail-logo" alt="" id="detailLogoImg" src="${logoSrc(e, 128)}">
        <div>
          <h1>${escapeHtml(e.name)}</h1>
          <p class="detail-desc">${escapeHtml(e.desc)}</p>
          <div class="tags" style="margin-top:10px;">${e.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
      </div>
      <div class="detail-actions">
        <button type="button" class="btn-outline" id="shareBtn">Share</button>
        <a class="btn-solid" href="${e.url}" target="_blank" rel="noopener">Visit ↗</a>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">GitHub stars</div>
        <div class="stat-value">${starsVal}</div>
        <div class="stat-sub">${e.repo ? 'daily snapshot' : 'no public repo'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Created</div>
        <div class="stat-value mono">${createdVal}</div>
        <div class="stat-sub">${createdFull}</div>
      </div>
      ${repoCard}
      ${auditCard}
    </div>
    ${hasChecks ? `<div class="detail-checks-label">Security audit — full results</div><div class="detail-checks">${testsHtml}</div>` : ''}
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

// --- per-entry static pages ---
const entryDir = join(ROOT, 'entry');
rmSync(entryDir, { recursive: true, force: true });

const TITLE_ANCHOR = '<title>iamsingle.app — a catalog of one-file web apps</title>';
const DESC_ANCHOR = '<meta name="description" content="A working directory of SFWAs (single-file web apps) — apps that ship as one HTML file, no install, no build, no server required. Ranked by GitHub stars, searchable by what it does.">';
const CANONICAL_ANCHOR = '<link rel="canonical" href="https://iamsingle.app/">';
const OG_TITLE_ANCHOR = '<meta property="og:title" content="iamsingle.app — a catalog of one-file web apps">';
const OG_DESC_ANCHOR = '<meta property="og:description" content="A working directory of SFWAs (single-file web apps) — no install, no build, no server required.">';
const OG_URL_ANCHOR = '<meta property="og:url" content="https://iamsingle.app/">';
const TW_TITLE_ANCHOR = '<meta name="twitter:title" content="iamsingle.app — a catalog of one-file web apps">';
const TW_DESC_ANCHOR = '<meta name="twitter:description" content="A working directory of SFWAs (single-file web apps) — no install, no build, no server required.">';
const DETAILVIEW_ANCHOR = '<div id="detailView" style="display:none;"></div>';
const CATALOGVIEW_ANCHOR = '<div id="catalogView">';

for (const e of sorted) {
  const slug = slugify(e.name);
  const metaDesc = truncate(e.desc, 155);

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
  page = mustReplace(page, DETAILVIEW_ANCHOR, `<div id="detailView">${renderDetailHtml(e)}</div>`);

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

console.log(`Generated: index.html, ${sorted.length} entry pages, sitemap.xml, robots.txt, llms.txt`);
