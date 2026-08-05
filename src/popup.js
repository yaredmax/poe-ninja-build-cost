/**
 * The popup is the two settings people actually revisit, plus a way to reach
 * the rest. Everything here writes to the same `chrome.storage.sync` the
 * options page uses, and the content script re-reads it on every run, so a
 * change applies to the next click of "Calculate cost".
 */

const REPO = 'https://github.com/yaredmax/poe-ninja-build-cost';

const minRoll = document.getElementById('minRoll');
const minRollValue = document.getElementById('minRollValue');
const saleMode = document.getElementById('saleMode');
const where = document.getElementById('where');

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById('report').href = `${REPO}/issues/new`;
document.getElementById('donate').href = `${REPO}#support`;

for (const mode of PNC_SALE_MODES) {
  const option = document.createElement('option');
  option.value = mode.id;
  option.textContent = mode.label;
  saleMode.append(option);
}

pncLoadSettings().then((settings) => {
  minRoll.value = settings.minRollPercent;
  minRollValue.textContent = `${settings.minRollPercent}%`;
  saleMode.value = settings.saleMode;
});

minRoll.addEventListener('input', () => {
  minRollValue.textContent = `${minRoll.value}%`;
});

// Saved on release, not on every pixel of the drag.
minRoll.addEventListener('change', () => {
  pncSaveSettings({ minRollPercent: Number(minRoll.value) });
});

saleMode.addEventListener('change', () => {
  pncSaveSettings({ saleMode: saleMode.value });
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

/**
 * Say plainly whether the extension does anything on the current tab. Without
 * this the popup looks identical on a page where nothing will happen, which is
 * the most common "it's broken" report there is.
 */
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  // No `tabs` permission on purpose — it warns about reading browsing history
  // for something this small. The host permission for poe.ninja is enough:
  // Chrome fills in `url` for tabs we already have access to and leaves it
  // undefined everywhere else, which answers the question either way.
  const url = tab?.url || '';
  const onCharacter = /^https:\/\/poe\.ninja\/poe1\/(builds|profile)\/.*\/character\//.test(url);
  const onNinja = url.startsWith('https://poe.ninja/');

  if (onCharacter) {
    where.textContent = 'Ready — use the panel on the page to calculate.';
  } else if (onNinja) {
    where.textContent = 'Open a character page to price a build.';
  } else {
    where.textContent = 'Works on poe.ninja character pages.';
  }
});
