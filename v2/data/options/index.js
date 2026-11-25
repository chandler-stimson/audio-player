'use strict';

const form = document.getElementById('preferences');
const status = document.getElementById('status');
const heightInput = document.getElementById('height');
const extendedHeightInput = document.getElementById('extended-height');

const REMEMBER_CHOICES = [10, 30, 60, 0];
const SKIP_CHOICES = ['5', '10', '30', '60', '1/60', '1/30', '1/10'];

const rememberId = n => n === 0 ? 'remember-none' : 'remember-' + n;

/* every preference of the toolbar action menu is editable here; the worker
   and the player page read the same keys and the same defaults */
const read = async () => {
  const prefs = await chrome.storage.local.get({
    height: 120,
    'extended-height': 600,
    'extended-view': false,
    'remember-tracks': 30,
    'skip-period': 10
  });

  heightInput.value = prefs.height;
  extendedHeightInput.value = prefs['extended-height'];
  document.getElementById('open-player-current').checked = prefs['extended-view'] === false;
  document.getElementById('open-player-extended').checked = prefs['extended-view'] === true;

  const remember = REMEMBER_CHOICES.includes(prefs['remember-tracks']) ?
    prefs['remember-tracks'] : 30;
  for (const n of REMEMBER_CHOICES) {
    document.getElementById(rememberId(n)).checked = n === remember;
  }

  const skip = String(prefs['skip-period']);
  document.getElementById('skip-period').value =
    SKIP_CHOICES.includes(skip) ? skip : '10';
};

/* the comparison error is set only when the user tries to save, and any edit
   clears it so the page never scolds a value while it is being typed */
const clearComparisonError = () => {
  extendedHeightInput.setCustomValidity('');
  extendedHeightInput.setAttribute('aria-invalid', 'false');
};

form.addEventListener('input', () => {
  // an edit invalidates the report of the previous save
  status.textContent = '';
  clearComparisonError();
});

form.addEventListener('submit', async e => {
  e.preventDefault();

  if (form.checkValidity() === false) {
    form.reportValidity();
    return;
  }

  const height = Number(heightInput.value);
  const extendedHeight = Number(extendedHeightInput.value);
  if (extendedHeight < height) {
    extendedHeightInput.setCustomValidity('The extended player height cannot be less than the player height.');
    extendedHeightInput.setAttribute('aria-invalid', 'true');
    form.reportValidity();
    return;
  }

  const extendedView = document.getElementById('open-player-extended').checked;
  const remember = REMEMBER_CHOICES.find(n =>
    document.getElementById(rememberId(n)).checked) ?? 30;
  const skip = document.getElementById('skip-period').value;

  try {
    await chrome.storage.local.set({
      height,
      'extended-height': extendedHeight,
      'extended-view': extendedView,
      'remember-tracks': remember,
      // a plain number is seconds; a fraction scales with the track length
      'skip-period': skip.includes('/') ? skip : Number(skip)
    });
    status.textContent = 'Preferences saved.';
  }
  catch (e) {
    status.textContent = 'The preferences could not be saved.';
    console.warn('CANNOT_SAVE_PREFERENCES', e);
  }
});

read().catch(e => console.warn('CANNOT_READ_PREFERENCES', e));
