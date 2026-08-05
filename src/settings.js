// Settings shared by the options page and the content script.
//
// Plain script rather than a module: the content script is injected as a classic
// script and cannot use `import`, so this file is simply listed before it.

const PNC_DEFAULTS = {
  minRollPercent: 80,
  saleMode: 'available',
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
 * `sync` rather than `local` so the settings follow the user between machines.
 * It falls back to local storage on its own when sync is unavailable.
 */
function pncLoadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(PNC_DEFAULTS, (stored) => {
      if (chrome.runtime.lastError) return resolve({ ...PNC_DEFAULTS });
      resolve({ ...PNC_DEFAULTS, ...stored });
    });
  });
}

function pncSaveSettings(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(patch, () => resolve());
  });
}
