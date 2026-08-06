#!/usr/bin/env node
/* ===================================================================
   npm run thumbs — regenerate the read-back's slide pictures
   ===================================================================

   The closing read-back shows a tiny picture beside each slide it lists.
   Those live in the deck as SLIDE_THUMBS, a map keyed by SLIDE NUMBER —
   which means they are only correct for the deck as it stood when they
   were made. Insert a slide in the middle and every picture after it
   labels its neighbour; change a slide's content and its picture is a
   photograph of the past.

   Both happened. The deck shipped with these baked in and no way to
   remake them, so this exists: point it at the deck, it drives headless
   Chrome through every slide, and writes the map back.

   Run it after adding, removing or reordering a slide, and after any
   change that alters what a slide looks like.

     npm run thumbs                 regenerate all of them
     npm run thumbs -- --only 20,22 just those, leaving the rest alone
     npm run thumbs -- --keep       leave the PNGs behind for inspection

   Chrome is found at the usual Windows/macOS/Linux locations, or set
   CHROME_PATH. Nothing is downloaded.
   =================================================================== */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECK = path.join(root, 'nateland-investor-deck-EXTERNAL.html');

/* 168x95 is what the deck already used: 16:9 at the width .wr-thumb is
   drawn at, so it neither upscales nor gets resampled in the browser. */
const W = 168, H = 95;
const QUALITY = 72;

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i < 0 ? null : (args[i + 1] || ''); };
const only = flag('--only');
const keep = args.includes('--keep');

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(p => existsSync(p));

if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH to the executable.');
  process.exit(1);
}

let deck = readFileSync(DECK, 'utf8');
const total = (deck.match(/<section class="slide[^"]*"[^>]*data-title=/g) || []).length;
if (!total) { console.error('No slides found in the deck.'); process.exit(1); }

const wanted = only
  ? only.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= total)
  : Array.from({ length: total }, (_, i) => i + 1);

console.log(`${total} slides, regenerating ${wanted.length}`);
console.log(`chrome: ${CHROME}`);

const shots = mkdtempSync(path.join(tmpdir(), 'bw-thumbs-'));
const deckUrl = 'file:///' + DECK.replace(/\\/g, '/');

/* Existing pictures are kept unless this run replaces them, so --only can
   touch one slide without disturbing the others. */
const current = new Map();
const startTag = 'var SLIDE_THUMBS';
const start = deck.indexOf(startTag);
if (start < 0) { console.error('SLIDE_THUMBS not found in the deck.'); process.exit(1); }
const end = deck.indexOf('};', start) + 2;
[...deck.slice(start, end).matchAll(/"(\d+)"\s*:\s*"(data:[^"]+)"/g)]
  .forEach(m => current.set(+m[1], m[2]));

let made = 0;
for (const n of wanted) {
  const png = path.join(shots, `s${n}.png`);
  /* skipgate lets it past the passphrase, clean hides the editorial TODOs,
     and forcing reduced motion settles every reveal so the capture is the
     finished slide rather than a frame of its entrance. */
  const url = `${deckUrl}?skipgate=1&clean=1&slide=${n}`;
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--force-prefers-reduced-motion', '--virtual-time-budget=6000',
      '--window-size=1600,900', `--screenshot=${png}`, url
    ], { stdio: 'pipe', timeout: 90_000 });
  } catch (e) {
    console.log(`  ${String(n).padStart(2)}  capture FAILED — keeping the old picture`);
    continue;
  }
  if (!existsSync(png)) {
    console.log(`  ${String(n).padStart(2)}  no file written — keeping the old picture`);
    continue;
  }
  const webp = await sharp(png).resize(W, H, { fit: 'fill' }).webp({ quality: QUALITY }).toBuffer();
  current.set(n, 'data:image/webp;base64,' + webp.toString('base64'));
  made++;
  console.log(`  ${String(n).padStart(2)}  ${String(webp.length).padStart(5)} bytes`);
}

const keys = [...current.keys()].sort((a, b) => a - b);
const rebuilt = 'var SLIDE_THUMBS = {' +
  keys.map(k => `"${k}": "${current.get(k)}"`).join(', ') +
  '};   /* slide number -> tiny picture of it. Regenerate with npm run thumbs. */';

deck = deck.slice(0, start) + rebuilt + deck.slice(end);
writeFileSync(DECK, deck);

if (!keep) rmSync(shots, { recursive: true, force: true });

const missing = Array.from({ length: total }, (_, i) => i + 1).filter(n => !current.has(n));
console.log(`\nwrote ${made} picture${made === 1 ? '' : 's'}; map now covers ${keys.length} of ${total} slides`);
if (missing.length) console.log(`no picture for: ${missing.join(',')}`);
if (keep) console.log(`PNGs left in ${shots}`);
