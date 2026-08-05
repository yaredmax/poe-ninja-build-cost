const minRoll = document.getElementById('minRoll');
const minRollValue = document.getElementById('minRollValue');
const saleMode = document.getElementById('saleMode');
const saved = document.getElementById('saved');
const matchCorrupted = document.getElementById('matchCorruptedImplicits');
const cacheStatus = document.getElementById('cacheStatus');

for (const mode of PNC_SALE_MODES) {
  const option = document.createElement('option');
  option.value = mode.id;
  option.textContent = mode.label;
  saleMode.append(option);
}

let savedTimer = null;
function flashSaved() {
  saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    saved.hidden = true;
  }, 1500);
}

pncLoadSettings().then((settings) => {
  minRoll.value = settings.minRollPercent;
  minRollValue.textContent = `${settings.minRollPercent}%`;
  saleMode.value = settings.saleMode;
  matchCorrupted.checked = settings.matchCorruptedImplicits;
});

matchCorrupted.addEventListener('change', async () => {
  await pncSaveSettings({ matchCorruptedImplicits: matchCorrupted.checked });
  flashSaved();
});

minRoll.addEventListener('input', () => {
  minRollValue.textContent = `${minRoll.value}%`;
});

// Saved on release rather than on every pixel of the drag.
minRoll.addEventListener('change', async () => {
  await pncSaveSettings({ minRollPercent: Number(minRoll.value) });
  flashSaved();
});

saleMode.addEventListener('change', async () => {
  await pncSaveSettings({ saleMode: saleMode.value });
  flashSaved();
});

document.getElementById('clearCache').addEventListener('click', () => {
  // Prices live in `local`; the settings above live in `sync` and survive this.
  chrome.storage.local.clear(() => {
    cacheStatus.textContent = 'Cleared. The next run will price everything again.';
  });
});
