#!/usr/bin/env node
/* ===================================================================
   npm run map — put a new park plan on slide 28
   ===================================================================

     npm run map -- <image> [--left N --top N --right N --bottom N]
                            [--width 4000] [--q 82]
     npm run map -- ../plan.png --dry     write the crop out and stop

   WHY --width MATTERS MORE THAN IT LOOKS

   Slide 28 zooms into a land on hover, at roughly 3.3x. So the embedded
   image is not sized for the 520px the slide shows at rest — it is sized
   for the slice visible when zoomed. At 4000px wide, a 3.3x zoom leaves
   about 1200 source pixels across a ~690px frame, which holds up. Drop to
   1400px and the zoom is a blur. Raise --width and everything gets sharper
   and heavier in a straight line.

   The deck embeds every image as base64, so replacing the map means
   cropping, encoding and splicing a data URI into a 3.8 MB HTML file. This
   does all three, and anchors on `class="map-holder"` so it cannot pick up
   one of the fifty other embedded images by mistake.

   WHY THERE IS A CROP AT ALL

   The plan that arrives from the architects carries a legend down its
   right-hand edge, a slice of the logo above it, and road names around the
   outside that are already half-truncated in the file itself. None of that
   belongs on the slide — the legend least of all, since the deck names the
   four lands in its own list beside the map. The defaults below are the
   crop for `park_cut_preview.png` (1600x1145), measured by rendering it and
   looking rather than by arithmetic.

   A DIFFERENT PLAN WILL NEED DIFFERENT NUMBERS. Run with --dry, open the
   PNG it writes, and adjust until the legend is gone and no text is cut.
   Then re-check the four regions: MAP_REGIONS in the deck is normalised to
   the image, so a new crop moves all of them.
   =================================================================== */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECK = path.join(root, 'nateland-investor-deck-EXTERNAL.html');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
const src = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));

if (!src) {
  console.error('\nWhich image?\n');
  console.error('  npm run map -- path/to/plan.png');
  console.error('  npm run map -- path/to/plan.png --dry\n');
  console.error('Crop defaults suit park_cut_preview.png; override with');
  console.error('--left --top --right --bottom, and check with --dry first.\n');
  process.exit(1);
}

/* Measured against park_cut_preview.png at 1600x1145: clears the legend and
   logo on the right, and the truncated road names top, bottom and left. */
const crop = {
  left:   flag('left', 44),
  top:    flag('top', 102),
  right:  flag('right', 1404),
  bottom: flag('bottom', 1074)
};
const quality = flag('q', 82);
const width = flag('width', 4000);
const dry = args.includes('--dry');

const meta = await sharp(src).metadata();
if (crop.right > meta.width || crop.bottom > meta.height) {
  console.error(`\nThe crop runs off the image: it is ${meta.width}x${meta.height}, ` +
                `crop wants ${crop.right}x${crop.bottom}.`);
  console.error('Pass --left/--top/--right/--bottom for this image.\n');
  process.exit(1);
}

const cropW = crop.right - crop.left;
const cropH = crop.bottom - crop.top;

const pipeline = sharp(src)
  .extract({ left: crop.left, top: crop.top, width: cropW, height: cropH })
  /* withoutEnlargement, because upscaling a small source only adds bytes. */
  .resize({ width, withoutEnlargement: true });

console.log(`source  ${path.basename(src)}  ${meta.width}x${meta.height}`);
console.log(`crop    x ${crop.left}..${crop.right}  y ${crop.top}..${crop.bottom}` +
            `  ->  ${cropW}x${cropH}  aspect ${(cropW / cropH).toFixed(3)}`);
console.log(`resize  to ${Math.min(width, cropW)}px wide`);

if (dry) {
  const out = path.join(root, 'map-crop-preview.png');
  await pipeline.clone().png().toFile(out);
  console.log(`\nWrote ${out}`);
  console.log('Open it. The legend and any cut-off text must be outside the frame.');
  console.log('Then run again without --dry. Delete the preview when done.\n');
  process.exit(0);
}

const webp = await pipeline.webp({ quality, effort: 6 }).toBuffer();
const b64 = webp.toString('base64');

let html = readFileSync(DECK, 'utf8');
const holder = html.indexOf('class="map-holder"');
if (holder < 0) { console.error('No map-holder in the deck — has slide 28 changed?'); process.exit(1); }

const marker = 'base64,';
const start = html.indexOf(marker, holder);
const from = start + marker.length;
const to = html.indexOf('"', from);
if (start < 0 || to < 0) { console.error('Could not find the map data URI.'); process.exit(1); }

const oldLen = to - from;
writeFileSync(DECK, html.slice(0, from) + b64 + html.slice(to), 'utf8');

console.log(`webp    quality ${quality}  ${(webp.length / 1024).toFixed(0)} KB`);
console.log(`base64  ${(oldLen / 1024).toFixed(0)} KB -> ${(b64.length / 1024).toFixed(0)} KB` +
            `  (deck ${(b64.length - oldLen) / 1024 > 0 ? '+' : ''}${((b64.length - oldLen) / 1024).toFixed(0)} KB)`);
console.log('\nNow check MAP_REGIONS in the deck: the four lands are normalised to');
console.log('the image, so a new crop moves every one of them. Slide 28, E >');
console.log('Map districts > Calibrate.\n');
