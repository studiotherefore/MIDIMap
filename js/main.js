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

function reportMapsError(code) {
  const text = MAPS_ERRORS[code] || `Google Maps error: ${code}. See developers.google.com/maps/documentation/javascript/error-messages`;
  engine.status = `Google Maps: ${code}`;
  ui.showKeyPrompt(text);
}

const consoleError = console.error.bind(console);
console.error = (...args) => {
  consoleError(...args);
  const m = String(args[0] ?? '').match(/Google Maps JavaScript API error: (\w+)/);
  if (m) reportMapsError(m[1]);
};

async function boot() {
  ui.renderHud();
  router.startMidi();

  const key = readKey();
  if (!key) {
    engine.status = 'No Google Maps API key';
    ui.showKeyPrompt('Paste a Google Maps JavaScript API key to begin.');
    return;
  }
  try {
    await loadMaps(key);
    // gm_authFailure can fire after load; the specific reason arrives via console.error above.
    window.gm_authFailure = () => {
      if (!engine.status.startsWith('Google Maps:')) {
        engine.status = 'Google rejected the API key';
        ui.showKeyPrompt('Google rejected this key. Check that the Maps JavaScript API is enabled, billing is on, and the key allows this address.');
      }
    };
    await engine.init();
    engine.goto(locations['1']);
  } catch (err) {
    engine.status = err.message;
    ui.showKeyPrompt(err.message);
  }
}

boot();
