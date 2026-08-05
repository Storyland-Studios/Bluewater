#!/usr/bin/env node
/* ===================================================================
   npm run lint:php — parse the WordPress plugin
   ===================================================================

   There is one PHP file in this repo and it runs as a WordPress plugin, so
   a syntax error in it does not break the deck — it white-screens all of
   storylandstudios.com. That is a bad thing to find out from a customer,
   and `php -l` is not available on every machine that edits this repo.

   So it gets parsed with php-parser, which is a real PHP parser in
   JavaScript. Run it after touching anything under wordpress/.

   A hand-rolled brace counter was tried first and was worse than nothing:
   it read the `//` in `https://` as the start of a line comment, ate the
   rest of the line, left an unterminated string, and then reported
   confident nonsense about the whole file. Hence an actual parser.
   =================================================================== */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Engine from 'php-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir  = path.join(root, 'wordpress');

const parser = new Engine({
  parser: { extractDoc: true, suppressErrors: false },
  ast: { withPositions: true }
});

let files;
try {
  files = (await readdir(dir)).filter(f => f.endsWith('.php'));
} catch {
  console.log('No wordpress/ directory — nothing to lint.');
  process.exit(0);
}

if (!files.length) {
  console.log('No PHP files in wordpress/ — nothing to lint.');
  process.exit(0);
}

let bad = 0;

for (const file of files) {
  const full = path.join(dir, file);
  const src = await readFile(full, 'utf8');

  /* Not syntax, but the classic way a plugin breaks a site: a closing `?>`
     lets trailing whitespace become output, and output before headers means
     "headers already sent" on every page load. A BOM does the same. */
  const notes = [];
  if (src.includes('?>')) {
    notes.push('has a closing "?>" — trailing bytes after it become page output');
  }
  if (src.charCodeAt(0) === 0xFEFF) {
    notes.push('starts with a UTF-8 BOM — that is output, before any header');
  }

  try {
    const ast = parser.parseCode(src, file);
    const errors = ast.errors ?? [];
    if (errors.length) {
      bad++;
      console.log(`  ✗ ${file}`);
      for (const err of errors) console.log(`      line ${err.line}: ${err.message}`);
      continue;
    }
    console.log(`  ✓ ${file}`);
    for (const note of notes) console.log(`      note: ${note}`);
  } catch (err) {
    bad++;
    console.log(`  ✗ ${file}`);
    console.log(`      ${err.message}`);
  }
}

console.log('');
if (bad) {
  console.log(`${bad} file${bad === 1 ? '' : 's'} with syntax errors — do not deploy.`);
  process.exit(1);
}
console.log(`${files.length} file${files.length === 1 ? '' : 's'} parsed cleanly.`);
