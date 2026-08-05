// Static checks that catch the class of bug that has bitten this project twice:
// a script that never loads, a symbol that never resolves, an element id the
// JavaScript never touches. None of it needs a browser.
//
//   node tools/check-wiring.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok   ' : '  FAIL '}${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- the options page loads what it uses -------------------------------------
const optionsHtml = read('src/options.html');
const optionsJs = read('src/options.js');
const settingsJs = read('src/settings.js');

const scripts = [...optionsHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
check(
  scripts.indexOf('settings.js') !== -1 && scripts.indexOf('settings.js') < scripts.indexOf('options.js'),
  'options.html loads settings.js before options.js',
  scripts.join(' -> '),
);

const defined = new Set(
  [...settingsJs.matchAll(/(?:const|function)\s+(PNC_\w+|pnc\w+)/g)].map((m) => m[1]),
);
for (const [, symbol] of optionsJs.matchAll(/\b(PNC_\w+|pnc[A-Z]\w+)/g)) {
  check(defined.has(symbol), `options.js can resolve ${symbol}`);
}

// --- every element id the page declares is used ------------------------------
for (const [, id] of optionsHtml.matchAll(/\sid="([A-Za-z][\w-]*)"/g)) {
  check(optionsJs.includes(id), `options.js touches #${id}`);
}

// --- every setting reaches the queries ---------------------------------------
const contentJs = read('src/content.js');
const backgroundJs = read('src/background.js');
const keys = [...settingsJs.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
for (const key of keys) {
  check(contentJs.includes(key), `content.js sends ${key}`);
  check(backgroundJs.includes(key), `background.js reads ${key}`);
}

// --- messages the content script sends have a handler ------------------------
for (const [, type] of contentJs.matchAll(/send\('(\w+)'/g)) {
  check(new RegExp(`async ${type}\\(`).test(backgroundJs), `background.js handles "${type}"`);
}

// --- every CSS class the panel uses exists -----------------------------------
const contentCss = read('src/content.css');
const used = new Set([...contentJs.matchAll(/pnc-[a-z-]+/g)].map((m) => m[0]));
for (const cls of used) {
  if (/bridge|request|item|summary/.test(cls)) continue; // message names, not classes
  check(contentCss.includes(cls), `content.css defines .${cls}`);
}

// --- the manifest points at files that exist ---------------------------------
const manifest = JSON.parse(read('manifest.json'));
const referenced = [
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  manifest.action?.default_popup,
].filter(Boolean);
for (const path of referenced) {
  let exists = true;
  try { read(path); } catch { exists = false; }
  check(exists, `manifest references ${path}`);
}

console.log(failures ? `\n${failures} problem(s)` : '\nall wired');
process.exit(failures ? 1 : 0);
