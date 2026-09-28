import { StreetViewEngine } from './streetview.js';
import { buildActions } from './actions.js';
import { InputRouter, RESERVED_KEYS } from './input.js';
import { VirtualController, TOGGLE_KEY } from './virtual-midi.js';
import { UI } from './ui.js';
import { loadLocations, saveLocationOverride, resetLocations, SLOTS } from './locations.js';

const KEY_STORAGE = 'midimap.apiKey';
// Optional, never committed (*.local.json is git-ignored): {"mapsApiKey": "…"}
const KEY_FILE = 'config.local.json';

let locations = loadLocations();
const getLocations = () => locations;

const engine = new StreetViewEngine(document.getElementById('pano'), {
  onChange: () => ui?.renderHud(),
});
const router = new InputRouter(buildActions(engine, getLocations), {
  onChange: () => ui?.renderPanel(),
  onMessage: (m) => ui.toast(m),
  onActivity: (s, a, v, virtual) => ui.activity(s, a, v, virtual),
  onDevices: (names) => onDevices(names),
});

// ---- keyboard stand-in controller -------------------------------------------
// On by itself when no hardware controller is connected, off when one is.
// P flips it by hand; the next plug or unplug hands control back to the automatic rule.

const virtual = new VirtualController((data) => router.handleMidi(data, { virtual: true }));
virtual.setActive(true); // until MIDI reports a device
let hardware = null;     // null until the first device report

function onDevices(names) {
  const connected = names.length > 0;
  if (connected === hardware) return;
  const first = hardware === null;
  hardware = connected;
  virtual.setActive(!connected);
  if (connected) ui.toast(`${names.join(', ')} connected: keyboard controller off (P turns it back on)`);
  else if (!first) ui.toast('Controller disconnected: keyboard controller on');
  ui.renderPanel();
}

function toggleVirtual() {
  virtual.setActive(!virtual.active);
  ui.toast(`Keyboard controller ${virtual.active ? 'on' : 'off'}`);
  ui.renderPanel();
}

const ui = new UI({
  engine,
  router,
  virtual,
  onToggleVirtual: toggleVirtual,
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
    if (e.code === TOGGLE_KEY) toggleVirtual();
    return;
  }
  if (router.learning && RESERVED_KEYS.has(e.code)) {
    ui.toast('That key is reserved (` panel, H HUD, F fullscreen, P keyboard controller, Esc cancel).');
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

  if (virtual.handleKey(e, true)) return;
  router.handleKey(e, true);
});

window.addEventListener('keyup', (e) => {
  if (isTyping(e)) return;
  if (virtual.handleKey(e, false)) return;
  router.handleKey(e, false);
});

// Avoid stuck "held" keys when the window loses focus mid-gesture.
window.addEventListener('blur', () => {
  virtual.releaseAll();
  router.releaseAll();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// ---- Google Maps -------------------------------------------------------------

// Where the key comes from, in order: ?key= in the address, the local config
// file next to the page (local setups), then this browser's saved key.
async function readKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) return { key: fromUrl, source: 'url' };
  try {
    const res = await fetch(KEY_FILE, { cache: 'no-store' });
    const key = res.ok ? (await res.json()).mapsApiKey?.trim() : '';
    if (key) return { key, source: 'file' };
  } catch {
    /* no config file (e.g. on GitHub Pages) */
  }
  try {
    return { key: localStorage.getItem(KEY_STORAGE) || '', source: 'browser' };
  } catch {
    return { key: '', source: 'browser' };
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
let keySource = 'browser';
function showKeyState(state) {
  ui.setKeyState(activeKey, state, () => {
    storeKey('');
    location.href = location.pathname; // also drops any ?key= from the address
  }, keySource);
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

  const { key, source } = await readKey();
  if (!key) {
    showKeyState('none');
    fail('key', 'No API key saved in this browser yet. Click "Change API key" and paste your Google Maps key.');
    ui.showKeyPrompt('Paste a Google Maps JavaScript API key to begin.');
    return;
  }
  step('key', 'ok', `ending …${key.slice(-4)}${source === 'file' ? ` (from ${KEY_FILE})` : ''}`);
  activeKey = key;
  keySource = source;
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
