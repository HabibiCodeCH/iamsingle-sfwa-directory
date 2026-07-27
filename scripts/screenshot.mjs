#!/usr/bin/env node
// Captures a static screenshot, a file-size measurement, and a branded OG
// share-card per entry at build time (headless Chromium via Playwright), so
// entry pages have real visual content and every share renders as a card
// instead of a bare link. Each artifact is only (re)generated when missing —
// re-shooting the whole catalog on every data change would slow CI down and
// cause pointless git churn. A stale artifact (app's UI changed, checks
// re-ran) just sits there until someone deletes the file and triggers a
// re-shoot; there's no auto-refresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://iamsingle.app';
const FAVICON_DATA_URI = `data:image/png;base64,${readFileSync(join(ROOT, 'assets/favicon-180.png')).toString('base64')}`;
const SCREENSHOT_DIR = join(ROOT, 'screenshot');
const OG_DIR = join(ROOT, 'og');
const QR_DIR = join(ROOT, 'qr');
// Rough ceiling for "small enough to scan reliably" once base64-encoded into
// a data: URI (~33% overhead) — a standard QR code tops out around 2950
// bytes of binary payload at the lowest error-correction level.
const QR_MAX_BYTES = 2048;
const SIZES_PATH = join(ROOT, 'data/sizes.json');
const VIEWPORT = { width: 1200, height: 750 };
const OG_VIEWPORT = { width: 1200, height: 630 };
const NAV_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 3_000; // best-effort only; some apps poll/websocket forever
const SETTLE_DELAY_MS = 1_200; // extra time for canvas/WebGL renders that finish after "load"

function slugify(s) {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'entry');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatStars(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Mirrors scoreColor() in index.html's client script and build_pages.mjs.
function scoreColor(ratio) {
  const red = [168, 51, 29], green = [63, 107, 63];
  const mix = (a, b) => Math.round(a + (b - a) * ratio);
  return `rgb(${mix(red[0], green[0])}, ${mix(red[1], green[1])}, ${mix(red[2], green[2])})`;
}

// Purely local content (no external navigation, no SSRF surface) — built
// from already-computed entry/stars/size data, matching the site's own
// paper/ink/stamp palette and mono/serif fonts.
function ogCardHtml(e, { sizeBytes, starsVal, screenshotDataUri }) {
  const checks = e.checks || [];
  const hasChecks = checks.length > 0;
  const passed = checks.filter(c => c.status === 'pass').length;
  const badgeColor = hasChecks ? scoreColor(passed / checks.length) : '#8A8578';
  const owner = e.repo ? e.repo.split('/')[0] : null;

  const stats = [];
  if (starsVal != null) stats.push(`<span>★ ${starsVal}</span>`);
  if (sizeBytes != null) stats.push(`<span>${formatSize(sizeBytes)}</span>`);
  if (hasChecks) stats.push(`<span class="score" style="border-color:${badgeColor};color:${badgeColor};">${passed}/${checks.length}</span>`);
  const statsHtml = stats.join('<span class="sep"> · </span>');
  const byHtml = owner ? `<div class="by">by ${escapeHtml(owner)}</div>` : '';

  // With a screenshot: full-brightness full-bleed background, a solid dark
  // panel anchored to the bottom-left holds the text (legibility doesn't
  // depend on what's in the shot). A "1 file" sticker badge sits astride the
  // seam between image and panel — the site's single-file premise as a mark.
  // The kicker line inside the panel carries the branding, so no separate
  // watermark is needed there. Without a screenshot (capture failed/
  // skipped): plain paper background, dark text, no panel/sticker (nothing
  // to sit on), watermark restored since the kicker's contrast is lower.
  const hasShot = !!screenshotDataUri;
  const bg = hasShot ? `<div class="bg" style="background-image:url('${screenshotDataUri}');"></div>` : '';
  const panelBg = hasShot ? 'rgba(32,30,25,.98)' : 'transparent';
  const textColor = hasShot ? '#EEEBE2' : '#201E19';
  const softColor = hasShot ? '#C9C3B2' : '#57534A';
  const sticker = hasShot ? `
    <div class="sticker">
      <img src="${FAVICON_DATA_URI}" width="90" height="90" alt="">
    </div>` : '';
  const domain = hasShot ? '' : '<div class="domain">iamsingle.app</div>';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      width:1200px;height:630px;background:#EEEBE2;overflow:hidden;position:relative;
      font-family:ui-monospace,"SF Mono","Courier New",monospace;
    }
    .bg{position:absolute;inset:0;background-size:cover;background-position:center top;}
    .panel{
      position:absolute;left:0;right:0;bottom:0;height:50%;background:${panelBg};
      display:flex;flex-direction:column;justify-content:center;padding:0 48px;
    }
    .kicker{font-size:20px;letter-spacing:.08em;text-transform:uppercase;color:${softColor};margin-bottom:16px;}
    h1{
      font-family:Georgia,"Iowan Old Style","Times New Roman",serif;font-weight:400;
      font-size:64px;color:${textColor};line-height:1.1;margin-bottom:10px;
      overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
    }
    .by{font-size:22px;color:${softColor};margin-bottom:18px;}
    .stats{font-size:26px;color:${softColor};display:flex;gap:0;align-items:center;flex-wrap:wrap;}
    .stats span{white-space:nowrap;}
    .sep{opacity:.5;padding:0 18px;}
    .score{border:2px solid;padding:3px 14px;}
    .sticker{
      position:absolute;right:64px;bottom:214px;width:130px;height:130px;
      background:#EEEBE2;border:1px solid #C9C3B2;border-radius:12px;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 8px 24px rgba(0,0,0,.35);
    }
    .domain{position:absolute;bottom:56px;right:56px;font-size:22px;color:#A8331D;letter-spacing:.03em;}
  </style></head><body>
    ${bg}
    <div class="panel">
      <div class="kicker">iamsingle.app · verified sfwa</div>
      <h1>${escapeHtml(e.name)}</h1>
      ${byHtml}
      <div class="stats">${statsHtml}</div>
    </div>
    ${sticker}
    ${domain}
  </body></html>`;
}

// Mirrors is_safe_url() in security_scan.py — reject non-http(s) schemes and
// hosts that resolve to internal/private addresses, so a submitted URL can't
// be used to probe the CI runner's local network or cloud metadata endpoints.
function isDisallowedIp(ip) {
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    if (low === '::1') return true; // loopback
    if (low.startsWith('fe80:') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local (private)
    if (low.startsWith('ff')) return true; // multicast
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true; // malformed, treat as disallowed
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast + reserved
  return false;
}

async function isSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  try {
    const results = await lookup(host, { all: true });
    return results.every(r => !isDisallowedIp(r.address));
  } catch {
    return false; // could not resolve — don't navigate to it
  }
}

async function main() {
  const entries = JSON.parse(readFileSync(join(ROOT, 'data/entries.json'), 'utf8'));
  const stars = existsSync(join(ROOT, 'data/stars.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'data/stars.json'), 'utf8'))
    : {};
  const sizes = existsSync(SIZES_PATH) ? JSON.parse(readFileSync(SIZES_PATH, 'utf8')) : {};
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  mkdirSync(OG_DIR, { recursive: true });
  mkdirSync(QR_DIR, { recursive: true });

  const items = entries.map(e => {
    const slug = slugify(e.name);
    return {
      e,
      slug,
      dest: join(SCREENSHOT_DIR, `${slug}.png`),
      ogDest: join(OG_DIR, `${slug}.png`),
      qrDest: join(QR_DIR, `${slug}.png`),
      needsScreenshot: !existsSync(join(SCREENSHOT_DIR, `${slug}.png`)),
      needsSize: !(slug in sizes),
      needsOg: !existsSync(join(OG_DIR, `${slug}.png`)),
      needsQr: !existsSync(join(QR_DIR, `${slug}.png`)),
    };
  });

  const browser = await chromium.launch();
  let shot = 0, sized = 0, ogGenerated = 0, qrGenerated = 0, skipped = 0;
  try {
    // Screenshot + size measurement + QR generation all come from the same
    // live-URL navigation, so they're done together per entry when any is
    // needed — QR only for entries small enough to scan (see QR_MAX_BYTES).
    for (const item of items) {
      if (!item.needsScreenshot && !item.needsSize && !item.needsQr) continue;
      const { e, slug, dest, qrDest, needsScreenshot, needsSize, needsQr } = item;
      const safe = await isSafeUrl(e.url);
      if (!safe) {
        console.warn(`skip ${slug}: URL failed safety check (${e.url})`);
        skipped++;
        continue;
      }
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        const response = await page.goto(e.url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
        let body = null;
        if ((needsSize || needsQr) && response) {
          try {
            body = await response.text();
          } catch (err) {
            console.warn(`couldn't read response body for ${slug}: ${err.message}`);
          }
        }
        if (needsSize && body != null) {
          sizes[slug] = Buffer.byteLength(body, 'utf8');
          sized++;
        }
        if (needsQr && body != null) {
          const byteLen = Buffer.byteLength(body, 'utf8');
          if (byteLen <= QR_MAX_BYTES) {
            // Encodes a plain https:// URL rather than a data: URI directly —
            // iOS Camera/Safari refuse to navigate to a data: URI triggered
            // externally (anti-phishing protection). run/index.html is a
            // fixed, same-origin loader that decodes the fragment and
            // renders it client-side; fragments never reach the server, so
            // the app's actual source still never touches our backend.
            const runUrl = `${SITE_URL}/run#${Buffer.from(body, 'utf8').toString('base64')}`;
            await QRCode.toFile(qrDest, runUrl, { errorCorrectionLevel: 'L', margin: 2, width: 480 });
            qrGenerated++;
          }
        }
        if (needsScreenshot) {
          await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
          await page.waitForTimeout(SETTLE_DELAY_MS);
          await page.screenshot({ path: dest, type: 'png' });
          shot++;
        }
      } catch (err) {
        console.warn(`skip ${slug}: ${err.message}`);
        skipped++;
      } finally {
        await page.close();
      }
    }

    // OG cards are rendered from local data only — no external navigation,
    // so every entry missing one gets generated regardless of the above.
    for (const { e, slug, dest, ogDest, needsOg } of items) {
      if (!needsOg) continue;
      const starInfo = e.repo ? stars[e.repo] : null;
      const starsVal = starInfo ? formatStars(starInfo.stars) : null;
      const screenshotDataUri = existsSync(dest)
        ? `data:image/png;base64,${readFileSync(dest).toString('base64')}`
        : null;
      const page = await browser.newPage({ viewport: OG_VIEWPORT });
      try {
        await page.setContent(ogCardHtml(e, { sizeBytes: sizes[slug], starsVal, screenshotDataUri }));
        await page.screenshot({ path: ogDest, type: 'png' });
        ogGenerated++;
      } catch (err) {
        console.warn(`couldn't generate OG card for ${slug}: ${err.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(SIZES_PATH, JSON.stringify(sizes, null, 2));
  console.log(`Screenshotted ${shot}, measured ${sized}, OG cards ${ogGenerated}, QR codes ${qrGenerated}, skipped ${skipped}.`);
}

main();
