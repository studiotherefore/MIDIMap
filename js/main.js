import { StreetViewEngine } from './streetview.js';
import { buildActions } from './actions.js';
import { InputRouter, RESERVED_KEYS } from './input.js';
import { UI } from './ui.js';
import { loadLocations, saveLocationOverride, resetLocations, SLOTS } from './locations.js';

const KEY_STORAGE = 'midimap.apiKey';

let locations = loadLocations();
const getLocations = () => locations;

const engine = new StreetViewEngine(document.getElementById('pano'), {
  onChange: () => ui?.renderHud(),
});
const router = new InputRouter(buildActions(engine, getLocations), {
  onChange: () => ui?.renderPanel(),
  onMessage: (m) => ui.toast(m),
  onActivity: (s, a, v) => ui.activity(s, a, v),
});
const ui = new UI({
  engine,
  router,
  getLocations,
  onApiKey: (key) => {
    storeKey(key);
    location.reload();
  },
  onResetLocations: (imported) => {
    locations = resetLocations();
    if (imported) for (const [slot, loc] of Object.entries(imported)) {
      locations[slot] = loc;
      saveLocationOverride(slot, loc);
    }
    ui.renderPanel();
  },
});

// ---- keyboard --------------------------------------------------------------

const isTyping = (e) => e.target.closest?.('input, textarea, select');

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;

  if (e.code === 'Escape') {
    if (router.learning) router.cancelLearn();
    else ui.togglePanel(false);
    return;
  }
  if (!router.learning && RESERVED_KEYS.has(e.code)) {
    if (e.repeat) return;
    if (e.code === 'Backquote') ui.togglePanel();
    if (e.code === 'KeyH') ui.toggleHud();
    if (e.code === 'KeyF') toggleFullscreen();
    return;
  }
  if (router.learning && RESERVED_KEYS.has(e.code)) {
    ui.toast('That key is reserved (` panel, H HUD, F fullscreen, Esc cancel).');
    return;
  }

  // Shift + number stores the current view into that slot.
  const digit = e.code.match(/^Digit(\d)$/)?.[1];
  if (e.shiftKey && digit && SLOTS.includes(digit) && !router.learning) {
    e.preventDefault();
    const snap = engine.snapshot();
    if (!snap) return ui.toast('Street View is not loaded yet');
    locations[digit] = snap;
    saveLocationOverride(digit, snap);
    ui.toast(`Stored current view in slot ${digit}`);
    ui.renderPanel();
    return;
  }

  router.handleKey(e, true);
});

window.addEventListener('keyup', (e) => {
  if (isTyping(e)) return;
  router.handleKey(e, false);
});

// Avoid stuck "held" keys when the window loses focus mid-gesture.
window.addEventListener('blur', () => router.releaseAll());

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// ---- Google Maps -------------------------------------------------------------

function readKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

function storeKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

function loadMaps(key) {
  return new Promise((resolve, reject) => {
    window.__midimapMapsReady = resolve;
    // Google calls this global when the key is rejected (bad key, API not enabled, referrer blocked).
    window.gm_authFailure = () => reject(new Error('Google rejected the API key'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__midimapMapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not reach Google Maps'));
    document.head.append(s);
  });
}

// Google reports the precise reason for a failure only in the developer console.
// Catch those messages and put a plain-language explanation on screen instead.
const MAPS_ERRORS = {
  ApiNotActivatedMapError: 'The Maps JavaScript API is not enabled for this key\'s project. In Google Cloud Console: APIs & Services → Library → Maps JavaScript API → Enable.',
  BillingNotEnabledMapError: 'Billing is not enabled on this Google Cloud project. Google requires a billing account even within the free allowance: Cloud Console → Billing → link a billing account.',
  RefererNotAllowedMapError: `This key is not allowed on this address. Add ${location.origin}/* under the key's Website restrictions (changes can take a few minutes).`,
  InvalidKeyMapError: 'Google does not recognise this key. Check it was copied completely, with no spaces.',
  ExpiredKeyMapError: 'This key has expired or been deleted. Create a new one in Cloud Console → Credentials.',
  ApiTargetBlockedMapError: 'This key\'s API restrictions do not include the Maps JavaScript API. Tick it under the key\'s API restrictions.',
  DeletedApiProjectMapError: 'The Google Cloud project for this key has been deleted.',
  MissingKeyMapError: 'No key reached Google. Paste the key again and save.',
};

// ---- startup checklist -------------------------------------------------------
// Every step of starting up is shown on screen, so a failure is never silent.

const STEPS = [
  ['page', 'Page scripts loaded'],
  ['key', 'API key found'],
  ['maps', 'Google Maps library loaded'],
  ['sv', 'Street View viewer created'],
  ['pano', 'Imagery loaded — key accepted'],
];
const stepState = {};
let checklistFailed = false;

function renderChecklist() {
  const ul = document.getElementById('checklist-items');
  ul.replaceChildren(...STEPS.map(([id, text]) => {
    const s = stepState[id] || { state: 'wait' };
    const li = document.createElement('li');
    li.className = s.state;
    li.innerHTML = '<span class="mark"></span><span></span>';
    li.lastChild.textContent = s.detail ? `${text} — ${s.detail}` : text;
    return li;
  }));
}

function step(id, state, detail) {
  if (checklistFailed && state !== 'fail') return;
  stepState[id] = { state, detail };
  renderChecklist();
}

function fail(id, help) {
  step(id, 'fail');
  checklistFailed = true;
  engine.status = help.split('. ')[0];
  engine.onChange(engine);
  document.getElementById('checklist').classList.remove('done');
  document.getElementById('checklist-help').textContent = help;
  document.getElementById('checklist-buttons').hidden = false;
  document.getElementById('api-key-message').textContent = help;
  if (activeKey) showKeyState('fail');
}

function checklistDone() {
  setTimeout(() => document.getElementById('checklist').classList.add('done'), 4000);
}

let activeKey = '';
function showKeyState(state) {
  ui.setKeyState(activeKey, state, () => {
    storeKey('');
    location.href = location.pathname; // also drops any ?key= from the address
  });
}

document.getElementById('checklist-key').addEventListener('click', () => {
  const msg = document.getElementById('api-key-message').textContent;
  ui.showKeyPrompt(msg);
});
document.getElementById('checklist-retry').addEventListener('click', () => location.reload());

function reportMapsError(code) {
  const text = MAPS_ERRORS[code] || `Google Maps error ${code}. See developers.google.com/maps/documentation/javascript/error-messages`;
  fail(stepState.sv?.state === 'ok' ? 'pano' : 'maps', `Google refused the key (${code}). ${text}`);
}

const consoleError = console.error.bind(console);
console.error = (...args) => {
  consoleError(...args);
  const m = String(args[0] ?? '').match(/Google Maps JavaScript API error: (\w+)/);
  if (m) reportMapsError(m[1]);
};

// Any unexpected script error also lands on screen.
let booted = false;
window.addEventListener('error', (e) => {
  if (!booted && !checklistFailed && e.message !== 'Script error.') fail(currentStep(), `Script error: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!booted && !checklistFailed) fail(currentStep(), `Script error: ${e.reason?.message || e.reason}`);
});

function currentStep() {
  return STEPS.find(([id]) => stepState[id]?.state !== 'ok')?.[0] || 'pano';
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

async function boot() {
  ui.renderHud();
  router.startMidi();
  step('page', 'ok');

  const key = readKey();
  if (!key) {
    showKeyState('none');
    fail('key', 'No API key saved in this browser yet. Click "Change API key" and paste your Google Maps key.');
    ui.showKeyPrompt('Paste a Google Maps JavaScript API key to begin.');
    return;
  }
  step('key', 'ok', `ending …${key.slice(-4)}`);
  activeKey = key;
  showKeyState('checking');

  step('maps', 'busy');
  // Google calls gm_authFailure when it rejects the key; the specific reason arrives via console.error.
  window.gm_authFailure = () => {
    setTimeout(() => {
      if (!checklistFailed) {
        fail(currentStep(), 'Google refused the key. Check the Maps JavaScript API is enabled for the key\'s project, and that the key\'s website restriction includes ' +
          `${location.origin}/*`);
      }
    }, 300);
  };
  try {
    await withTimeout(loadMaps(key), 15000,
      'No response from Google Maps after 15 seconds. An ad blocker or privacy extension may be blocking maps.googleapis.com. Try disabling it for this page.');
    step('maps', 'ok');
  } catch (err) {
    return fail('maps', err.message);
  }

  try {
    await engine.init();
    step('sv', 'ok');
  } catch (err) {
    return fail('sv', `Could not create the Street View viewer: ${err.message}`);
  }

  step('pano', 'busy', locations['1']?.name);
  const result = await engine.goto(locations['1']);
  if (checklistFailed) return;
  if (result === 'OK') {
    step('pano', 'ok', locations['1']?.name);
    showKeyState('ok');
    booted = true;
    checklistDone();
  } else {
    fail('pano', `Street View did not return imagery (${result}). If this says REQUEST_DENIED, the key is being refused: check its API restrictions include the Maps JavaScript API.`);
  }
}

document.getElementById('checklist-help').textContent = '';
renderChecklist();
boot();
