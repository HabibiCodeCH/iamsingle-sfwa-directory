#!/usr/bin/env node
// Captures a static screenshot per entry at build time (headless Chromium via
// Playwright), so entry pages have real visual content instead of just a
// small favicon-sized logo. Only screenshots entries that don't already have
// one — re-shooting the whole catalog on every data change would slow CI down
// and cause pointless git churn for entries that haven't changed. A stale
// screenshot (app's UI changed since it was shot) just sits there until
// someone deletes the file and triggers a re-shoot; there's no auto-refresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOT_DIR = join(ROOT, 'screenshot');
const VIEWPORT = { width: 1200, height: 750 };
const NAV_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 3_000; // best-effort only; some apps poll/websocket forever
const SETTLE_DELAY_MS = 1_200; // extra time for canvas/WebGL renders that finish after "load"

function slugify(s) {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'entry');
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
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const pending = [];
  for (const e of entries) {
    const slug = slugify(e.name);
    const dest = join(SCREENSHOT_DIR, `${slug}.png`);
    if (existsSync(dest)) continue;
    pending.push({ e, slug, dest });
  }

  if (!pending.length) {
    console.log('No new entries to screenshot.');
    return;
  }

  const browser = await chromium.launch();
  let shot = 0, skipped = 0;
  try {
    for (const { e, slug, dest } of pending) {
      const safe = await isSafeUrl(e.url);
      if (!safe) {
        console.warn(`skip ${slug}: URL failed safety check (${e.url})`);
        skipped++;
        continue;
      }
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.goto(e.url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
        await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(SETTLE_DELAY_MS);
        await page.screenshot({ path: dest, type: 'png' });
        shot++;
      } catch (err) {
        console.warn(`skip ${slug}: ${err.message}`);
        skipped++;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`Screenshotted ${shot} entr${shot === 1 ? 'y' : 'ies'}, skipped ${skipped}.`);
}

main();
