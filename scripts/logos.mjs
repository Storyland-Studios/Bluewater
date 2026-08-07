#!/usr/bin/env node
/* ===================================================================
   npm run logos — the prior-employer strip on the team slide
   ===================================================================
   Normalised to one height, then rendered as flat silhouettes by the
   deck's own CSS rather than as brand marks. Two reasons, and neither
   is decorative: a full-colour logo wall beside a fundraise reads as
   endorsement, and these files arrive in whatever colour their owner
   chose — several are black, which is invisible on this deck.

   Sources are Wikimedia Commons, fetched by scripts/logos.mjs and baked
   in as data URIs so the deck stays one offline file.
   =================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECK = path.join(root, 'nateland-investor-deck-EXTERNAL.html');
const SRC  = 'C:/Users/B/AppData/Local/Temp/claude/C--Users-B-Desktop-Storyland/b345200a-6c80-4da5-b8e0-53f70fb8d4be/scratchpad/logos';

/* 26px on the slide; 60 tall keeps it sharp at 2x and in the thumbnail. */
const H = 60;

/* Only companies a named team member actually worked for. Merlin has no
   Commons file, so it stands as a wordmark in the deck's own type. */
const MARKS = [
  { file: 'disney.png',    label: 'Disney' },
  { file: 'universal.png', label: 'Universal' },
  { file: 'warner.png',    label: 'Warner Bros.' },
  /* LEGO's mark is a red square with the name knocked out of it, so
     flattening it to one colour fills the square solid. A wordmark says the
     same thing and survives the treatment. */
  { file: null,            label: 'LEGO' },
  { file: 'aecom.png',     label: 'AECOM' },
  { file: null,            label: 'Merlin Entertainments' }
];

let deck = readFileSync(DECK, 'utf8');
const cells = [];

for (const m of MARKS) {
  if (!m.file) { cells.push(`<span class="lg-word">${m.label}</span>`); continue; }
  const p = path.join(SRC, m.file);
  if (!existsSync(p)) { console.log(`  missing: ${m.file}`); continue; }
  const buf = await sharp(p)
    .resize({ height: H, fit: 'inside', withoutEnlargement: false })
    .webp({ quality: 90, alphaQuality: 100 })
    .toBuffer();
  cells.push(`<img src="data:image/webp;base64,${buf.toString('base64')}" alt="${m.label}">`);
  console.log(`  ${m.label.padEnd(22)} ${(buf.length / 1024).toFixed(1)} KB`);
}

const strip = `<div class="logo-strip"><p class="lg-cap">Prior employers</p>` +
              `<div class="lg-row">${cells.join('')}</div></div>`;

/* replace an existing strip, or add one to the advisers block */
if (/<div class="logo-strip">[\s\S]*?<\/div><\/div>/.test(deck)) {
  deck = deck.replace(/<div class="logo-strip">[\s\S]*?<\/div><\/div>/, () => strip);
  console.log('\nstrip replaced');
} else {
  const anchor = '  </div>\r\n</section>\r\n\r\n<!-- ================= 17';
  if (deck.split(anchor).length - 1 !== 1) { console.error('\nadvisers anchor not found'); process.exit(1); }
  deck = deck.replace(anchor, () => `    ${strip}\r\n` + anchor);
  console.log('\nstrip added');
}

writeFileSync(DECK, deck);
