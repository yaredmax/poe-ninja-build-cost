// Builds the zip you hand to a tester.
//
//   node tools/package.mjs
//   -> dist/poe-ninja-build-cost-0.4.0.zip
//
// They unzip it anywhere, open chrome://extensions, turn on Developer mode and
// press "Load unpacked" on the unzipped folder. Chrome will not install a bare
// .crx from outside the Web Store, so a folder is the only route that works
// without publishing.
//
// Only what the extension actually loads goes in. tools/, docs/, the fixtures
// and the local Awakened clone are for working on it, not for running it, and a
// tester downloading three megabytes of them would reasonably wonder why.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

/** Everything the manifest points at, plus the manifest itself. */
function shippedFiles() {
  const named = [
    manifest.background?.service_worker,
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);

  // The HTML pages pull in stylesheets and scripts the manifest never mentions.
  const extra = new Set();
  for (const page of named.filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(root, page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      // Anchors, links out and inline data are not files on disk. Only things
      // with an extension are.
      if (/^(https?:)?\/\/|^[#?]|^(mailto|data|javascript):/i.test(ref)) continue;
      if (!/\.[a-z0-9]+$/i.test(ref.split(/[?#]/)[0])) continue;
      extra.add(join(dirname(page), ref.split(/[?#]/)[0]).replace(/\\/g, '/'));
    }
  }

  // And the service worker is a module: its imports appear nowhere else. The
  // first zip built without this shipped a background.js that could not resolve
  // ./lib/trade.js, which is an extension that installs and does nothing.
  const seen = new Set();
  const queue = [...named, ...extra].filter((f) => f.endsWith('.js'));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(join(root, file))) continue;
    seen.add(file);
    const js = readFileSync(join(root, file), 'utf8');
    for (const m of js.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(join(dirname(file), m[1]).replace(/\\/g, '/'));
    }
  }

  return [...new Set([...named, ...extra, ...seen, 'manifest.json'])];
}

const files = shippedFiles();
const missing = files.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error(`referenced but absent:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const name = `poe-ninja-build-cost-${manifest.version}`;
const stage = join(root, 'dist', name);
const zip = join(root, 'dist', `${name}.zip`);

rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
for (const file of files) {
  const target = join(stage, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target);
}

// A note in the zip, so the tester does not have to be told how to load it.
writeFileSync(join(stage, 'INSTALL.txt'), [
  `poe-ninja-build-cost ${manifest.version}`,
  '',
  '1. Open chrome://extensions',
  '2. Turn on "Developer mode" (top right)',
  '3. Press "Load unpacked" and pick this folder',
  '4. Open any poe.ninja build page and click the button in the bottom right',
  '',
  'Something priced wrong? The badge links to the exact trade search behind',
  'that number — send that link and the build URL.',
  `${manifest.homepage_url || 'https://github.com/yaredmax/poe-ninja-build-cost'}/issues/new`,
  '',
].join('\n'));

// PowerShell rather than a zip dependency: it is already here, and this only
// ever runs on the machine that builds the release.
execFileSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`,
], { stdio: 'inherit' });

const kb = (statSync(zip).size / 1024).toFixed(0);
console.log(`\n${files.length + 1} files, ${kb} KB`);
console.log(`dist/${name}.zip`);
