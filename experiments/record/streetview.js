// Google Street View as layer A (EDITOR-PLAN.md, phase 6), built on the
// instrument's engine (js/streetview.js) so its lessons carry over: car imagery
// first (contributed photos get rate-limited and go black), keyboardShortcuts
// off, a wrapper around the viewer (Google overwrites its container's style),
// hops at most every 0.9 s.
//
// The editor drives it: steps on the tempo grid (or at the speed), turning,
// looking up, field of view. Google's pixels can't be read, so effects here are
// CSS filters and overlays (Drift's approach): brightness, contrast,
// saturation, hue, invert, blur, posterize, tint, grain, and the live fade.
// Google is loaded only when Street View is first used (each panorama is billed).

import { StreetViewEngine } from '../../js/streetview.js';

const MAPS_ERRORS = {
  ApiNotActivatedMapError: 'the Maps JavaScript API is not enabled for this key\'s project (Google Cloud → APIs & Services → Library → Maps JavaScript API → Enable)',
  BillingNotEnabledMapError: 'billing is not enabled on this Google Cloud project',
  RefererNotAllowedMapError: `this key is not allowed on this address: add ${location.origin}/* under the key's website restrictions in Google Cloud → Credentials`,
  InvalidKeyMapError: 'Google does not recognise the key',
  ExpiredKeyMapError: 'the key has expired or been deleted',
  ApiTargetBlockedMapError: 'the key\'s API restrictions do not include the Maps JavaScript API',
};

let loading = null;
// onError: Google reports key problems after loading, and only in the console.
export function loadMaps(onError) {
  if (loading) return loading;
  const origError = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    const code = Object.keys(MAPS_ERRORS).find((k) => text.includes(k));
    if (code) onError(`Google Street View: ${MAPS_ERRORS[code]}.`);
    origError.apply(console, args);
  };
  window.gm_authFailure = () => setTimeout(() => onError(`Google refused the Maps key here. Check that its website restrictions include ${location.origin}/*.`), 300);
  loading = (async () => {
    if (window.google?.maps?.importLibrary) return;
    const res = await fetch('/config.local.json', { cache: 'no-store' }).catch(() => null);
    const key = res?.ok ? (await res.json()).mapsApiKey?.trim() : '';
    if (!key) throw new Error('No Google Maps key (config.local.json on this Mac, MAPS_API_KEY on Cloudflare).');
    await new Promise((resolve, reject) => {
      window.__midimapMapsReady = resolve;
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__midimapMapsReady`;
      s.async = true;
      s.onerror = () => reject(new Error('Could not reach Google Maps (offline, or blocked by an ad blocker).'));
      document.head.append(s);
      setTimeout(() => reject(new Error('No answer from Google Maps after 15 s (an ad blocker may be blocking maps.googleapis.com).')), 15000);
    });
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

const wrap360 = (a) => ((a % 360) + 360) % 360;
const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;
const MIN_HOP_MS = 900;

export class StreetViewLayer {
  // host: the monitor element; the layer covers it exactly.
  constructor(host, { onError = () => {}, onMove = () => {} } = {}) {
    // Google's own reason (e.g. a key not allowed on this address) beats a vague failure later.
    this.onError = (msg) => { this.keyError = msg; onError(msg); };
    this.onMove = onMove;
    this.stage = Object.assign(document.createElement('div'), { id: 'sv-stage', hidden: true });
    this.stage.innerHTML = '<div id="sv-pano"></div><div class="sv-tint"></div><canvas class="sv-grain" width="160" height="90"></canvas><div class="sv-fade"></div>' +
      '<svg width="0" height="0" style="position:absolute"><filter id="sv-posterize"><feComponentTransfer>' +
      '<feFuncR type="discrete"/><feFuncG type="discrete"/><feFuncB type="discrete"/></feComponentTransfer></filter></svg>';
    host.append(this.stage);
    this.panoEl = this.stage.querySelector('#sv-pano');
    this.tint = this.stage.querySelector('.sv-tint');
    this.grain = this.stage.querySelector('.sv-grain');
    this.fadeEl = this.stage.querySelector('.sv-fade');
    this.engine = null;
    this.glance = 0;
    this.lastHop = 0;
    this.lastPitch = null;
    this.zoom = 1;
    this.posterLevels = 0;
  }

  get ready() {
    return !!this.engine?.ready;
  }

  async start() {
    if (this.engine) return this.engine.ready ? undefined : this.starting;
    await loadMaps(this.onError);
    const engine = new StreetViewEngine(this.panoEl);
    engine.speed = 0; // the editor moves it, not the engine's own speed
    // Glance (the pitch strip) turns the view without moving the heading.
    engine._applyPov = (force) => {
      if (!engine.ready) return;
      const pov = { heading: wrap360(engine.heading + this.glance), pitch: engine.pitch };
      const last = engine._lastPov;
      if (force || !last || Math.abs(angleDiff(pov.heading, last.heading)) > 0.005 || Math.abs(pov.pitch - last.pitch) > 0.005) {
        engine._lastPov = pov;
        engine.pano.setPov(pov);
      }
    };
    this.engine = engine;
    this.starting = engine.init().then(() => {
      engine.pano.addListener('pano_changed', () => this.onMove(this.where()));
    });
    await this.starting;
  }

  show(on) {
    this.stage.hidden = !on;
  }

  // Where we are: for the map, places, projects and the output.
  where() {
    const e = this.engine;
    if (!e?.ready) return null;
    const pos = e.pano.getPosition();
    return {
      pano: e.pano.getPano(),
      lat: pos?.lat(),
      lng: pos?.lng(),
      heading: Math.round(e.heading),
      pitch: Math.round(e.targetPitch),
      description: e.pano.getLocation()?.description || '',
    };
  }

  // { lat, lng } (nearest Google car imagery, else contributed) or { pano, heading, pitch }.
  async goTo(place) {
    await this.start();
    const status = await this.engine.goto({ ...place, mode: 'drift' });
    if (status !== 'OK') throw new Error(this.keyError || this.engine.status || String(status));
    this.lastHop = performance.now();
    return this.where();
  }

  // One hop along the road (forward = the way we face). Skipped, never queued,
  // while the last hop is still loading or less than 0.9 s ago: the beat stays put.
  hop(dir) {
    const e = this.engine;
    if (!e?.ready || e._stepping || performance.now() - this.lastHop < MIN_HOP_MS) return false;
    this.lastHop = performance.now();
    e._step(dir);
    return true;
  }

  // Called every frame by the editor. Returns the pitch if the viewer was
  // dragged up or down (the editor then takes it), else null.
  drive({ dt, playing, motion, dir, degPerSec, turn, pitch, fov, glance }) {
    const e = this.engine;
    if (!e?.ready) return null;
    let dragged = null;
    if (turn) e.nudgeHeading(turn);
    if (playing && motion === 'drift') e.heading = wrap360(e.heading + dir * degPerSec * dt);
    // Pitch: the editor's value, unless the viewer was dragged (then the editor takes the viewer's).
    if (this.lastPitch !== null && Math.abs(e.targetPitch - this.lastPitch) > 0.01) dragged = e.targetPitch;
    else e.targetPitch = Math.max(-85, Math.min(85, pitch));
    this.lastPitch = e.targetPitch;
    this.glance = glance;
    const zoom = Math.max(0, Math.min(4, Math.log2(180 / fov)));
    if (Math.abs(zoom - this.zoom) > 0.01) { this.zoom = zoom; e.pano.setZoom?.(zoom); }
    return dragged;
  }

  // The output follows: show the editor's panorama and ease to its view.
  follow({ pano, heading, pitch }, dt) {
    const e = this.engine;
    if (!e?.ready) return;
    if (pano && e.pano.getPano() !== pano && !this.loadingPano) {
      this.loadingPano = pano;
      e._showPano(pano).finally(() => { this.loadingPano = null; });
    }
    const k = 1 - Math.exp(-dt * 12);
    e.heading = wrap360(e.heading + angleDiff(heading, e.heading) * k);
    e.targetPitch = pitch;
  }

  // Effects Google's picture can take: CSS filters and overlays.
  look(L, fade, now) {
    const f = [
      `brightness(${L.brightness})`, `contrast(${L.contrast})`, `saturate(${L.saturation})`,
      `hue-rotate(${L.hue}deg)`, `invert(${L.invert})`, `blur(${L.blur / 2}px)`,
    ];
    const levels = L.posterize > 0 ? Math.round(16 - L.posterize * 14) : 0;
    if (levels !== this.posterLevels) {
      this.posterLevels = levels;
      const table = levels ? Array.from({ length: levels }, (_, i) => (i / (levels - 1)).toFixed(3)).join(' ') : '';
      for (const fn of this.stage.querySelectorAll('feFuncR, feFuncG, feFuncB')) fn.setAttribute('tableValues', table);
    }
    if (levels) f.push('url(#sv-posterize)');
    this.panoEl.style.filter = f.join(' ');
    const hex = (x) => Math.round(x * 255);
    this.tint.style.background = `rgb(${hex(L.tint_r)}, ${hex(L.tint_g)}, ${hex(L.tint_b)})`;
    this.tint.style.opacity = L.tint;
    this.grain.style.opacity = L.grain * 0.6;
    if (L.grain > 0 && now - (this.grainAt || 0) > 60) {
      this.grainAt = now;
      const g = this.grain.getContext('2d');
      const img = g.createImageData(160, 90);
      for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      g.putImageData(img, 0, 0);
    }
    this.fadeEl.style.opacity = 1 - fade;
  }
}

// Effect ids that work on Street View (the rest grey out).
export const SV_EFFECTS = new Set(['brightness', 'contrast', 'saturation', 'hue', 'invert', 'blur', 'posterize', 'tint', 'grain']);
