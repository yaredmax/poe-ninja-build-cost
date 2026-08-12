const minRoll = document.getElementById('minRoll');
const minRollValue = document.getElementById('minRollValue');
const saleMode = document.getElementById('saleMode');
const matchCorrupted = document.getElementById('matchCorruptedImplicits');
const budgetShare = document.getElementById('budgetShare');
const budgetShareNote = document.getElementById('budgetShareNote');
const useSession = document.getElementById('useSession');
const cacheStatus = document.getElementById('cacheStatus');

document.getElementById('report').href = PNC_BUG_URL;
document.getElementById('source').href = PNC_REPO;
document.getElementById('donate').href = PNC_DONATE_URL;
document.getElementById('aboutVersion').textContent =
  `Version ${chrome.runtime.getManifest().version}`;

for (const mode of PNC_SALE_MODES) {
  const option = document.createElement('option');
  option.value = mode.id;
  option.textContent = mode.label;
  saleMode.append(option);
}

for (const share of PNC_BUDGET_SHARES) {
  const option = document.createElement('option');
  option.value = share.id;
  option.textContent = share.label;
  budgetShare.append(option);
}

/** What the choice costs, under the choice, rather than in a table nobody reads. */
function paintBudgetNote() {
  budgetShareNote.textContent =
    PNC_BUDGET_SHARES.find((s) => s.id === budgetShare.value)?.note || '';
}

// ------ the sidebar

const panes = [...document.querySelectorAll('.pane')];
const navItems = [...document.querySelectorAll('.nav-item')];

function show(name) {
  for (const pane of panes) pane.hidden = pane.dataset.pane !== name;
  for (const item of navItems) item.classList.toggle('active', item.dataset.pane === name);
}

for (const item of navItems) {
  item.addEventListener('click', () => show(item.dataset.pane));
}
show('pricing');

// ------ the settings

/**
 * The slider paints its own filled half through a custom property: a separate
 * element behind a transparent track would have to know the thumb's geometry,
 * and that differs between platforms.
 */
function paintSlider() {
  minRollValue.textContent = `${minRoll.value}%`;
  minRoll.style.setProperty('--fill', `${minRoll.value}%`);
}

pncLoadSettings().then((settings) => {
  minRoll.value = settings.minRollPercent;
  saleMode.value = settings.saleMode;
  matchCorrupted.checked = settings.matchCorruptedImplicits;
  budgetShare.value = settings.budgetShare;
  useSession.checked = settings.useSession;
  paintSlider();
  paintBudgetNote();
});

minRoll.addEventListener('input', paintSlider);

// Saved on release rather than on every pixel of the drag.
minRoll.addEventListener('change', () => {
  pncSaveSettings({ minRollPercent: Number(minRoll.value) });
});

saleMode.addEventListener('change', () => {
  pncSaveSettings({ saleMode: saleMode.value });
});

matchCorrupted.addEventListener('change', () => {
  pncSaveSettings({ matchCorruptedImplicits: matchCorrupted.checked });
});

budgetShare.addEventListener('change', () => {
  pncSaveSettings({ budgetShare: budgetShare.value });
  paintBudgetNote();
});

useSession.addEventListener('change', () => {
  pncSaveSettings({ useSession: useSession.checked });
});

// ------ the cache

async function showCache() {
  const stats = await chrome.runtime.sendMessage({ type: 'cacheStats' }).catch(() => null);
  cacheStatus.textContent = stats
    ? `${stats.items} items · kept ${stats.ttlHours} h`
    : 'unavailable';
}

document.getElementById('clearCache').addEventListener('click', async () => {
  // Prices live in `local`; the settings above live in `sync` and survive this.
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  cacheStatus.textContent = 'Cleared. The next run will price everything again.';
});

showCache();
