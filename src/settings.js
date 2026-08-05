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
};

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
