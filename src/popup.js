/**
 * The popup is the two settings people actually revisit, plus a way to reach
 * the rest — and one line answering the question that brings anyone here during
 * a run: is it still working?
 *
 * Everything here writes to the same `chrome.storage.sync` the options page
 * uses, and the content script re-reads it at the start of every run, so a
 * change applies to the *next* run. Never to the one in flight: restarting a
 * four-minute pass because someone nudged a slider is the rudest thing this
 * extension could do.
 */

const minRoll = document.getElementById('minRoll');
const minRollValue = document.getElementById('minRollValue');
const saleMode = document.getElementById('saleMode');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusBar = document.getElementById('statusBar');
const statusFill = document.getElementById('statusFill');
const cacheStatus = document.getElementById('cacheStatus');
const applies = document.getElementById('applies');

/** Where the content script leaves what the current run is doing. */
const STATUS_KEY = 'pnc:status';

/** Older than this and the tab it came from is gone, or the run is over. */
const STATUS_STALE_MS = 30000;

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById('report').href = PNC_BUG_URL;
document.getElementById('donate').href = PNC_DONATE_URL;

for (const mode of PNC_SALE_MODES) {
  const option = document.createElement('option');
  option.value = mode.id;
  option.textContent = mode.label;
  saleMode.append(option);
}

function paintSlider() {
  minRollValue.textContent = `${minRoll.value}%`;
  minRoll.style.setProperty('--fill', `${minRoll.value}%`);
}

pncLoadSettings().then((settings) => {
  minRoll.value = settings.minRollPercent;
  saleMode.value = settings.saleMode;
  paintSlider();
});

minRoll.addEventListener('input', paintSlider);

// Saved on release, not on every pixel of the drag.
minRoll.addEventListener('change', async () => {
  await pncSaveSettings({ minRollPercent: Number(minRoll.value) });
  noteChanged();
});

saleMode.addEventListener('change', async () => {
  await pncSaveSettings({ saleMode: saleMode.value });
  noteChanged();
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('clearCache').addEventListener('click', async (ev) => {
  ev.preventDefault();
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  showCache();
});

/** Only worth saying while something is actually running. */
let changed = false;
function noteChanged() {
  changed = true;
  showStatus();
}

async function showCache() {
  const stats = await chrome.runtime.sendMessage({ type: 'cacheStats' }).catch(() => null);
  cacheStatus.textContent = stats
    ? `Cache: ${stats.items} items · ${stats.ttlHours} h`
    : 'Cache: unavailable';
}

/**
 * Say plainly whether the extension does anything on the current tab, and what
 * it is doing if it is doing anything. Without this the popup looks identical on
 * a page where nothing will happen, which is the most common "it's broken"
 * report there is.
 */
async function showStatus() {
  // No `tabs` permission on purpose — it warns about reading browsing history
  // for something this small. The host permission for poe.ninja is enough:
  // Chrome fills in `url` for tabs we already have access to and leaves it
  // undefined everywhere else, which answers the question either way.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const onCharacter = /^https:\/\/poe\.ninja\/poe1\/(builds|profile)\/.*\/character\//.test(url);
  const onNinja = url.startsWith('https://poe.ninja/');

  const stored = await chrome.storage.local.get(STATUS_KEY);
  const run = stored[STATUS_KEY];
  const live = run && Date.now() - run.at < STATUS_STALE_MS
    && (run.phase === 'trading' || run.phase === 'paused' || run.phase === 'reading');

  statusBar.hidden = true;
  applies.hidden = !(changed && live);

  if (live && run.total) {
    const left = run.etaSeconds
      ? `, ${run.etaSeconds < 90 ? `~${run.etaSeconds} s` : `~${Math.round(run.etaSeconds / 60)} min`} left`
      : '';
    statusDot.className = run.phase === 'paused' ? 'dot' : 'dot live';
    statusText.parentElement.className = 'status live';
    statusText.textContent = run.phase === 'paused'
      ? `Paused — ${run.done}/${run.total}`
      : `Pricing — ${run.done}/${run.total}${left}`;
    statusBar.hidden = false;
    statusFill.style.width = `${Math.round((run.done / run.total) * 100)}%`;
    return;
  }

  if (live) {
    statusDot.className = 'dot live';
    statusText.parentElement.className = 'status live';
    statusText.textContent = 'Reading the character sheet…';
    return;
  }

  statusDot.className = onCharacter ? 'dot ok' : 'dot';
  statusText.parentElement.className = onCharacter ? 'status ready' : 'status';
  statusText.textContent = onCharacter
    ? 'Ready — press the button on the page'
    : onNinja
      ? 'Open a character page to price a build.'
      : 'Works on poe.ninja character pages.';
}

showStatus();
showCache();

// A pass finishes an item every few seconds, so this keeps up without polling.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATUS_KEY]) showStatus();
});
