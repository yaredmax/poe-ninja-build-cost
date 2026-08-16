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

/** Source with comments removed, for checks that scan for identifiers. */
const withoutComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

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
  if (/bridge|request|item|summary|console/.test(cls)) continue; // message names, not classes
  check(contentCss.includes(cls), `content.css defines .${cls}`);
}

// --- the names the README tells you to type actually exist there -------------
// They have to be defined in page-bridge.js. DevTools evaluates in the page's
// world and content.js lives in an isolated one, so a `window.pncX` set there is
// invisible to the console — which is how pncDiagnose() came to be documented,
// for months, as something you could type.
{
  const readme = read('README.md');
  const bridge = read('src/page-bridge.js');
  for (const [, name] of readme.matchAll(/\b(pnc[A-Z]\w*)\(\)/g)) {
    check(bridge.includes(`window.${name} =`), `${name}() is reachable from the page console`);
  }
}

// --- a message payload reaches the helper that reads it ----------------------
// The bug this catches shipped: appraiseItem() was split out of appraise() with
// the old parameter list, and a later feature used `implicitPool` and
// `matchCorruptedImplicits` inside it. Both names existed in the caller, so the
// code read fine; at runtime every unique and jewel threw ReferenceError.
{
  /** The body of a function, by brace matching from its signature. */
  const bodyOf = (src, at) => {
    const start = src.indexOf('{', at);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i);
    }
    return '';
  };
  const params = (sig) => [...sig.matchAll(/(\w+)(?:\s*:\s*\w+)?/g)].map((m) => m[1]);

  // Everything a handler destructures out of its message.
  const payload = new Set();
  for (const m of backgroundJs.matchAll(/async (\w+)\(\{([^}]*)\}\)/g)) {
    for (const name of params(m[2])) payload.add(name);
  }

  // Every plain helper, and what it declares.
  for (const m of backgroundJs.matchAll(/async function (\w+)\(\{([\s\S]*?)\}\)\s*\{/g)) {
    const [, name, sig] = m;
    const bound = new Set(params(sig));
    // Prose stripped first. This scans for a bare identifier, and a comment
    // explaining what the code does is full of the words the code uses: the
    // sentence "a build at league start is mostly items like that" reported
    // runAppraisal() as reading `items`. The same trap already bit the slim()
    // comparison below, for the same reason.
    const body = withoutComments(bodyOf(backgroundJs, m.index + m[0].length - 1));
    for (const key of payload) {
      // Used as a bare identifier, not as `obj.key` or `key:` in a literal.
      const used = new RegExp(`(?<![.\\w])${key}(?![\\w:])`).test(body);
      if (used) check(bound.has(key), `${name}() declares ${key} it reads`);
    }
  }
}

// --- the fixture collector mirrors the bridge's item shape -------------------
// collect-fixture.mjs has to duplicate slim(): the real one lives inside an IIFE
// in a MAIN-world content script, and Chrome has no declarative module content
// scripts, so it cannot be imported. This keeps the copy from drifting.
let bridgeFields;
{
  // Indentation differs — the bridge's slim() sits inside an IIFE — so the
  // object is brace-matched and only its top-level keys are taken.
  const fields = (whole) => {
    // Comments first: prose inside the object is full of "word: more words",
    // which reads exactly like a key.
    const src = whole.replace(/^\s*\/\/.*$/gm, '');
    const start = src.indexOf('return {', src.indexOf('function slim('));
    const keys = new Set();
    let depth = 0;
    let lineStart = true;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      const ch = src[i];
      if (ch === '\n') { lineStart = true; continue; }
      if (ch === '{') { depth++; lineStart = false; continue; }
      if (ch === '}') { if (--depth === 0) break; lineStart = false; continue; }
      if (/\s/.test(ch)) continue;
      // Only an identifier that opens its own line is a key; anything else at
      // this depth is part of a value. Shorthand (`index,`) counts too.
      if (depth === 1 && lineStart) {
        const m = /^(\w+)\s*[:,]/.exec(src.slice(i));
        if (m) keys.add(m[1]);
      }
      lineStart = false;
    }
    return keys;
  };
  const bridge = fields(read('src/page-bridge.js'));
  bridgeFields = bridge;
  const copy = fields(read('tools/collect-fixture.mjs'));
  // The copy spreads modLines() in place of the five mod arrays, and takes the
  // slot as an argument rather than reading it off the item.
  const spread = new Set(['implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods', 'enchantMods']);
  const missing = [...bridge].filter((f) => !copy.has(f) && !spread.has(f));
  const extra = [...copy].filter((f) => !bridge.has(f));
  check(!missing.length && !extra.length, 'collect-fixture.mjs slim() matches the bridge',
    [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '']
      .filter(Boolean).join('; '));
}

// --- the hand-pasted fixture carries what the pipeline reads -----------------
// worn.json is copied out of a page console rather than written by a script, so
// nothing stops a paste from arriving without `defences` or `weapon`. Those are
// read unguarded when the property filters are built, and the item would fail
// with a TypeError twenty minutes into a rate-limited run.
{
  const worn = JSON.parse(read('tools/fixtures/worn.json')).items;
  const bad = [];
  for (const item of worn) {
    const missing = [...bridgeFields].filter((f) => !(f in item));
    if (missing.length) bad.push(`${item.name || item.baseType}: no ${missing.join(', ')}`);
    // The label the test prints, and the only field the bridge does not supply.
    if (!item.kind) bad.push(`${item.name || item.baseType}: no kind`);
  }
  check(!bad.length, `worn.json items match the bridge's shape (${worn.length})`, bad.join('; '));
}

// --- content.js's copy of modTemplate still matches the real one -------------
// It compares item modifiers against poe.ninja's published pools, which were
// normalised by stats.js. If the two normalisations disagree, every comparison
// silently says "not published" and every unique goes to trade.
{
  const body = (src, name) => {
    const at = src.indexOf(`function ${name}(`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        return src.slice(open + 1, i).replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };
  const real = body(read('src/lib/stats.js'), 'modTemplate');
  const copy = body(read('src/content.js'), 'pncModTemplate');
  check(real === copy && real.length > 0, 'content.js pncModTemplate matches stats.js modTemplate');
}

{
  const body = (src, name) => {
    const at = src.indexOf(`function ${name}(`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        return src.slice(open + 1, i).replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };
  const real = body(read('src/lib/pob-item.js'), 'gemImpliesCorruption');
  const copy = body(read('src/content.js'), 'pncGemImpliesCorruption');
  check(real === copy && real.length > 0, 'content.js pncGemImpliesCorruption matches pob-item.js gemImpliesCorruption');
}

// --- page-bridge.js's PoB helpers still match the module they were copied from
{
  const body = (src, name) => {
    const at = src.indexOf(`function ${name}(`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        return src.slice(open + 1, i).replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };
  const lib = read('src/lib/pob-item.js');
  const bridge = read('src/page-bridge.js');
  for (const name of [
    'stripPobHeaders', 'joinWrappedMods', 'linksFromSocketLine', 'defencesFromModLines',
    'flaskBaseType', 'slotOf', 'stableId', 'withoutImplicitDupes',
    'gemStatQueues', 'takeGemStats', 'gemImpliesCorruption',
  ]) {
    const a = body(lib, name);
    const b = body(bridge, name);
    check(a === b && a.length > 0, `page-bridge.js ${name} matches pob-item.js`);
  }
}

// --- content.js passes nothing it never declared -----------------------------
// The background guard above only covers background.js, and the same mistake
// landed here: `basePoolFor(match, priceIndex)` where no `priceIndex` existed.
// Narrow on purpose — bare identifiers passed as call arguments — so it stays
// free of the false positives a real scope analysis would need to avoid.
{
  const src = read('src/content.js').replace(/^\s*\/\/.*$/gm, '');
  const declared = new Set([
    ...[...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    // Destructured bindings and parameters, taken loosely.
    ...[...src.matchAll(/[({,]\s*([A-Za-z_$][\w$]*)\s*[,})=:]/g)].map((m) => m[1]),
    ...[...read('src/settings.js').matchAll(/\b(?:const|function)\s+([A-Za-z_$][\w$]*)/g)]
      .map((m) => m[1]),
  ]);
  const GLOBALS = new Set([
    'window', 'document', 'location', 'chrome', 'console', 'setTimeout', 'clearTimeout',
    'Promise', 'Math', 'Set', 'Map', 'JSON', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'Date', 'RegExp', 'Error', 'NodeFilter', 'MutationObserver', 'URL',
    'true', 'false', 'null', 'undefined', 'this', 'typeof', 'new', 'await', 'return',
  ]);

  const unknown = new Set();
  for (const call of src.matchAll(/\b([A-Za-z_$][\w$]*)\(([^()]*)\)/g)) {
    for (const arg of call[2].split(',')) {
      const name = arg.trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (declared.has(name) || GLOBALS.has(name)) continue;
      unknown.add(name);
    }
  }
  check(unknown.size === 0, 'content.js only passes names it declares',
    unknown.size ? [...unknown].join(', ') : '');
}

// --- the manifest points at files that exist ---------------------------------
const manifest = JSON.parse(read('manifest.json'));
const referenced = [
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);
for (const path of referenced) {
  let exists = true;
  try { read(path); } catch { exists = false; }
  check(exists, `manifest references ${path}`);
}

console.log(failures ? `\n${failures} problem(s)` : '\nall wired');
process.exit(failures ? 1 : 0);
