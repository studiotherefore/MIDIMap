// Experiment 3: effects. Experiment 2's two-layer blend (copied, so experiment 2
// stays as it was) plus an effects chain on the real pixels (fx.js, Drift's look
// vocabulary), "hold the sun" (finds the brightest spot in each photo's sky and
// keeps the camera on it), MIDI learn for every effect, and video recording of
// the picture alone.

/* global maplibregl */
import { readToken, makeGraph, TILES, imagesNearFromTiles, bearing, distance, Run } from '../lib/mapillary.js';
import { PanoBlend, BLEND_MODES } from '../blend/renderer.js';
import { FxChain, PARAMS, PRESETS, neutralLook } from './fx.js';
import { PresetSync } from '../lib/presets-sync.js';
import { Kick, KICKS } from './kick.js';
import { DEFAULT_LOCATIONS } from '../../js/locations.js';

const $ = (s) => document.querySelector(s);
// ?output: a clean picture that mirrors the control window (projector window, or
// the MIDIMap app's off-screen Syphon output). No panel, no HUD, no MIDI of its own.
const OUTPUT = new URLSearchParams(location.search).has('output');
if (OUTPUT) document.body.classList.add('output');
const MAX_B_METRES = 40;   // don't show another run's photo if it's further than this from layer A
const START_SLOT = 5;      // Karl-Marx-Allee: ten 360° runs, winter 2021 to spring 2026
// Mapillary's image server is slow and uneven (1–50 s per photo, measured), so
// buffer well ahead and default to the smaller photos.
const AHEAD = 30;

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').className = error ? 'note error' : 'note';
}

const token = await readToken();
if (!token) {
  status('No Mapillary token found (config.local.json locally, MAPILLARY_TOKEN on Cloudflare).', true);
  throw new Error('no token');
}
const graph = makeGraph(token);
const renderer = new PanoBlend($('#view'));
const fx = new FxChain(renderer.gl);
const look = neutralLook();
const kick = new Kick();

// ---- state ----------------------------------------------------------------------

const S = {
  runA: null, runB: null, bMode: 'delay', delay: 8,
  index: 0, playing: false, dir: 1, fps: 3,
  mode: 1, mix: 0.5, smooth: 0, sharp: false,
  tempo: false, bpm: 120, stepsPerBeat: 1,
  pitch: 0, fov: 90, follow: true, yawOffset: 0, glance: 0, travel: 0,
  sun: false, sunSpot: null, lockYaw: 0, lockPitch: 0,
};
let shown = { a: null, b: null };  // photo ids currently on each layer
let lastStep = 0;
let stalledSince = 0;
window.blend = { S, renderer, fx, look, kick }; // for inspecting from the console

// ---- photos -----------------------------------------------------------------------

const images = new Map(); // url -> { ready, img }

function photo(url) {
  let e = images.get(url);
  if (!e) {
    e = { ready: false, img: null };
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { e.ready = true; e.img = img; };
    img.onerror = () => images.delete(url);
    img.src = url;
    images.set(url, e);
    if (images.size > 200) images.delete(images.keys().next().value);
  }
  return e;
}

// Which photo each layer should show for layer-A frame i.
function framesFor(i) {
  const A = S.runA;
  const a = { run: A, index: i };
  let b = null;
  if (S.bMode === 'delay') {
    b = { run: A, index: Math.min(A.length - 1, Math.max(0, i - S.delay * S.dir)) };
  } else if (S.bMode === 'run' && S.runB) {
    const at = A.at(i);
    if (at) {
      const near = S.runB.nearestIndex(at);
      if (near.index >= 0 && near.metres <= MAX_B_METRES) b = { run: S.runB, index: near.index, metres: near.metres };
    }
  }
  return { a, b };
}

const detail = (f) => f && f.run.at(f.index);
const urlOf = (d) => (S.sharp ? d.url2048 : d.url1024);
const ready = (f) => !f || (detail(f) && photo(urlOf(detail(f))).ready);

function show(name, f) {
  if (!f) {
    if (name === 'b' && shown.b) { renderer.clearLayer('b'); shown.b = null; }
    return;
  }
  const id = f.run.ids[f.index];
  const d = f.run.at(f.index);
  if (!d || shown[name] === id) return;
  const p = photo(urlOf(d));
  if (!p.ready) return;
  renderer.setImage(name, p.img, d.compass);
  shown[name] = id;
  if (name === 'a') S.sunSpot = findSun(p.img, d.compass);
}

// ---- hold the sun -----------------------------------------------------------------
// Finds the brightest compact spot in the upper half of a panorama (possible
// because Mapillary's pixels are readable) and returns its direction.

const sunCanvas = Object.assign(document.createElement('canvas'), { width: 256, height: 128 });
const sunCtx = sunCanvas.getContext('2d', { willReadFrequently: true });

function findSun(img, compass) {
  sunCtx.drawImage(img, 0, 0, 256, 128);
  const { data } = sunCtx.getImageData(0, 0, 256, 64);
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, lum(i));
  if (max < 230) return null; // no clear sun (overcast, night)
  let cx = 0; let sy = 0; let ys = 0; let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (lum(i) < max - 6) continue;
    const px = (i / 4) % 256;
    const py = Math.floor(i / 4 / 256);
    const ang = ((px + 0.5) / 256) * 2 * Math.PI; // average round the wrap
    cx += Math.cos(ang);
    sy += Math.sin(ang);
    ys += py + 0.5;
    n++;
  }
  if (n > 256 * 64 * 0.04) return null; // a big bright area is sky or cloud, not a sun
  const u = (Math.atan2(sy, cx) / (2 * Math.PI) + 1) % 1;
  const v = ys / n / 128;
  return { yaw: (compass + (u - 0.5) * 360 + 360) % 360, pitch: (0.5 - v) * 180 };
}

function prefetch(i) {
  const A = S.runA;
  A.ensure(i - 20, i + AHEAD + 30).catch((err) => status(err.message, true));
  for (let k = 0; k < AHEAD; k++) {
    const j = i + k * S.dir;
    if (j < 0 || j >= A.length) break;
    const { a, b } = framesFor(j);
    if (detail(a)) photo(urlOf(detail(a)));
    if (detail(b)) photo(urlOf(detail(b)));
  }
}

// Direction the run is travelling at frame i (keeps the last one while stationary).
function travelHeading(i) {
  const A = S.runA;
  const here = A.at(i);
  const next = A.at(i + 1) || here;
  const prev = A.at(i - 1) || here;
  if (!here) return S.travel;
  if (next !== here && distance(here, next) > 0.5) return bearing(here, next);
  if (prev !== here && distance(prev, here) > 0.5) return bearing(prev, here);
  return S.travel;
}

// ---- frame loop ---------------------------------------------------------------------

let lastFrame = performance.now();

// One step along the run, if the next photos (both layers) are ready.
function advance(now) {
  const next = (S.index + S.dir + S.runA.length) % S.runA.length;
  const f = framesFor(next);
  if (ready(f.a) && ready(f.b)) {
    S.index = next;
    lastStep = now;
    stalledSince = 0;
    prefetch(next);
  } else if (!stalledSince) {
    stalledSince = now;
    prefetch(next);
  }
}

// ---- tempo ----------------------------------------------------------------------------
// Internal clock: beats at S.bpm from clock.origin; photos change S.stepsPerBeat
// times per beat when S.tempo is on. Built so an external MIDI clock (24 pulses
// per beat) can later set bpm and origin instead.

const clock = { origin: performance.now(), lastStep: -1, taps: [] };
const STEPS_PER_BEAT = [0.25, 0.5, 1, 2, 4];
const beatMs = () => 60000 / S.bpm;
const stepMs = () => beatMs() / S.stepsPerBeat;
const stepDuration = () => (S.tempo ? stepMs() : 1000 / S.fps);
const followingNote = () => { status('The tempo follows the external MIDI clock. C switches back to the internal clock.'); sync(); };

// Change the tempo without jumping the beat: keep the current position within the beat.
function setBpm(bpm) {
  if (external()) return followingNote();
  const now = performance.now();
  const phase = ((now - clock.origin) / beatMs()) % 1;
  S.bpm = Math.max(20, Math.min(300, Math.round(bpm * 10) / 10));
  clock.origin = now - phase * beatMs();
  clock.lastStep = Math.floor((now - clock.origin) / stepMs());
  sync();
}

function setStepsPerBeat(spb) {
  S.stepsPerBeat = spb;
  clock.lastStep = Math.floor((performance.now() - clock.origin) / stepMs());
  sync();
}

// Tap tempo: average the last few taps; the latest tap becomes the downbeat.
function tap() {
  if (external()) return followingNote();
  const now = performance.now();
  const taps = clock.taps;
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    S.bpm = Math.max(20, Math.min(300, Math.round(60000 / avg)));
    S.tempo = true;
  }
  clock.origin = now;
  clock.lastStep = 0;
  sync();
}

function toggleTempo() {
  S.tempo = !S.tempo;
  clock.lastStep = Math.floor((performance.now() - clock.origin) / stepMs());
  sync();
}

// ---- external MIDI clock ----------------------------------------------------------------
// Follows a drum machine, DAW or sequencer sending MIDI clock: 24 pulses (0xF8)
// per beat. The BPM comes from the pulse spacing (averaged over two beats) and
// every 24th pulse is a beat. Locked to the tempo, photo steps land on pulses
// (every 24 / steps-per-beat), so they follow tempo changes at once. Start (0xFA)
// goes to beat 1 and plays, Continue (0xFB) plays on from the song position
// (0xF2), Stop (0xFC) pauses. If the pulses stop, the internal clock carries on
// at the last tempo. Clock source is kept in this browser (it's the rig, not a look).

const CLOCK_KEY = 'midimap.fx.clock.v1';
const PULSES = 24;
const LOST_MS = 500; // no pulse for this long: the clock has gone (at 20 BPM a pulse comes every 125 ms)
Object.assign(clock, { source: 'internal', pulses: 0, times: [], lastPulse: 0, input: null, inputName: '', lost: false, running: true });
try {
  if (localStorage.getItem(CLOCK_KEY) === 'external') clock.source = 'external';
} catch {
  /* internal */
}

// True while pulses are arriving and the external clock is chosen.
const external = (now = performance.now()) => clock.source === 'external' && clock.lastPulse > 0 && now - clock.lastPulse < LOST_MS;

// Back to the internal clock, carrying on from the last beat at the last tempo.
function dropExternal(now) {
  clock.lastPulse = 0;
  clock.times.length = 0;
  clock.pulses = 0;
  clock.input = null;
  clock.lastStep = Math.floor((now - clock.origin) / stepMs());
  sync();
}

function setClockSource(source) {
  const now = performance.now();
  if (clock.source === 'external') dropExternal(now);
  clock.source = source;
  clock.lost = false;
  if (source === 'external') S.tempo = true;
  try {
    localStorage.setItem(CLOCK_KEY, source);
  } catch {
    /* this session only */
  }
  sync();
}

// System real-time and song position messages. t: when the message arrived; src: { id, name } of the input.
function onClock([st, a, b], t, src) {
  if (clock.source !== 'external') return;
  const mine = !external(t) || src.id === clock.input; // one clock at a time: the first input that pulses
  if (!mine) return;
  if (st === 0xf8) {
    const arrived = !external(t);
    if (arrived) {
      // A device that never sends Start/Stop counts as running.
      Object.assign(clock, { input: src.id, inputName: src.name, lost: false, running: true });
      clock.times.length = 0;
    }
    clock.lastPulse = t;
    if (arrived) sync();
    const times = clock.times;
    times.push(t);
    if (times.length > 2 * PULSES + 1) times.shift();
    if (times.length >= 7) {
      const bpm = 60000 / (((t - times[0]) / (times.length - 1)) * PULSES);
      // Only show a change of 0.2 BPM or more, so USB timing jitter doesn't make the number flicker.
      if (Math.abs(bpm - S.bpm) >= 0.2) {
        S.bpm = Math.max(20, Math.min(300, Math.round(bpm * 10) / 10));
        sync();
      }
    }
    // Stopped devices usually keep pulsing; the song position only moves while running.
    if (!clock.running) return;
    if (clock.pulses % PULSES === 0) clock.origin = t;
    if (S.playing && S.tempo && clock.pulses % (PULSES / S.stepsPerBeat) === 0) advance(t);
    clock.pulses++;
  } else if (st === 0xfa) {
    clock.pulses = 0; // the next pulse is beat 1
    clock.running = true;
    S.playing = true;
    sync();
  } else if (st === 0xfb) {
    clock.running = true;
    S.playing = true;
    sync();
  } else if (st === 0xfc) {
    clock.running = false;
    clock.lastStep = Math.floor((t - clock.origin) / stepMs());
    S.playing = false;
    sync();
  } else if (st === 0xf2) {
    clock.pulses = ((b << 7) | a) * 6; // song position counts sixteenth notes
  }
}

// When the next beat falls after time t: from the pulses while an external clock
// runs (so beat 1 after Start is right), otherwise from the internal grid.
function beatAfter(t) {
  const bm = beatMs();
  let b;
  if (external() && clock.running) {
    const next = Math.ceil(clock.pulses / PULSES) * PULSES; // pulse number of the next beat
    b = clock.lastPulse + (next - clock.pulses + 1) * (bm / PULSES);
  } else {
    b = clock.origin + Math.ceil((t - clock.origin) / bm) * bm;
  }
  while (b <= t) b += bm;
  return b;
}

// ---- reference kick ---------------------------------------------------------------------
// A kick on every beat while playing, to hear the photo changes against (kick.js).
// K: off → 808 → 909 → off. Volume and offset are kept in this browser; only the
// control window sounds (outputs stay silent). A worker keeps time, since a page's
// own timers slow to once a second when its window is hidden.

const KICK_KEY = 'midimap.fx.kick.v1';
try {
  const saved = JSON.parse(localStorage.getItem(KICK_KEY)) || {};
  if (typeof saved.volume === 'number') kick.volume = saved.volume;
  if (typeof saved.offset === 'number') kick.offset = saved.offset;
} catch {
  /* defaults */
}
const saveKick = () => {
  try {
    localStorage.setItem(KICK_KEY, JSON.stringify({ volume: kick.volume, offset: kick.offset }));
  } catch {
    /* this session only */
  }
};

function setKick(type) {
  kick.type = type;
  if (type !== 'off') {
    kick.start();
    kick.reset();
    if (!S.tempo) toggleTempo();
  }
  sync();
}

if (!OUTPUT) {
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 25)'], { type: 'text/javascript' })));
  ticker.onmessage = () => {
    if (S.playing) kick.schedule(beatAfter, beatMs());
    else kick.reset();
  };
}

function tick(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (clock.source === 'external' && clock.lastPulse && now - clock.lastPulse >= LOST_MS) {
    clock.lost = true;
    dropExternal(now);
  }
  if (S.runA && S.runA.length) {
    if (S.playing && S.tempo) {
      // Locked to the tempo: step exactly on the grid. A step whose photos
      // aren't loaded yet is skipped, never delayed, so it stays on the beat.
      // (With an external clock running, the pulses step instead: see onClock.
      // Space while the device is stopped plays on this grid at the device's tempo.)
      const k = Math.floor((now - clock.origin) / stepMs());
      if (!(external(now) && clock.running) && k !== clock.lastStep) {
        clock.lastStep = k;
        advance(now);
      }
    } else if (S.playing && now - lastStep >= 1000 / S.fps) {
      advance(now);
    }
    const f = framesFor(S.index);
    show('a', f.a);
    show('b', f.b);

    // Face the direction of travel, turning smoothly rather than snapping each frame.
    const target = S.follow ? travelHeading(S.index) : 0;
    const diff = ((target - S.travel + 540) % 360) - 180;
    S.travel = (S.travel + diff * (1 - Math.exp(-dt * 3)) + 360) % 360;
  }
  let yaw = S.travel + S.yawOffset + S.glance;
  let pitch = S.pitch;
  if (S.sun && S.sunSpot) {
    // Ease toward the sun so the frame holds it without jerking when it's re-found.
    const k = 1 - Math.exp(-dt * 4);
    S.lockYaw = (S.lockYaw + ((((S.sunSpot.yaw - S.lockYaw + 540) % 360) - 180) * k) + 360) % 360;
    S.lockPitch += (S.sunSpot.pitch - S.lockPitch) * k;
    yaw = S.lockYaw + S.glance;
    pitch = S.lockPitch;
  } else {
    S.lockYaw = yaw;
    S.lockPitch = pitch;
  }
  const [w, h] = renderer.fitCanvas();
  fx.resize(w, h);
  renderer.render({ yaw, pitch, fov: S.fov }, { mode: S.mode, mix: S.mix }, S.smooth * stepDuration(), fx.sceneTarget);
  fx.render(look, now);
  hud(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

let hudAt = 0;
const spbLabel = (spb) => ({ 0.25: '1 step per 4 beats', 0.5: '1 step per 2 beats', 1: '1 step per beat', 2: '2 steps per beat', 4: '4 steps per beat' })[spb];

// The beat light flashes for the first tenth of each beat (checked every frame).
function beatLight(now) {
  const on = ((now - clock.origin) % beatMs() + beatMs()) % beatMs() < Math.min(120, beatMs() * 0.3);
  $('#beat-light').classList.toggle('on', on);
  $('#hud-beat').classList.toggle('on', on && S.tempo);
}

function hud(now) {
  beatLight(now);
  if (now - hudAt < 150) return;
  hudAt = now;
  const A = S.runA;
  const a = A && A.at(S.index);
  $('#hud-a').textContent = a ? `A ${day(a.captured_at)} · frame ${S.index + 1}/${A.length}` : '';
  let b = 'B off';
  if (S.bMode === 'delay') b = `B same run, ${S.delay} frames behind`;
  if (S.bMode === 'run') {
    const f = A && framesFor(S.index).b;
    const d = f && detail(f);
    b = d ? `B ${day(d.captured_at)} · ${Math.round(f.metres)} m away` : 'B other run: no photo within 40 m here';
  }
  $('#hud-b').textContent = b;
  $('#hud-buffer').textContent = A ? `buffered ${buffered()} frames ahead` : '';
  const ext = external(now);
  const kickLabel = kick.type === 'off' ? '' : ` · ${kick.type} kick`;
  $('#hud-tempo').textContent = S.tempo ? `♩ ${S.bpm}${ext ? ' MIDI clock' : ''} · ${spbLabel(S.stepsPerBeat)}${kickLabel}` : '';
  $('#clock-status').textContent = clockStatus(ext);
  $('#clock-status').classList.toggle('error', clock.source === 'external' && !ext);
  $('#hud-wait').textContent = stalledSince && now - stalledSince > 400 ? 'waiting for photos…' : '';
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function clockStatus(ext) {
  if (clock.source === 'internal') return 'Internal clock. C follows an external MIDI clock instead.';
  if (ext) return `Following MIDI clock from ${clock.inputName}: ${S.bpm} BPM${S.playing ? '' : ', stopped (Start on the device plays)'}.`;
  if (clock.lost) return `MIDI clock stopped arriving: carrying on with the internal clock at ${S.bpm} BPM until it's back.`;
  return 'Waiting for MIDI clock: start your drum machine, DAW or sequencer (set to send clock to this Mac). Until then the internal clock runs.';
}

// How many upcoming frames (both layers) are already downloaded.
function buffered() {
  let n = 0;
  for (let k = 1; k <= AHEAD; k++) {
    const j = S.index + k * S.dir;
    if (j < 0 || j >= S.runA.length) break;
    const f = framesFor(j);
    if (!(ready(f.a) && ready(f.b))) break;
    n++;
  }
  return n;
}

// ---- choosing runs -------------------------------------------------------------------

async function startRun(sequenceId, imageId) {
  status('Loading run…');
  try {
    const run = await new Run(graph, sequenceId).load();
    const index = Math.max(0, run.ids.indexOf(imageId));
    await run.ensure(index - 20, index + 60);
    S.runA = run;
    S.index = index;
    shown = { a: null, b: null };
    renderer.clearLayer('a');
    renderer.clearLayer('b');
    S.travel = travelHeading(index);
    if (S.bMode === 'run') setBMode('delay');
    S.runB = null;
    const a = run.at(index);
    $('#a-info').textContent = `Run from ${day(a.captured_at)}, ${run.length} photos. Starting at photo ${index + 1}.`;
    status('');
    listOtherRuns();
    prefetch(index);
  } catch (err) {
    status(`Could not load that run: ${err.message}`, true);
  }
}

async function useRunB(sequenceId, li) {
  status('Loading the other run…');
  try {
    const run = await new Run(graph, sequenceId).load();
    await run.ensure(0, run.length);
    S.runB = run;
    shown.b = null;
    for (const el of document.querySelectorAll('#runs li')) el.classList.toggle('on', el === li);
    setBMode('run');
    status('');
  } catch (err) {
    status(`Could not load that run: ${err.message}`, true);
  }
}

// Other 360° runs passing within 20 m of layer A's current photo.
function listOtherRuns() {
  const a = S.runA && S.runA.at(S.index);
  if (!a) return;
  const near = imagesNearFromTiles(map, a, 20, (p) => p.is_pano && p.sequence_id !== S.runA.id);
  const runs = new Map();
  for (const img of near) if (!runs.has(img.sequence)) runs.set(img.sequence, img);
  const list = [...runs.values()].sort((x, y) => x.captured_at - y.captured_at);
  $('#runs').replaceChildren(...(list.length ? list.map((img) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${day(img.captured_at)}</span><span class="dim">${Math.round(img.metres)} m</span>`;
    li.addEventListener('click', () => useRunB(img.sequence, li));
    return li;
  }) : [Object.assign(document.createElement('li'), { textContent: 'none within 20 m of here' })]));
}

// ---- map --------------------------------------------------------------------------

const start = DEFAULT_LOCATIONS[START_SLOT];
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.85, 'raster-brightness-max': 0.5 } }],
  },
  center: [start.lng, start.lat],
  zoom: 16,
  attributionControl: { compact: true },
});
new ResizeObserver(() => map.resize()).observe($('#map'));
window.blend.map = map;
const mapIdle = () => new Promise((r) => (map.loaded() && map.areTilesLoaded() ? r() : map.once('idle', r)));

map.on('load', () => {
  map.addSource('mly', { type: 'vector', tiles: [`${TILES}?access_token=${encodeURIComponent(token)}`], minzoom: 0, maxzoom: 14 });
  map.addLayer({ id: 'pano-runs', type: 'line', source: 'mly', 'source-layer': 'sequence', filter: ['==', ['get', 'is_pano'], true],
    paint: { 'line-color': '#35d07f', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 17, 3] } });
  if (!OUTPUT) goSlot(START_SLOT);
});

const here = Object.assign(document.createElement('div'), { style: 'width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:14px solid #ff5a36' });
const marker = new maplibregl.Marker({ element: here, rotationAlignment: 'map' });
let listedAt = null;
let followedId = null;
setInterval(() => {
  const a = S.runA && S.runA.at(S.index);
  if (!a) return;
  marker.setLngLat(a).setRotation(S.travel + S.yawOffset + S.glance).addTo(map);
  // Follow the playing photo only when it changes, so the map can be panned
  // freely and a jump elsewhere isn't pulled back to the current run.
  const id = S.runA.ids[S.index];
  if (id !== followedId) {
    followedId = id;
    if (!map.getBounds().contains(a)) map.easeTo({ center: a });
  }
  if (!listedAt || distance(listedAt, a) > 40) {
    listedAt = a;
    listOtherRuns();
  }
}, 400);

// moved: the map was just moved, so wait for the new area's coverage before searching.
async function openNear(lngLat, metres, label, moved = false) {
  if (moved) await new Promise((r) => map.once('idle', r));
  else await mapIdle();
  const near = imagesNearFromTiles(map, lngLat, metres, (p) => p.is_pano);
  // Prefer a proper run (20+ photos loaded in the map tiles) over a lone 360° photo, which can't play.
  const counts = new Map();
  for (const f of map.querySourceFeatures('mly', { sourceLayer: 'image', filter: ['==', ['get', 'is_pano'], true] })) {
    counts.set(f.properties.sequence_id, (counts.get(f.properties.sequence_id) || 0) + 1);
  }
  const img = near.find((i) => (counts.get(i.sequence) || 0) >= 20) || near[0];
  if (!img) return status(`No 360° photo within ${metres} m of ${label || 'that spot'}. Try a green line on the map.`);
  listedAt = null;
  await startRun(img.sequence, img.id);
}

map.on('click', (e) => (map.getZoom() < 14 ? map.easeTo({ center: e.lngLat, zoom: 16 }) : openNear(e.lngLat, 30)));

// ---- place slots -------------------------------------------------------------------------
// Eight slots (one bank; more banks can come later). A slot is a 360° place:
// a search point { name, lat, lng } that finds the nearest run, or an exact
// photo { name, lat, lng, sequence, image } stored from what's playing.
// Kept in this browser and saved with presets.

const SLOT_COUNT = 8;
const SLOTS_KEY = 'midimap.fx.slots.v1';
const DEFAULT_SLOTS = [
  { name: 'Times Square, New York', lat: 40.7580, lng: -73.9855 },
  { name: 'Shibuya Crossing, Tokyo', lat: 35.6595, lng: 139.7005 },
  { name: 'Piazza San Marco, Venice', lat: 45.4341, lng: 12.3388 },
  { name: 'Badwater Road, Death Valley', lat: 36.2306, lng: -116.7723, sequence: 'tUm84JCwc2vklEQZ169yrz', image: '1674249717356348' },
  { name: 'Karl-Marx-Allee, Berlin', lat: 52.5178, lng: 13.4350 },
  { name: 'Champs-Élysées, Paris', lat: 48.8698, lng: 2.3078 },
  { name: 'Damrak, Amsterdam', lat: 52.3760, lng: 4.8970 },
  { name: 'Esplanadi, Helsinki', lat: 60.1675, lng: 24.9480 },
];
let slots = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SLOTS_KEY));
    if (Array.isArray(saved) && saved.length === SLOT_COUNT) return saved;
  } catch {
    /* defaults */
  }
  return DEFAULT_SLOTS.map((x) => ({ ...x }));
})();
let currentSlot = null;

function saveSlots() {
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
  } catch {
    /* this session only */
  }
  renderSlots();
}

function goSlot(n) {
  const slot = slots[n - 1];
  if (!slot) return;
  currentSlot = n;
  renderSlots();
  map.jumpTo({ center: [slot.lng, slot.lat], zoom: 16 });
  status(`Going to ${slot.name}…`);
  if (slot.sequence) startRun(slot.sequence, slot.image);
  else openNear(slot, 400, slot.name, true);
}

// A short name for a stored place: the nearest known place within 3 km, else coordinates.
function placeName(at) {
  const known = [...DEFAULT_SLOTS, ...Object.values(DEFAULT_LOCATIONS), ...slots];
  const near = known.map((k) => ({ k, m: distance(at, k) })).sort((x, y) => x.m - y.m)[0];
  const base = near && near.m < 3000 ? near.k.name.split(' · ')[0] : `${at.lat.toFixed(3)}, ${at.lng.toFixed(3)}`;
  return `${base} · ${day(at.captured_at)}`;
}

function storeSlot(n) {
  const a = S.runA && S.runA.at(S.index);
  if (!a) return status('Nothing playing to store yet.');
  slots[n - 1] = { name: placeName(a), lat: a.lat, lng: a.lng, sequence: S.runA.id, image: S.runA.ids[S.index] };
  currentSlot = n;
  saveSlots();
  status(`Stored this photo in slot ${n}. Press ${n} to come back to it.`);
}

function renderSlots() {
  $('#slots').replaceChildren(...slots.map((slot, i) => {
    const n = i + 1;
    const li = document.createElement('li');
    li.className = n === currentSlot ? 'on' : '';
    li.innerHTML = `<b>${n}</b><span class="name" contenteditable="true" spellcheck="false" title="Click to rename"></span>` +
      `<button class="go" title="Key ${n}">go</button><button class="store" title="Option+${n}">store here</button>`;
    const name = li.querySelector('.name');
    name.textContent = slot.name + (slot.sequence ? '' : ' (nearest run)');
    name.addEventListener('focus', () => { name.textContent = slot.name; });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.textContent = slot.name; name.blur(); }
    });
    name.addEventListener('blur', () => {
      const v = name.textContent.trim();
      if (v && v !== slot.name) { slot.name = v; saveSlots(); } else renderSlots();
    });
    li.querySelector('.go').addEventListener('click', () => goSlot(n));
    li.querySelector('.store').addEventListener('click', () => storeSlot(n));
    return li;
  }));
}
renderSlots();

function setSlots(list) {
  if (!Array.isArray(list) || list.length !== SLOT_COUNT) return;
  slots = list.map((x) => ({ ...x }));
  saveSlots();
}

// ---- controls ------------------------------------------------------------------------

$('#modes').replaceChildren(...BLEND_MODES.map((name, i) => {
  const b = document.createElement('button');
  b.textContent = `${i + 1} ${name}`;
  b.addEventListener('click', () => { S.mode = i; sync(); });
  return b;
}));

function setBMode(mode) {
  S.bMode = mode;
  shown.b = null;
  if (mode !== 'run') for (const el of document.querySelectorAll('#runs li')) el.classList.remove('on');
  sync();
}

// Reflect the state in the controls (after MIDI or keyboard changes).
function sync() {
  $('#tempo').checked = S.tempo;
  if (document.activeElement !== $('#bpm')) $('#bpm').value = S.bpm;
  $('#spb').value = String(S.stepsPerBeat);
  $('#clock-source').value = clock.source;
  $('#kick-type').value = kick.type;
  $('#bpm').disabled = $('#tap').disabled = external();
  $('#fps').disabled = S.tempo;
  $('#mix').value = S.mix;
  $('#smooth').value = S.smooth;
  $('#delay').value = S.delay;
  $('#delay-val').textContent = S.delay;
  $('#fps').value = S.fps;
  $('#fps-val').textContent = S.fps;
  $('#fov').value = S.fov;
  $('#follow').checked = S.follow;
  $('#play').textContent = S.playing ? 'Pause' : 'Play';
  $('#reverse').textContent = `Direction: ${S.dir > 0 ? 'forward' : 'backward'}`;
  for (const r of document.querySelectorAll('input[name=bmode]')) r.checked = r.value === S.bMode;
  [...$('#modes').children].forEach((b, i) => b.classList.toggle('on', i === S.mode));
}
sync();

$('#mix').addEventListener('input', (e) => { S.mix = +e.target.value; });
$('#smooth').addEventListener('input', (e) => { S.smooth = +e.target.value; });
$('#delay').addEventListener('input', (e) => { S.delay = +e.target.value; shown.b = null; sync(); });
$('#fps').addEventListener('input', (e) => { S.fps = +e.target.value; sync(); });
$('#fov').addEventListener('input', (e) => { S.fov = +e.target.value; });
$('#sharp').addEventListener('change', (e) => { S.sharp = e.target.checked; shown = { a: null, b: null }; if (S.runA) prefetch(S.index); });
$('#follow').addEventListener('change', (e) => {
  S.follow = e.target.checked;
  S.yawOffset = S.follow ? 0 : S.travel + S.yawOffset;
  if (!S.follow) S.travel = 0;
});
for (const r of document.querySelectorAll('input[name=bmode]')) {
  r.addEventListener('change', () => {
    if (r.value === 'run' && !S.runB) {
      status('Pick one of the runs in the list first.');
      sync();
      return;
    }
    setBMode(r.value);
  });
}

// Playing starts on the next step of the tempo grid, not with an off-beat step straight away.
const togglePlay = () => {
  S.playing = !S.playing;
  lastStep = 0;
  clock.lastStep = Math.floor((performance.now() - clock.origin) / stepMs());
  sync();
};
const step = (d) => { if (S.runA) { S.index = (S.index + d + S.runA.length) % S.runA.length; prefetch(S.index); } };
$('#play').addEventListener('click', togglePlay);
$('#reverse').addEventListener('click', () => { S.dir = -S.dir; shown.b = null; sync(); });
$('#sky').addEventListener('click', () => { S.pitch = 90; });
$('#horizon').addEventListener('click', () => { S.pitch = 0; });

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, [contenteditable]')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
  else if (e.code === 'ArrowUp') { e.preventDefault(); S.pitch = 90; }
  else if (e.code === 'ArrowDown') { e.preventDefault(); S.pitch = 0; }
  else if (e.code === 'KeyR') { S.dir = -S.dir; shown.b = null; sync(); }
  else if (e.code === 'KeyH') $('#panel').hidden = !$('#panel').hidden;
  else if (e.code === 'KeyF') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
  else if (e.code === 'KeyS') toggleSun();
  else if (e.code === 'KeyV') toggleRecord();
  else if (e.code === 'Escape') cancelLearn();
  else if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) applyPreset(Object.keys(allPresets())[+e.code.slice(5) - 1]);
  else if (e.altKey && /^Digit[1-8]$/.test(e.code)) { e.preventDefault(); storeSlot(+e.code.slice(5)); }
  else if (/^Digit[1-8]$/.test(e.code)) goSlot(+e.code.slice(5));
  else if (e.code === 'KeyT') tap();
  else if (e.code === 'KeyB') toggleTempo();
  else if (e.code === 'KeyC') setClockSource(clock.source === 'external' ? 'internal' : 'external');
  else if (e.code === 'KeyK') setKick(KICKS[(KICKS.indexOf(kick.type) + 1) % KICKS.length]);
  else if (e.code === 'Minus' || e.code === 'Equal') setBpm(S.bpm + (e.code === 'Equal' ? 1 : -1) * (e.shiftKey ? 5 : 1));
  else if (e.code === 'Comma' || e.code === 'Period') {
    const i = STEPS_PER_BEAT.indexOf(S.stepsPerBeat) + (e.code === 'Period' ? 1 : -1);
    setStepsPerBeat(STEPS_PER_BEAT[Math.max(0, Math.min(STEPS_PER_BEAT.length - 1, i))]);
  }
  else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    S.mode = (S.mode + (e.code === 'BracketRight' ? 1 : -1) + BLEND_MODES.length) % BLEND_MODES.length;
    sync();
  }
});

// Drag to look around; the wheel zooms.
let drag = null;
$('#view').addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; $('#view').setPointerCapture(e.pointerId); });
$('#view').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const k = S.fov / innerHeight;
  S.yawOffset -= (e.clientX - drag.x) * k;
  S.pitch = Math.max(-90, Math.min(90, S.pitch + (e.clientY - drag.y) * k));
  drag = { x: e.clientX, y: e.clientY };
});
$('#view').addEventListener('pointerup', () => { drag = null; });
$('#view').addEventListener('wheel', (e) => { e.preventDefault(); S.fov = Math.max(30, Math.min(130, S.fov + e.deltaY * 0.05)); sync(); }, { passive: false });

// ---- MIDI (fixed mapping for the Arturia MiniLab 3) -------------------------------------

function onMidi([st, a, b], t = performance.now(), src = { id: '', name: 'MIDI' }) {
  if (st >= 0xf0) return onClock([st, a, b], t, src);
  const type = st & 0xf0;
  if (type === 0xb0 && fxMidi(`${(st & 0x0f) + 1}:${a}`, b)) return;
  if (type === 0xb0) {
    const v = b / 127;
    if (a === 1) S.pitch = v * 90;                               // mod strip: horizon → sky
    else if (a === 74) S.mix = v;                                // knob 1
    else if (a === 71) { S.delay = Math.round(v * 40); shown.b = null; } // knob 2
    else if (a === 76) S.smooth = v;                             // knob 3
    else if (a === 77) {                                         // knob 4: speed, or BPM when locked to tempo
      if (S.tempo) setBpm(40 + v * 160);
      else S.fps = Math.max(0.5, Math.round(v * 24) / 2);
    }
    else if (a === 114) S.yawOffset += (b - 64) * 3;             // main knob (endless): turn
    else if (a === 82) S.fov = 30 + v * 100;                     // fader 1
    else return;
    sync();
  } else if (type === 0xe0) {
    S.glance = (((b << 7) | a) / 16383 - 0.5) * 180;             // pitch strip: glance ±90°, springs back
  } else if (type === 0xc0) {
    if (a < SLOT_COUNT) goSlot(a + 1);                           // pads 1–8 (program changes): place slots
  } else if (type === 0x90 && b > 0 && !S.playing) {
    step(S.dir);                                                 // keys: step a frame
  }
}

if (OUTPUT) {
  // The control window handles MIDI; the output only mirrors it.
} else if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then((access) => {
    const attach = () => {
      const names = [];
      for (const input of access.inputs.values()) {
        if (input.state === 'disconnected') continue;
        input.onmidimessage = (m) => onMidi(m.data, m.timeStamp || performance.now(), input);
        names.push(input.name);
      }
      $('#midi-status').textContent = names.length ? `MIDI: ${names.join(', ')}` : 'MIDI: no controller connected (keyboard and mouse still work)';
    };
    access.onstatechange = attach;
    attach();
  }).catch(() => { $('#midi-status').textContent = 'MIDI: permission not given (keyboard and mouse still work)'; });
} else {
  $('#midi-status').textContent = 'MIDI: not available in this browser (use Chrome)';
}

// ---- effects panel, presets and MIDI learn ------------------------------------------------

const rows = new Map(); // param id -> { row, input, val, bound }
const extras = new Map(); // learnable controls outside the look (kick): id -> { row, input, val, bound, p, get, set }
const LEARN_KEY = 'midimap.fx.learn.v1';
// Guessed defaults: Arturia's factory numbers for knobs 5–8 and faders 2–4. Learn overrides them.
let fxBindings = { '1:93': 'echo', '1:18': 'bloom', '1:19': 'recall', '1:16': 'tint', '1:83': 'blur', '1:85': 'smear', '1:17': 'grain' };
try {
  fxBindings = JSON.parse(localStorage.getItem(LEARN_KEY)) || fxBindings;
} catch {
  /* keep defaults */
}
let learning = null;
const fmt = (p, v) => (p.step >= 1 ? String(Math.round(v)) : v.toFixed(2));

function buildEffects() {
  const box = $('#fx-params');
  let group = null;
  for (const p of PARAMS) {
    if (p.group !== group) {
      group = p.group;
      box.append(Object.assign(document.createElement('div'), { className: 'fx-group', textContent: group }));
    }
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.innerHTML = `<div class="name"><span>${p.label}</span><span class="bound"></span></div>` +
      `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}"><span class="val"></span><button>learn</button>`;
    const input = row.querySelector('input');
    input.value = look[p.id];
    input.addEventListener('input', () => setParam(p.id, +input.value));
    input.addEventListener('dblclick', () => setParam(p.id, p.neutral));
    row.querySelector('button').addEventListener('click', () => startLearn(p.id));
    box.append(row);
    rows.set(p.id, { row, input, val: row.querySelector('.val'), bound: row.querySelector('.bound'), p });
  }
  const kickRow = (id, label, p, get, set, unit = '') => {
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.innerHTML = `<div class="name"><span>${label}</span><span class="bound"></span></div>` +
      `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}"><span class="val"></span><button>learn</button>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => { set(+input.value); refreshEffects(); });
    input.addEventListener('dblclick', () => { set(p.neutral); refreshEffects(); });
    row.querySelector('button').addEventListener('click', () => startLearn(id));
    $('#kick-params').append(row);
    extras.set(id, { row, input, val: row.querySelector('.val'), bound: row.querySelector('.bound'), p: { ...p, unit }, get, set });
  };
  kickRow('kick.volume', 'kick volume', { min: 0, max: 1, step: 0.01, neutral: 0.5 }, () => kick.volume, (v) => { kick.setVolume(v); saveKick(); });
  kickRow('kick.offset', 'kick offset (+ = later)', { min: -250, max: 250, step: 5, neutral: 0 }, () => kick.offset, (v) => { kick.offset = v; saveKick(); }, ' ms');
  renderPresets();
  $('#tint-colour').addEventListener('input', (e) => {
    const hex = e.target.value;
    [look.tint_r, look.tint_g, look.tint_b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  });
  refreshEffects();
}

function setParam(id, v) {
  look[id] = v;
  refreshEffects();
}

function refreshEffects() {
  const byParam = {};
  for (const [key, id] of Object.entries(fxBindings)) (byParam[id] ||= []).push(key);
  for (const [id, r] of rows) {
    r.input.value = look[id];
    r.val.textContent = fmt(r.p, look[id]);
    r.row.classList.toggle('changed', look[id] !== r.p.neutral);
    r.row.classList.toggle('learning', learning === id);
    r.bound.textContent = learning === id ? 'move a control…' : (byParam[id] || []).map((k) => `CC ${k.split(':')[1]}`).join(', ');
  }
  for (const [id, r] of extras) {
    r.input.value = r.get();
    r.val.textContent = fmt(r.p, r.get()) + r.p.unit;
    r.row.classList.toggle('changed', r.get() !== r.p.neutral);
    r.row.classList.toggle('learning', learning === id);
    r.bound.textContent = learning === id ? 'move a control…' : (byParam[id] || []).map((k) => `CC ${k.split(':')[1]}`).join(', ');
  }
  const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  $('#tint-colour').value = `#${hex(look.tint_r)}${hex(look.tint_g)}${hex(look.tint_b)}`;
}

let currentPreset = null;

function applyPreset(name) {
  const preset = allPresets()[name];
  if (!preset) return;
  const { scene, slots: presetSlots, ...values } = preset;
  Object.assign(look, neutralLook(), values);
  if (presetSlots) setSlots(presetSlots);
  if (scene) applyScene(scene);
  currentPreset = name;
  renderPresets();
  refreshEffects();
}

// A scene preset also sets blend, camera and playback, and goes to its photo
// (and to its second run, if layer B was another run).
async function applyScene({ settings = {}, photo, runB }) {
  for (const [k, v] of Object.entries(settings)) S[k] = v;
  if (settings.sun !== undefined) $('#sun').textContent = `Hold the sun: ${S.sun ? 'on' : 'off'}`;
  shown.b = null;
  sync();
  if (photo && S.runA?.ids[S.index] !== photo.image) await startRun(photo.sequence, photo.image);
  if (runB && settings.bMode === 'run' && S.runB?.id !== runB) await useRunB(runB, null);
}

// ---- saved presets (synced through Cloudflare) ---------------------------------------------
// `remote` is the shared list (Cloudflare D1, cached in this browser for when
// offline). `local` holds presets saved where there's no sync key yet; they're
// uploaded as soon as there is one. Export/Import still move presets as a file.

const REMOTE_CACHE = 'midimap.fx.presets.remote.v1';
const LOCAL_ONLY = 'midimap.fx.presets.v1';
const SCENE_KEYS = ['mode', 'mix', 'bMode', 'delay', 'smooth', 'fps', 'dir', 'fov', 'pitch', 'sun', 'follow', 'sharp', 'tempo', 'bpm', 'stepsPerBeat'];
const presetSync = new PresetSync();
const readStore = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const writeStore = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
let remote = readStore(REMOTE_CACHE);
let local = readStore(LOCAL_ONLY);
let offline = false;

const userPresets = () => ({ ...remote, ...local });
const allPresets = () => ({ ...PRESETS, ...userPresets() });

async function refreshPresets() {
  try {
    remote = (await presetSync.list()).presets;
    writeStore(REMOTE_CACHE, remote);
    offline = false;
    if (presetSync.canWrite && Object.keys(local).length) await uploadLocal();
  } catch {
    offline = true; // keep showing the last synced list
  }
  renderPresets();
  renderSync();
}

async function uploadLocal() {
  const names = Object.keys(local);
  for (const n of names) {
    await presetSync.save(n, local[n]);
    remote[n] = local[n];
    delete local[n];
  }
  writeStore(LOCAL_ONLY, local);
  writeStore(REMOTE_CACHE, remote);
  status(`Uploaded ${names.length} preset${names.length === 1 ? '' : 's'} saved in this browser, so they're shared now.`);
}

async function storePreset(name, preset) {
  if (presetSync.canWrite) {
    await presetSync.save(name, preset);
    remote[name] = preset;
    delete local[name];
    writeStore(REMOTE_CACHE, remote);
    writeStore(LOCAL_ONLY, local);
    return 'shared';
  }
  local[name] = preset;
  writeStore(LOCAL_ONLY, local);
  return 'this browser only';
}

async function deletePreset(name) {
  if (name in local) {
    delete local[name];
    writeStore(LOCAL_ONLY, local);
  } else {
    if (!presetSync.canWrite) throw new Error('Deleting a shared preset needs the sync key in this browser.');
    await presetSync.remove(name);
    delete remote[name];
    writeStore(REMOTE_CACHE, remote);
  }
}

function renderPresets() {
  const mine = userPresets();
  $('#presets').replaceChildren(...Object.keys(allPresets()).map((name, i) => {
    const b = document.createElement('button');
    b.className = name === currentPreset ? 'on' : '';
    b.textContent = `${i + 1} ${name}`;
    b.title = (i < 9 ? `Shift+${i + 1}` : '') + (name in local ? ' · saved in this browser only' : '');
    if (name in local) b.classList.add('local');
    b.addEventListener('click', () => applyPreset(name));
    if (name in mine) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Delete this preset';
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete the preset "${name}"?`)) return;
        try {
          await deletePreset(name);
          if (currentPreset === name) currentPreset = null;
          renderPresets();
          renderSync();
          status(`Deleted "${name}".`);
        } catch (err) {
          status(err.message, true);
        }
      });
      b.append(x);
    }
    return b;
  }));
}

function renderSync() {
  const shared = Object.keys(remote).length;
  let text;
  if (presetSync.canWrite) text = `Presets sync: on. ${shared} shared preset${shared === 1 ? '' : 's'}; saving here updates everywhere.`;
  else text = `Presets sync: read-only in this browser (${shared} shared). Paste the sync key to save and delete here.`;
  if (offline) text = 'Presets sync: offline, showing the last synced list. Saving works again once connected.';
  if (Object.keys(local).length) text += ` ${Object.keys(local).length} saved in this browser only (dashed).`;
  $('#sync-status').textContent = text;
  $('#copy-key').hidden = presetSync.keySource !== 'file';
  $('#key-form').hidden = presetSync.canWrite;
  $('#forget-key').hidden = presetSync.keySource !== 'browser';
}

// Everything needed to come back to this moment: effects, blend/camera/playback, photo.
function captureScene() {
  const preset = Object.fromEntries(Object.keys(neutralLook()).map((k) => [k, look[k]]));
  preset.scene = { settings: Object.fromEntries(SCENE_KEYS.map((k) => [k, S[k]])) };
  if (S.runA) preset.scene.photo = { sequence: S.runA.id, image: S.runA.ids[S.index] };
  if (S.bMode === 'run' && S.runB) preset.scene.runB = S.runB.id;
  preset.slots = slots.map((x) => ({ ...x }));
  return preset;
}

function openSaveForm() {
  $('#save-form').hidden = false;
  $('#save-preset').hidden = true;
  const n = Object.keys(userPresets()).length + 1;
  $('#preset-name').value = currentPreset && currentPreset in userPresets() ? currentPreset : `preset ${n}`;
  $('#preset-name').select();
  $('#preset-name').focus();
}

function closeSaveForm() {
  $('#save-form').hidden = true;
  $('#save-preset').hidden = false;
}

async function savePreset() {
  const name = $('#preset-name').value.trim();
  if (!name) return;
  if (name in PRESETS) {
    status(`"${name}" is a built-in preset; choose another name.`, true);
    return;
  }
  const existed = name in userPresets();
  try {
    const where = await storePreset(name, captureScene());
    currentPreset = name;
    closeSaveForm();
    renderPresets();
    renderSync();
    status(`${existed ? 'Updated' : 'Saved'} preset "${name}" (${where}).`);
  } catch (err) {
    status(`Could not save: ${err.message}`, true);
  }
}

$('#save-preset').addEventListener('click', openSaveForm);
$('#save-confirm').addEventListener('click', savePreset);
$('#save-cancel').addEventListener('click', closeSaveForm);
$('#preset-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') savePreset();
  if (e.key === 'Escape') closeSaveForm();
});

$('#export-presets').addEventListener('click', () => {
  const mine = userPresets();
  if (!Object.keys(mine).length) return status('No saved presets to export yet.');
  const blob = new Blob([JSON.stringify(mine, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'midimap-presets.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$('#import-presets').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    const names = Object.keys(incoming).filter((n) => !(n in PRESETS) && incoming[n] && typeof incoming[n] === 'object');
    for (const n of names) await storePreset(n, incoming[n]);
    renderPresets();
    renderSync();
    status(`Imported ${names.length} preset${names.length === 1 ? '' : 's'}.`);
  } catch (err) {
    status(`Could not import that file: ${err.message}`, true);
  }
});

// The sync key: copy it on this Mac, paste it once in each other browser.
$('#copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(presetSync.key);
    status('Sync key copied. In another browser, paste it into the sync key box under Effects.');
  } catch {
    status('Could not copy to the clipboard.', true);
  }
});
async function useKey() {
  try {
    await presetSync.useKey($('#sync-key').value);
    $('#sync-key').value = '';
    status('Sync key accepted: saving here now updates everywhere.');
    await refreshPresets();
  } catch (err) {
    status(err.wrongKey ? 'That sync key is wrong.' : `Could not check the key: ${err.message}`, true);
  }
}
$('#use-key').addEventListener('click', useKey);
$('#sync-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') useKey(); });
$('#forget-key').addEventListener('click', () => {
  presetSync.forgetKey();
  renderSync();
  status('This browser no longer has the sync key (presets stay shared; it just can’t change them).');
});

// Presets saved elsewhere show up within 30 s, or straight away on returning to this window.
if (!OUTPUT) {
  presetSync.init().then(refreshPresets);
  setInterval(refreshPresets, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPresets(); });
}

function startLearn(id) {
  learning = learning === id ? null : id;
  refreshEffects();
}

function cancelLearn() {
  learning = null;
  refreshEffects();
}

// Returns true if an effect took this controller message.
function fxMidi(key, value) {
  if (learning) {
    for (const k of Object.keys(fxBindings)) if (fxBindings[k] === learning) delete fxBindings[k];
    fxBindings[key] = learning;
    learning = null;
    try {
      localStorage.setItem(LEARN_KEY, JSON.stringify(fxBindings));
    } catch {
      /* this session only */
    }
    refreshEffects();
    return true;
  }
  const id = fxBindings[key];
  if (!id) return false;
  const x = extras.get(id);
  if (x) {
    x.set(x.p.min + Math.round(((value / 127) * (x.p.max - x.p.min)) / x.p.step) * x.p.step);
    refreshEffects();
    return true;
  }
  if (!rows.has(id)) return false;
  const p = rows.get(id).p;
  setParam(id, p.step >= 1 && p.max === 1 ? Math.round(value / 127) : p.min + (value / 127) * (p.max - p.min));
  return true;
}

buildEffects();

// ---- hold the sun ------------------------------------------------------------------------

function toggleSun() {
  S.sun = !S.sun;
  if (!S.sun) {
    // Stay looking where the sun was, then carry on from there.
    S.yawOffset = S.lockYaw - S.travel;
    S.pitch = S.lockPitch;
  }
  $('#sun').textContent = `Hold the sun: ${S.sun ? 'on' : 'off'}`;
  if (S.sun && !S.sunSpot) status('No clear sun in this photo (overcast, shade or night). It locks on when one appears.');
}
$('#sun').addEventListener('click', toggleSun);

// ---- recording ---------------------------------------------------------------------------
// The canvas alone, straight to a video file: no panel, no cursor, no screen-capture UI.

let recorder = null;
let recordStart = 0;

function toggleRecord() {
  if (recorder) {
    recorder.stop();
    return;
  }
  // The picture plus the kick (a silent track while the kick is off).
  const types = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1.640033,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  const stream = $('#view').captureStream(60);
  for (const track of kick.start().stream.getAudioTracks()) stream.addTrack(track);
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 24e6 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mimeType });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `midimap-fx-${stamp}.${ext}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    recorder = null;
    $('#record').textContent = '● Record video';
    $('#hud-rec').textContent = '';
    status(`Saved ${Math.round(blob.size / 1e6)} MB video to your Downloads folder.`);
  };
  recorder.start(1000);
  recordStart = performance.now();
  $('#record').textContent = '■ Stop recording';
}
$('#record').addEventListener('click', toggleRecord);
setInterval(() => {
  if (!recorder) return;
  const s = Math.floor((performance.now() - recordStart) / 1000);
  $('#hud-rec').textContent = `● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 250);

// ---- mirroring to an output window ---------------------------------------------------------
// The control window broadcasts its state 20 times a second; an ?output window
// (same site, any tab or window, or the MIDIMap app's Syphon output) follows it.
// Each loads its own photos, so the output never waits on the control window's screen.

const MIRROR_KEYS = ['bMode', 'delay', 'dir', 'fps', 'mode', 'mix', 'smooth', 'sharp', 'pitch', 'fov', 'follow', 'yawOffset', 'glance', 'sun', 'tempo', 'bpm', 'stepsPerBeat'];
const channel = new BroadcastChannel('midimap-fx');

if (OUTPUT) {
  let loadingA = null;
  let loadingB = null;
  channel.onmessage = async ({ data }) => {
    for (const k of MIRROR_KEYS) S[k] = data.S[k];
    Object.assign(look, data.look);
    if (data.runA && data.runA !== S.runA?.id && data.runA !== loadingA) {
      loadingA = data.runA;
      await startRun(data.runA, data.imageA);
      loadingA = null;
    }
    if (data.runB && data.runB !== S.runB?.id && data.runB !== loadingB) {
      loadingB = data.runB;
      await useRunB(data.runB, null);
      loadingB = null;
    }
    if (S.runA && S.runA.id === data.runA && S.index !== data.index) {
      S.index = data.index;
      prefetch(S.index);
    }
  };
} else {
  setInterval(() => channel.postMessage({
    S: Object.fromEntries(MIRROR_KEYS.map((k) => [k, S[k]])),
    look: { ...look },
    runA: S.runA?.id || null,
    imageA: S.runA?.ids[S.index] || null,
    runB: S.bMode === 'run' ? S.runB?.id || null : null,
    index: S.index,
  }), 50);
  // A clean projector window in an ordinary browser (the MIDIMap app has its own output).
  if (!navigator.userAgent.includes('Electron')) {
    $('#output-window').hidden = false;
    $('#output-window').addEventListener('click', () => window.open('./?output', 'midimap-output', 'width=960,height=540'));
  }
}

// ---- tempo controls -----------------------------------------------------------------------
$('#spb').replaceChildren(...STEPS_PER_BEAT.map((v) => Object.assign(document.createElement('option'), { value: String(v), textContent: spbLabel(v) })));
$('#tempo').addEventListener('change', toggleTempo);
$('#bpm').addEventListener('change', (e) => setBpm(+e.target.value || S.bpm));
$('#tap').addEventListener('click', tap);
$('#spb').addEventListener('change', (e) => setStepsPerBeat(+e.target.value));
$('#clock-source').addEventListener('change', (e) => { setClockSource(e.target.value); e.target.blur(); });
$('#kick-type').addEventListener('change', (e) => { setKick(e.target.value); e.target.blur(); });
window.blend.clock = clock;
window.blend.onMidi = onMidi; // lets a page feed in a fake clock for testing
sync();
