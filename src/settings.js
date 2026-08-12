// Settings shared by the options page and the content script.
//
// Plain script rather than a module: the content script is injected as a classic
// script and cannot use `import`, so this file is simply listed before it.

const PNC_DEFAULTS = {
  minRollPercent: 80,
  saleMode: 'securable',
  // A corrupted unique is a different item at a different price: a Le Heup of
  // All with "+1 to Maximum Power Charges" is worth many times a plain one.
  matchCorruptedImplicits: true,
  // How much of GGG's rate limit a pass may take. The buckets are per IP, so
  // the trade site the player has open is spending the same allowance, and
  // going over costs half an hour of lockout.
  budgetShare: 'balanced',
  // Whether to send their pathofexile.com session with trade requests. Off
  // until asked: the account is theirs, and so is any penalty landing on it.
  useSession: false,
};

/** Mirrors BUDGET_SHARES in src/lib/rate-limit.js, for the options page. */
const PNC_BUDGET_SHARES = [
  { id: 'fast', label: 'Fastest pass', note: 'Leaves you about 3 searches every 5 minutes.' },
  { id: 'balanced', label: 'Balanced', note: 'Leaves you about 5 searches every 5 minutes.' },
  {
    id: 'gentle',
    label: 'Leave room for my own searches',
    note: 'Leaves you about 10, and the pass takes roughly half as long again.',
  },
];

/**
 * The three links every surface offers.
 *
 * Flat constants rather than one object on purpose: check-wiring.mjs reads
 * two-space-indented keys in this file as settings that both content.js and
 * background.js have to pass through, and a donate URL is not one.
 */
const PNC_REPO = 'https://github.com/yaredmax/poe-ninja-build-cost';
const PNC_BUG_URL = `${PNC_REPO}/issues/new`;
/*
 * Ko-fi's own tip panel rather than the profile page behind it. The query
 * string is what their embed widget uses, and opened as a page it renders just
 * the panel — "Buy a Coffee for Yared", the amount, the button, and nothing
 * else. Verified: 97 characters of text, no feed, no gallery, no shop.
 *
 * If Ko-fi ever stops honouring those parameters the failure is graceful: they
 * get ignored and the visitor lands on the normal page, which is where this
 * would have pointed anyway.
 *
 * It used to point at `${PNC_REPO}#support`, which was a detour through the
 * README to a paragraph that thanked people and gave them nowhere to go.
 */
const PNC_DONATE_URL = 'https://ko-fi.com/yaredmax/?hidefeed=true&widget=true&embed=true&preview=true';

/** Same list the trade site shows in its own dropdown. */
const PNC_SALE_MODES = [
  { id: 'available', label: 'Instant Buyout and In Person' },
  { id: 'securable', label: 'Instant Buyout' },
  { id: 'online', label: 'In Person (Online)' },
  { id: 'onlineleague', label: 'In Person (Online in League)' },
  { id: 'any', label: 'Any' },
];

/**
 * Where the settings live, or `null` when there is nowhere to put them.
 *
 * `sync` rather than `local` so they follow the user between machines, falling
 * back to `local` if sync is turned off.
 *
 * The null case is real and easy to hit: reloading the extension while a
 * poe.ninja tab is open orphans the content script already injected in it. Its
 * `chrome.storage` becomes `undefined` — not an error, just gone — so reading
 * `.sync` off it throws and takes the whole panel down with it. Nothing here is
 * worth breaking the page over; the defaults are perfectly good settings.
 */
function pncStorageArea() {
  const storage = typeof chrome !== 'undefined' ? chrome.storage : null;
  return storage?.sync || storage?.local || null;
}

function pncLoadSettings() {
  return new Promise((resolve) => {
    const area = pncStorageArea();
    if (!area) return resolve({ ...PNC_DEFAULTS });
    try {
      area.get(PNC_DEFAULTS, (stored) => {
        if (chrome.runtime?.lastError) return resolve({ ...PNC_DEFAULTS });
        resolve({ ...PNC_DEFAULTS, ...stored });
      });
    } catch {
      resolve({ ...PNC_DEFAULTS });
    }
  });
}

function pncSaveSettings(patch) {
  return new Promise((resolve) => {
    const area = pncStorageArea();
    if (!area) return resolve();
    try {
      area.set(patch, () => resolve());
    } catch {
      resolve();
    }
  });
}
