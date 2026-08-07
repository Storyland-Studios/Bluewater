#!/usr/bin/env node
/* ===================================================================
   npm run headshots — embed the team portraits into the deck
   ===================================================================

   The team slide showed initials in a box. This replaces each box with
   the person's photograph, baked into the HTML as a data URI so the deck
   stays one file that works from a memory stick with no network.

     npm run headshots -- --from "C:/Users/B/Downloads"

   Files are matched to people by name: the filename need only contain
   the person's first name, or their surname, in any case. Anyone with no
   match keeps their initials, which is why the mapping is reported at the
   end rather than assumed.

   Portraits are square-cropped from the top — a head sits above centre in
   almost every headshot, so a centre crop cuts foreheads.
   =================================================================== */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECK = path.join(root, 'nateland-investor-deck-EXTERNAL.html');

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i < 0 ? null : (args[i + 1] || ''); };
const FROM = flag('--from') || path.join(process.env.USERPROFILE || '', 'Downloads');

/* 154px on the slide, so 320 keeps it sharp on a retina panel and at the
   1600-wide capture the thumbnail generator takes. */
const PX = 320, QUALITY = 82;

let deck = readFileSync(DECK, 'utf8');

/* Everyone on the slide, in document order. The box holds initials on a first
   run and a portrait on any later one, so this matches either — otherwise the
   script would only ever work once and changing the size would mean starting
   from a clean checkout. */
const members = [...deck.matchAll(
  /<div class="av">([\s\S]*?)<\/div><div class="nm">([^<]*)<\/div>/g)]
  .map(m => ({ inner: m[1], name: m[2].replace(/&amp;/g, '&') }));

if (!members.length) { console.error('No team members found in the deck.'); process.exit(1); }
if (!existsSync(FROM)) { console.error(`No such folder: ${FROM}`); process.exit(1); }

const files = readdirSync(FROM).filter(f => /\.(jpe?g|png|webp)$/i.test(f));

/* First name or surname, whichever the file happens to be named for. */
function findFile(name) {
  const parts = name.toLowerCase().split(/\s+/).filter(p => p.length > 2);
  let best = null;
  for (const f of files) {
    const stem = f.toLowerCase().replace(/\.[^.]+$/, '');
    for (const p of parts) {
      if (stem.includes(p) && (!best || stem.length < best.stem.length)) best = { f, stem };
    }
  }
  return best && best.f;
}

let done = 0;
const report = [];
for (const m of members) {
  const file = findFile(m.name);
  if (!file) { report.push([m.name, '—', 'no photograph — kept initials']); continue; }

  const buf = await sharp(path.join(FROM, file))
    .resize(PX, PX, { fit: 'cover', position: 'top' })
    .webp({ quality: QUALITY })
    .toBuffer();

  const uri = 'data:image/webp;base64,' + buf.toString('base64');
  const from = `<div class="av">${m.inner}</div><div class="nm">${m.name.replace(/&/g, '&amp;')}</div>`;
  const to = `<div class="av"><img src="${uri}" alt=""></div>` +
             `<div class="nm">${m.name.replace(/&/g, '&amp;')}</div>`;

  if (deck.split(from).length - 1 !== 1) {
    report.push([m.name, file, 'MARKUP NOT UNIQUE — skipped']);
    continue;
  }
  deck = deck.replace(from, () => to);
  done++;
  report.push([m.name, file, `${(buf.length / 1024).toFixed(1)} KB`]);
}

writeFileSync(DECK, deck);

console.log(`${done} of ${members.length} portraits embedded, from ${FROM}\n`);
report.forEach(([a, b, c]) => console.log(`  ${a.padEnd(20)} ${String(b).padEnd(24)} ${c}`));
