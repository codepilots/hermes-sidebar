#!/usr/bin/env node
/* Assemble dist/chrome and dist/firefox from the shared tree plus each
   browser's platform adapter and manifest. Only browser-specific files are
   duplicated; everything else comes from shared/. Run: node build.mjs */
import { cpSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const shared = join(root, 'shared');
const dist = join(root, 'dist');

const targets = {
  chrome: ['manifest.json', 'background.js', 'platform.js'],
  firefox: ['manifest.json', 'platform.js'],
};

for (const [browser, files] of Object.entries(targets)) {
  const out = join(dist, browser);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // 1. All shared, browser-agnostic code (skip dev-only tools/ and docs/).
  cpSync(shared, out, { recursive: true, filter: (src) => {
    const rel = src.slice(shared.length + 1);
    return rel !== 'tools' && rel !== 'docs' && !rel.startsWith('tools/') && !rel.startsWith('docs/');
  } });
  // 2. This browser's specific files (overwrite any shared names).
  for (const f of files) cpSync(join(root, browser, f), join(out, f));
  // 3. Sanity: manifest must parse.
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  console.log(`built dist/${browser}  (manifest v${manifest.manifest_version}, ${manifest.name} ${manifest.version})`);
}

// Report what is shared vs duplicated.
console.log('\nBrowser-specific files only:');
for (const [browser, files] of Object.entries(targets)) console.log(`  ${browser}/: ${files.join(', ')}`);
console.log('Everything else is shared/ (single source).');
