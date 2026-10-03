// MIDIMap editor (phase 1 of EDITOR-PLAN.md): experiment 3's engine (copied, so
// experiment 3 stays frozen) in the editor layout: map + layers + blend on the
// left, the output monitor in the middle, effects/camera/audio/output on the
// right, places as pads along the bottom, tempo in the top bar.

/* global maplibregl */
import { readToken, makeGraph, TILES, imagesNearFromTiles, bearing, distance, Run } from '../experiments/lib/mapillary.js';
import { PanoBlend, BLEND_MODES } from './renderer.js';
import { FxChain, PARAMS, PRESETS, neutralLook } from './fx.js';
import { PresetSync } from '../experiments/lib/presets-sync.js';
import { Kick, KICKS } from './kick.js';
import { ProjectStore, PROJECT_VERSION, migrate, fingerprint, download } from './project.js';
import { Profiles, parse, srcOf, describe, shortName, MINILAB, PROFILE_VERSION } from './midi.js';
import { DEFAULT_LOCATIONS } from '../js/locations.js';

const $ = (s) => document.querySelector(s);
// ?output: a clean picture that mirrors the control window (projector window, or
// the MIDIMap app's off-screen Syphon output). No panel, no HUD, no MIDI of its own.
const OUTPUT = new URLSearchParams(location.search).has('output');
const APP_OUTPUT = new URLSearchParams(location.search).has('app'); // the app's own output windows: no hints
if (OUTPUT) document.body.classList.add('output');
const MAX_B_METRES = 40;   // don't show another run's photo if it's further than this from layer A
const START_SLOT = 5;      // Karl-Marx-Allee: ten 360° runs, winter 2021 to spring 2026
// Mapillary's image server is slow and uneven (1–50 s per photo, measured), so
// buffer well ahead and default to the smaller photos.
const AHEAD = 30;

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').title = text;
  $('#status').className = error ? 'error' : '';
}

// On/off switches (span.sw): set the look; clicks and Space/Enter call `onToggle`.
const setSw = (sel, on) => $(sel).classList.toggle('on', !!on);
function onSwitch(sel, onToggle) {
  const el = $(sel);
  el.addEventListener('click', onToggle);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onToggle(); } // Space stays play/pause everywhere
  });
}
// Segmented buttons: mark the one whose data value matches.
const setSeg = (sel, attr, value) => {
  for (const b of $(sel).querySelectorAll(`[data-${attr}]`)) b.classList.toggle('on', b.dataset[attr] === String(value));
};

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
  live: true, // L: the output shows the picture (true) or fades to black (false)
};
let shown = { a: null, b: null };  // photo ids currently on each layer
let shownA = null;                 // layer A's photo and compass, for finding the sun on demand
let lastStep = 0;
let stalledSince = 0;
window.blend = { S, renderer, fx, look, kick };
Object.defineProperty(window.blend, 'fade', { get: () => fade }); // for tests and the console // for inspecting from the console

// ---- photos -----------------------------------------------------------------------

const images = new Map(); // url -> { ready, img }

function photo(url) {
  let e = images.get(url);
  if (!e) {
    e = { ready: false, img: null };
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // Decode in the background before it's used, so a new photo never stalls a frame.
    img.onload = () => img.decode().catch(() => {}).then(() => { e.ready = true; e.img = img; });
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
  if (name === 'a') {
    // Looking for the sun reads the photo's pixels, so it's done once per photo
    // and only while "hold the sun" is on (see tick).
    shownA = { img: p.img, compass: d.compass, checked: false };
    S.sunSpot = null;
  }
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
const FADE_S = 0.6;
let fade = 1;

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
  if (S.sun && shownA && !shownA.checked) {
    shownA.checked = true;
    S.sunSpot = findSun(shownA.img, shownA.compass);
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
  // Live fades the output to black and back (FADE_S). The editor's monitor keeps
  // showing the picture (dimmed and marked) so you can prepare the next thing,
  // except while recording: a recording is what the audience sees.
  fade = Math.max(0, Math.min(1, fade + (S.live ? dt : -dt) / FADE_S));
  fx.render(look, now, OUTPUT || recorder ? fade : 1);
  hud(now);
  if (!OUTPUT) postIfMoved();
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
  syncCamera();
  if (a) {
    const slot = slots[currentSlot - 1];
    $('#place-info').textContent = `${slot ? `Place ${currentSlot}: ${slot.name}. ` : ''}Photo ${A.ids[S.index]}, captured ${day(a.captured_at)}, at ${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}.`;
  }
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

// Each jump (a place, a project, a map click) takes a ticket; a jump overtaken
// by a newer one while it was loading gives up, so the last one asked for wins.
let nav = 0;

async function startRun(sequenceId, imageId, ticket = ++nav) {
  status('Loading run…');
  try {
    const run = await new Run(graph, sequenceId).load();
    const index = Math.max(0, run.ids.indexOf(imageId));
    await run.ensure(index - 20, index + 60);
    if (ticket !== nav) return;
    S.runA = run;
    S.index = index;
    shown = { a: null, b: null };
    renderer.clearLayer('a');
    renderer.clearLayer('b');
    S.travel = travelHeading(index);
    if (S.bMode === 'run') setBMode('delay');
    S.runB = null;
    const a = run.at(index);
    $('#a-info').textContent = `Run from ${day(a.captured_at)}, ${run.length} photos.`;
    $('#run-info').textContent = `Run from ${day(a.captured_at)}, ${run.length} photos, started at photo ${index + 1}. Mapillary sequence ${run.id}.`;
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
    // Brightness min > max turns the light OpenStreetMap tiles dark (Drift's dark map look).
    layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -1, 'raster-brightness-min': 0.62, 'raster-brightness-max': 0.02, 'raster-contrast': 0.15 } }],
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
  if (!OUTPUT) startingPlace();
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
  const ticket = ++nav;
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
  if (ticket !== nav) return;
  await startRun(img.sequence, img.id, ticket);
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
  markSlots();
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

// The places row: one pad per slot. Click = go; double-click the name to rename;
// the ⤓ button (or Option+number) stores the playing photo there.
function renderSlots() {
  $('#slots').replaceChildren(...slots.map((slot, i) => {
    const n = i + 1;
    const pad = document.createElement('div');
    pad.className = `slot${n === currentSlot ? ' on' : ''}`;
    pad.dataset.learn = `place.${n}`;
    pad.title = `Key ${n}`;
    pad.innerHTML = `<span class="n"><b>${n}</b><span class="name" spellcheck="false" title="Double-click to rename"></span></span>` +
      `<span class="src">${slot.sequence ? 'mapillary · exact photo' : 'mapillary · nearest run'}</span>` +
      `<button class="store" title="Store the playing photo here (Option+${n})">⤓</button>`;
    const name = pad.querySelector('.name');
    name.textContent = slot.name;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      name.contentEditable = 'true';
      name.focus();
      document.getSelection().selectAllChildren(name);
    });
    name.addEventListener('click', (e) => { if (name.isContentEditable) e.stopPropagation(); });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.textContent = slot.name; name.blur(); }
    });
    name.addEventListener('blur', () => {
      name.contentEditable = 'false';
      const v = name.textContent.trim();
      if (v && v !== slot.name) { slot.name = v; saveSlots(); } else renderSlots();
    });
    pad.addEventListener('click', () => goSlot(n));
    pad.querySelector('.store').addEventListener('click', (e) => { e.stopPropagation(); storeSlot(n); });
    return pad;
  }));
  markSlots();
  setTimeout(() => renderLearn(), 0); // after the first render, once the MIDI code has loaded
}

// Mark the playing place without rebuilding the pads (a rebuild would swallow a double-click).
function markSlots() {
  [...$('#slots').children].forEach((pad, i) => pad.classList.toggle('on', i + 1 === currentSlot));
  const now = slots[currentSlot - 1];
  $('#pads-now').textContent = now ? `${currentSlot} ${now.name}` : '';
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
  b.textContent = name;
  b.title = `${i + 1} ${name} ([ ])`;
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
  setSw('#tempo', S.tempo);
  if (document.activeElement !== $('#bpm')) $('#bpm').value = S.bpm;
  $('#spb').value = String(S.stepsPerBeat);
  $('#clock-source').value = clock.source;
  setSeg('#kick-type', 'kick', kick.type);
  $('#bpm').disabled = $('#tap').disabled = $('#bpm-down').disabled = $('#bpm-up').disabled = external();
  $('#speed').hidden = S.tempo;
  $('#speed-locked').hidden = !S.tempo;
  $('#mix').value = S.mix;
  $('#mix-val').textContent = S.mix.toFixed(2);
  $('#smooth').value = S.smooth;
  $('#smooth-val').textContent = S.smooth.toFixed(2);
  $('#delay').value = S.delay;
  $('#delay-val').textContent = S.delay;
  $('#fps').value = S.fps;
  $('#fps-val').textContent = S.fps;
  setSw('#follow', S.follow);
  setSw('#sun', S.sun);
  setSw('#sharp', S.sharp);
  $('#play').textContent = S.playing ? '❚❚ pause' : '▶ play';
  $('#play').classList.toggle('on', S.playing);
  setSeg('#direction', 'dir', S.dir);
  setSeg('#bmode', 'b', S.bMode);
  [...$('#modes').children].forEach((b, i) => b.classList.toggle('on', i === S.mode));
  syncCamera();
  if (!OUTPUT) renderLive();
}

// Camera values also change by dragging the picture, the wheel and MIDI, so
// the frame loop refreshes these too.
function syncCamera() {
  if (document.activeElement !== $('#fov')) $('#fov').value = S.fov;
  if (document.activeElement !== $('#pitch')) $('#pitch').value = S.pitch;
  $('#fov-val').textContent = `${Math.round(S.fov)}°`;
  $('#pitch-val').textContent = `${Math.round(S.pitch)}°`;
}
sync();

$('#mix').addEventListener('input', (e) => { S.mix = +e.target.value; sync(); });
$('#smooth').addEventListener('input', (e) => { S.smooth = +e.target.value; sync(); });
$('#delay').addEventListener('input', (e) => { S.delay = +e.target.value; shown.b = null; sync(); });
$('#fps').addEventListener('input', (e) => { S.fps = +e.target.value; sync(); });
$('#fov').addEventListener('input', (e) => { S.fov = +e.target.value; syncCamera(); });
$('#pitch').addEventListener('input', (e) => { S.pitch = +e.target.value; syncCamera(); });
onSwitch('#sharp', () => { S.sharp = !S.sharp; shown = { a: null, b: null }; if (S.runA) prefetch(S.index); sync(); });
onSwitch('#follow', () => {
  S.follow = !S.follow;
  S.yawOffset = S.follow ? 0 : S.travel + S.yawOffset;
  if (!S.follow) S.travel = 0;
  sync();
});
for (const b of $('#bmode').querySelectorAll('[data-b]')) {
  b.addEventListener('click', () => {
    if (b.dataset.b === 'run' && !S.runB) {
      status('Pick one of the other runs in the list under layer b first.');
      return;
    }
    setBMode(b.dataset.b);
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
$('#step-back').addEventListener('click', () => step(-1));
$('#step-fwd').addEventListener('click', () => step(1));
for (const b of $('#direction').querySelectorAll('[data-dir]')) b.addEventListener('click', () => { S.dir = +b.dataset.dir; shown.b = null; sync(); });
$('#sky').addEventListener('click', () => { S.pitch = 90; syncCamera(); });
$('#horizon').addEventListener('click', () => { S.pitch = 0; syncCamera(); });

// Tabs: the inspector (right) and the panel under the monitor. Buttons carry
// data-<attr>; panels carry data-<attr>-panel with the same value.
function tabs(bar, attr) {
  const buttons = [...$(bar).querySelectorAll(`[data-${attr}]`)];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      for (const x of buttons) x.classList.toggle('on', x === b);
      for (const p of document.querySelectorAll(`[data-${attr}-panel]`)) p.hidden = p.getAttribute(`data-${attr}-panel`) !== b.dataset[attr];
    });
  }
}
tabs('#insp-tabs', 'tab');
tabs('#below-tabs', 'below');

// The places row folds away (P).
const togglePads = () => $('#pads').classList.toggle('closed');
$('#pads-head').addEventListener('click', togglePads);

// H: the picture only.
const toggleBare = () => document.body.classList.toggle('bare');

$('#midi-btn').addEventListener('click', () => { $('#midi-panel').hidden = !$('#midi-panel').hidden; });

window.addEventListener('keydown', (e) => {
  // ⌘S saves the project (⇧⌘S: save as), from anywhere, even while typing.
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS' && !OUTPUT) {
    e.preventDefault();
    if (e.shiftKey) openProjectMenu(true); else saveProject();
    return;
  }
  if (e.target.closest('input, select, [contenteditable]')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
  else if (e.code === 'ArrowUp') { e.preventDefault(); S.pitch = 90; }
  else if (e.code === 'ArrowDown') { e.preventDefault(); S.pitch = 0; }
  else if (e.code === 'KeyR') { S.dir = -S.dir; shown.b = null; sync(); }
  else if (e.code === 'KeyH') toggleBare();
  else if (e.code === 'KeyP') togglePads();
  else if (e.code === 'KeyF') { if (OUTPUT) { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } else fullscreen(); }
  else if (e.code === 'KeyL' && !OUTPUT) setLive(!S.live);
  else if (e.code === 'KeyS') toggleSun();
  else if (e.code === 'KeyV') toggleRecord();
  else if (e.code === 'Escape') { cancelLearn(); $('#midi-panel').hidden = true; closeProjectMenu(); }
  else if (e.code === 'KeyM' && !OUTPUT) setLearnMode(!learnMode);
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

// ---- MIDI: controller profiles, learn mode (phase 4; profiles in midi.js) ----------------
// Every control MIDI can reach is in `controls` (built at the end of this file).
// A message goes to the bindings of the current profile that match it; the most
// specific win (a learned key beats "any key"). Learn mode (M): click a control,
// move a knob, pad or key. Clock messages go to onClock.

const profiles = new Profiles();
const controls = new Map();   // id → { id, label, kind: range|toggle|trigger|choice|turn|glance, … }
const lastCC = new Map();     // last value per CC source, to see a button's press (rising past 64)
let armed = null;             // the control waiting for a knob in learn
let learnMode = false;        // M: every mappable control is outlined; click one to arm it
let justLearned = null;       // { src, to, values, at }: watch a few more values to spot an endless knob
const devices = new Map();    // input id → { name, hit }
let lastMessage = '';

const wild = (src) => src.split('*').length - 1;

function onMidi(data, t = performance.now(), src = { id: '', name: 'MIDI' }) {
  if (data[0] >= 0xf0) return onClock(data, t, src);
  const m = parse(data);
  if (!m) return;
  const d = devices.get(src.id);
  if (d) d.hit = performance.now();
  lastMessage = `${describe(srcOf(m))} = ${m.type === 'pb' ? m.v14 : m.v} · ${src.name}`;
  if (m.type === 'off') return;
  if (armed) return learnFrom(m);
  watchLearned(m);
  const found = profiles.find(m);
  const fewest = Math.min(...found.map((b) => wild(b.src)));
  for (const b of found) {
    if (wild(b.src) !== fewest) continue;
    const c = controls.get(b.to);
    if (c) applyBinding(c, b, m);
  }
  if (m.type === 'cc') lastCC.set(srcOf(m), m.v);
}

function applyBinding(c, b, m) {
  const v01 = m.type === 'pb' ? m.v14 / 16383 : m.v / 127;
  const rising = m.type === 'cc' && m.v >= 64 && (lastCC.get(srcOf(m)) ?? 0) < 64;
  const pressed = m.type === 'note' || m.type === 'pc' || rising;
  const asButton = m.type !== 'cc' && m.type !== 'pb' ? true : b.mode === 'press';
  const clamp = (v, lo, hi) => Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), v));
  switch (c.kind) {
    case 'range': {
      const [lo, hi] = b.range || [c.min, c.max];
      if (asButton) { if (pressed) c.set(c.get() > (lo + hi) / 2 ? lo : hi); } // a pad on a slider: jump end to end
      else if (b.mode === 'rel') c.set(clamp(c.get() + ((m.v - 64) * (hi - lo)) / 100, lo, hi));
      else c.set(lo + v01 * (hi - lo));
      break;
    }
    case 'toggle':
      if (asButton || b.mode !== 'abs') { if (pressed) c.flip(); } else if ((v01 >= 0.5) !== !!c.get()) c.flip();
      break;
    case 'trigger':
      if (pressed) c.run();
      break;
    case 'choice': {
      const o = c.options;
      if (asButton) { if (pressed) c.set(o[(o.indexOf(c.get()) + 1) % o.length]); } else c.set(o[Math.min(o.length - 1, Math.floor(v01 * o.length))]);
      break;
    }
    case 'turn':
      if (b.mode === 'abs') S.yawOffset = v01 * 360 - 180; else S.yawOffset += (m.v - 64) * 3;
      break;
    case 'glance':
      S.glance = (v01 - 0.5) * 180;
      break;
  }
}

// ---- learn ----

function arm(id) {
  armed = armed === id ? null : id;
  const c = controls.get(armed);
  if (c) status(`Learning "${c.label}": move a knob, fader, pad or key. Esc cancels.`);
  renderLearn();
}

function learnFrom(m) {
  const c = controls.get(armed);
  const src = srcOf(m);
  let mode;
  if (m.type === 'cc') mode = c.kind === 'trigger' || c.kind === 'toggle' ? 'press' : c.kind === 'turn' ? 'rel' : 'abs';
  if (m.type === 'pb') mode = 'abs';
  profiles.bind(armed, src, mode);
  justLearned = { src, to: armed, values: [m.v], at: performance.now() };
  if (m.type === 'cc') lastCC.set(src, m.v);
  status(`Learned: ${describe(src)} → ${c.label}.${learnMode ? ' Click another control, or M to finish.' : ''}`);
  armed = null;
  renderLearn();
}

// An endless knob sends 64 ± a few steps; a normal one sweeps 0–127. Turning a
// knob just after learning it tells them apart.
function watchLearned(m) {
  const j = justLearned;
  if (!j || m.type !== 'cc' || srcOf(m) !== j.src) return;
  if (performance.now() - j.at > 1500) { justLearned = null; return; }
  j.values.push(m.v);
  const c = controls.get(j.to);
  if (j.values.length >= 4 && j.values.every((v) => v >= 58 && v <= 70) && c && (c.kind === 'range' || c.kind === 'turn')) {
    const b = profiles.profile.bindings.find((x) => x.src === j.src && x.to === j.to);
    if (b && b.mode !== 'rel') {
      b.mode = 'rel';
      profiles.push();
      status(`"${c.label}": that's an endless knob (∞), so turning it nudges the value.`);
      renderMidiPanel();
    }
    justLearned = null;
  }
}

function setLearnMode(on) {
  learnMode = on;
  if (!on) armed = null;
  document.body.classList.toggle('midi-learn', on);
  status(on ? 'MIDI learn: click any outlined control, then move a knob, fader, pad or key. M or Esc to finish.' : 'MIDI learn finished.');
  renderLearn();
}

function cancelLearn() {
  if (armed) { armed = null; renderLearn(); status('Learn cancelled.'); } else if (learnMode) setLearnMode(false);
}

if (!OUTPUT) {
  // In learn mode a click arms the control instead of using it.
  const learnTarget = (e) => ((learnMode || armed) && !e.target.closest('#midi-panel') ? e.target.closest('[data-learn]') : null);
  document.addEventListener('click', (e) => {
    const el = learnMode && learnTarget(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    arm(el.dataset.learn);
  }, true);
  for (const type of ['pointerdown', 'mousedown', 'input', 'change']) {
    document.addEventListener(type, (e) => { if (learnMode && learnTarget(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
  }
}

// Outline, mark and label every mappable control (data-learn) with its bindings.
function renderLearn() {
  for (const el of document.querySelectorAll('[data-learn]')) {
    const bs = profiles.bindingsFor(el.dataset.learn);
    if (bs.length) el.dataset.bound = bs.map((b) => shortName(b.src)).join(' '); else delete el.dataset.bound;
    el.classList.toggle('armed', el.dataset.learn === armed);
  }
  $('#midi-learn')?.classList.toggle('on', learnMode);
  if (rows.size) refreshEffects();
  placeBadges();
  renderMidiPanel();
}

// In learn mode, small labels show what each control is mapped to.
function placeBadges() {
  const layer = $('#learn-layer');
  if (!layer) return;
  if (!learnMode) { layer.replaceChildren(); return; }
  const seen = new Set();
  // Effect and kick rows show their mapping in the row itself, so they get no badge.
  layer.replaceChildren(...[...document.querySelectorAll('[data-learn][data-bound]:not(.fx-row)')].filter((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || seen.has(el.dataset.learn + r.top)) return false;
    seen.add(el.dataset.learn + r.top);
    return true;
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return Object.assign(document.createElement('span'), { className: 'badge', textContent: el.dataset.bound, style: `left:${r.right - 2}px;top:${r.top - 7}px` });
  }));
}

// ---- devices ----

function attachMidi(access) {
  const known = new Set();
  const attach = () => {
    const names = [];
    for (const input of access.inputs.values()) {
      if (input.state === 'disconnected') { devices.delete(input.id); continue; }
      input.onmidimessage = (m) => onMidi(m.data, m.timeStamp || performance.now(), input);
      if (!devices.has(input.id)) devices.set(input.id, { name: input.name, hit: 0 });
      names.push(input.name);
    }
    // A controller with its own profile brings it in (the one just plugged in first).
    const fresh = names.filter((n) => !known.has(n));
    known.clear();
    for (const n of names) known.add(n); // only what's connected now, so a replugged controller counts as new
    const p = fresh.length ? profiles.forDevices(fresh) : null;
    if (p && p.name !== profiles.current) {
      profiles.use(p.name);
      status(`MIDI: using the "${p.name}" profile for ${names.join(', ')}.`);
    }
    $('#status-midi').textContent = names.length ? `midi: ${names.join(', ')} · ${profiles.current}` : 'midi: none';
    $('#midi-dot').classList.toggle('ok', names.length > 0);
    renderLearn();
  };
  access.onstatechange = attach;
  attach();
}

if (OUTPUT) {
  // The control window handles MIDI; the output only mirrors it.
} else if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(attachMidi).catch(() => { $('#midi-devices').textContent = 'MIDI permission not given (keyboard and mouse still work).'; });
} else {
  $('#midi-devices').textContent = 'MIDI is not available in this browser (use Chrome).';
}

// ---- effects panel, presets and MIDI learn ------------------------------------------------

const rows = new Map(); // param id -> { row, input, val, bound }
const extras = new Map(); // learnable controls outside the look (kick): id -> { row, input, val, bound, p, get, set }
const fmt = (p, v) => (p.step >= 1 ? String(Math.round(v)) : v.toFixed(2));

function buildEffects() {
  const box = $('#fx-params');
  let group = null;
  let section = null;
  for (const p of PARAMS) {
    if (p.group !== group) {
      group = p.group;
      section = Object.assign(document.createElement('div'), { className: 'fx-section' });
      section.append(Object.assign(document.createElement('div'), { className: 'fx-group', textContent: group.toLowerCase() }));
      box.append(section);
    }
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.dataset.learn = `fx.${p.id}`;
    // A 0/1 parameter is a choice between two things, so it gets two buttons, not a slider.
    const choice = p.step >= 1 && p.max === 1 && p.min === 0;
    const [nameText, a, b] = choice ? p.label.split(/: | ↔ /) : [p.label.replace(/ \(.*\)$/, '')];
    row.innerHTML = `<div class="name"><span title="${p.label}">${nameText}</span><span class="bound"></span></div>` +
      (choice ? `<span class="seg"><button data-v="0">${a}</button><button data-v="1">${b}</button></span>`
        : `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}"><span class="val"></span>`) +
      `<button class="learn">learn</button>`;
    const input = row.querySelector('input');
    if (input) {
      input.value = look[p.id];
      input.addEventListener('input', () => setParam(p.id, +input.value));
      input.addEventListener('dblclick', () => setParam(p.id, p.neutral));
    } else {
      for (const btn of row.querySelectorAll('[data-v]')) btn.addEventListener('click', () => setParam(p.id, +btn.dataset.v));
    }
    row.querySelector('.learn').addEventListener('click', () => arm(`fx.${p.id}`));
    section.append(row);
    rows.set(p.id, { row, input, seg: row.querySelector('.seg'), val: row.querySelector('.val'), bound: row.querySelector('.bound'), p });
    if (p.id === 'tint') {
      const c = document.createElement('div');
      c.className = 'fx-row';
      c.innerHTML = '<div class="name"><span>tint colour</span></div><span><input type="color" id="tint-colour" value="#ff8c33"></span>';
      section.append(c);
    }
  }
  const kickRow = (id, label, p, get, set, unit = '') => {
    const row = document.createElement('div');
    row.className = 'fx-row';
    row.dataset.learn = id;
    row.innerHTML = `<div class="name"><span>${label}</span><span class="bound"></span></div>` +
      `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}"><span class="val"></span><button class="learn">learn</button>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => { set(+input.value); refreshEffects(); });
    input.addEventListener('dblclick', () => { set(p.neutral); refreshEffects(); });
    row.querySelector('.learn').addEventListener('click', () => arm(id));
    $('#kick-params').append(row);
    extras.set(id, { row, input, val: row.querySelector('.val'), bound: row.querySelector('.bound'), p: { ...p, unit }, get, set });
  };
  kickRow('kick.volume', 'volume', { min: 0, max: 1, step: 0.01, neutral: 0.5 }, () => kick.volume, (v) => { kick.setVolume(v); saveKick(); });
  kickRow('kick.offset', 'offset (+ = later)', { min: -250, max: 250, step: 5, neutral: 0 }, () => kick.offset, (v) => { kick.offset = v; saveKick(); }, ' ms');
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
  const boundTo = (id) => (armed === id ? 'move a control…' : profiles.bindingsFor(id).map((b) => shortName(b.src)).join(' '));
  for (const [id, r] of rows) {
    if (r.input) {
      r.input.value = look[id];
      r.val.textContent = fmt(r.p, look[id]);
    } else {
      for (const btn of r.seg.children) btn.classList.toggle('on', +btn.dataset.v === Math.round(look[id]));
    }
    r.row.classList.toggle('changed', look[id] !== r.p.neutral);
    r.row.classList.toggle('learning', armed === `fx.${id}`);
    r.bound.textContent = boundTo(`fx.${id}`);
  }
  for (const [id, r] of extras) {
    r.input.value = r.get();
    r.val.textContent = fmt(r.p, r.get()) + r.p.unit;
    r.row.classList.toggle('changed', r.get() !== r.p.neutral);
    r.row.classList.toggle('learning', armed === id);
    r.bound.textContent = boundTo(id);
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
    if (i < 9) b.dataset.learn = `look.${i + 1}`;
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

buildEffects();

// ---- hold the sun ------------------------------------------------------------------------

function toggleSun() {
  S.sun = !S.sun;
  if (!S.sun) {
    // Stay looking where the sun was, then carry on from there.
    S.yawOffset = S.lockYaw - S.travel;
    S.pitch = S.lockPitch;
  }
  sync();
  if (S.sun && !S.sunSpot) status('No clear sun in this photo (overcast, shade or night). It locks on when one appears.');
}
onSwitch('#sun', toggleSun);

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
    for (const b of [$('#record'), $('#record-2')]) b.classList.remove('on');
    $('#record').innerHTML = 'rec <kbd>V</kbd>';
    $('#record-2').textContent = 'record';
    $('#hud-rec').textContent = '';
    status(`Saved ${Math.round(blob.size / 1e6)} MB video to your Downloads folder.`);
  };
  recorder.start(1000);
  recordStart = performance.now();
  for (const b of [$('#record'), $('#record-2')]) b.classList.add('on');
  $('#record').innerHTML = 'stop <kbd>V</kbd>';
  $('#record-2').textContent = 'stop recording';
}
$('#record').addEventListener('click', toggleRecord);
$('#record-2').addEventListener('click', toggleRecord);
setInterval(() => {
  if (!recorder) return;
  const s = Math.floor((performance.now() - recordStart) / 1000);
  $('#hud-rec').textContent = `● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 250);

// ---- mirroring to the output ------------------------------------------------------------------
// The editor broadcasts its state 20 times a second, and at once whenever the
// photo, the run or live changes (so a photo change reaches the output on the
// same beat, not up to 50 ms later). An ?output page (the output window, or the
// MIDIMap app's output and Syphon windows) follows it. Each loads its own
// photos, so the output never waits on the editor's screen. Its own channel name,
// so experiment 3 open in another tab doesn't interfere.

const MIRROR_KEYS = ['bMode', 'delay', 'dir', 'fps', 'mode', 'mix', 'smooth', 'sharp', 'pitch', 'fov', 'follow', 'yawOffset', 'glance', 'sun', 'tempo', 'bpm', 'stepsPerBeat', 'live'];
const channel = new BroadcastChannel('midimap-editor');
let posted = '';
function postState() {
  posted = `${S.runA?.id}:${S.index}:${S.live}:${S.bMode}:${S.runB?.id}`;
  channel.postMessage({
    S: Object.fromEntries(MIRROR_KEYS.map((k) => [k, S[k]])),
    look: { ...look },
    runA: S.runA?.id || null,
    imageA: S.runA?.ids[S.index] || null,
    runB: S.bMode === 'run' ? S.runB?.id || null : null,
    index: S.index,
  });
}
function postIfMoved() {
  if (posted !== `${S.runA?.id}:${S.index}:${S.live}:${S.bMode}:${S.runB?.id}`) postState();
}

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
  setInterval(postState, 50);
}

// ---- live and the output window ------------------------------------------------------------
// L: live on/off. The output window shows the picture alone on a chosen display.
// In Chrome the displays come from the Window Management API (it asks once);
// in the MIDIMap app, from the app itself (window.midimapApp), which opens a
// real full-screen window there (Syphon carries on regardless).

const APP = window.midimapApp || null;
let outWin = null;      // the output window (Chrome)
let screenDetails = null;
let displays = [];      // [{ id, label, width, height, primary, current, left, top, aw, ah }]
let outFull = true;     // open full screen (true) or as a window

function setLive(on) {
  S.live = on;
  sync();
  postState();
  status(on ? 'Live: the output shows the picture.' : 'Not live: the output fades to black. L goes live again.');
}

function renderLive() {
  setSw('#live-sw', S.live);
  $('#live').classList.toggle('on', S.live);
  $('#monitor').classList.toggle('offair', !S.live);
  $('#live-badge').textContent = S.live ? '● live' : 'not live · output faded to black · L';
  $('#live-badge').classList.toggle('on', S.live);
}

async function findDisplays(ask = false) {
  if (APP) {
    displays = await APP.displays();
  } else if ('getScreenDetails' in window) {
    try {
      // Without asking, only read them if permission was already given.
      const perm = await navigator.permissions.query({ name: 'window-management' }).catch(() => null);
      if (!ask && perm?.state !== 'granted') return renderDisplays();
      screenDetails = await window.getScreenDetails();
      screenDetails.onscreenschange = () => findDisplays();
      displays = screenDetails.screens.map((s, i) => ({
        id: i, label: s.label || `display ${i + 1}`, width: s.width, height: s.height,
        primary: s.isPrimary, current: s === screenDetails.currentScreen,
        left: s.availLeft, top: s.availTop, aw: s.availWidth, ah: s.availHeight,
      }));
    } catch {
      status('The browser did not allow listing displays; the output opens as a window you can drag.', true);
    }
  }
  renderDisplays();
}

function renderDisplays() {
  const sel = $('#out-display');
  const keep = sel.value;
  sel.replaceChildren(...(displays.length ? displays.map((d) => Object.assign(document.createElement('option'), {
    value: String(d.id),
    textContent: `${d.label} · ${d.width}×${d.height}${d.current ? ' · this screen' : ''}`,
  })) : [Object.assign(document.createElement('option'), { value: '', textContent: 'this screen' })]));
  // Default to a display other than the editor's, if there is one.
  const other = displays.find((d) => !d.current);
  sel.value = displays.some((d) => String(d.id) === keep) ? keep : String((other || displays[0])?.id ?? '');
  $('#find-displays').hidden = !!APP || displays.length > 0 || !('getScreenDetails' in window);
}

const outputOpen = () => (APP ? appOutputOpen : !!(outWin && !outWin.closed));
let appOutputOpen = false;

async function openOutput() {
  const d = displays.find((x) => String(x.id) === $('#out-display').value);
  if (APP) {
    await APP.openOutput({ display: d?.id ?? null, fullscreen: outFull });
    appOutputOpen = true;
    renderOutput();
    return;
  }
  const where = d ? `left=${d.left},top=${d.top},width=${d.aw},height=${d.ah}` : 'width=960,height=540';
  outWin = window.open('./?output', 'midimap-output', `popup,${where}`);
  if (!outWin) return status('The browser blocked the output window. Allow pop-ups for this site, then try again.', true);
  if (d && !outFull) outWin.moveTo(d.left, d.top);
  if (outFull) {
    const go = () => outWin.document.documentElement.requestFullscreen(d && screenDetails ? { screen: screenDetails.screens[d.id] } : {})
      .then(() => status(`Output: full screen on ${d ? d.label : 'this screen'}.`))
      .catch(() => status('Output window open. To make it full screen, double-click it or press F in it.'));
    if (outWin.document.readyState === 'complete') go(); else outWin.addEventListener('load', go, { once: true });
  }
  renderOutput();
}

function closeOutput() {
  if (APP) { APP.closeOutput(); appOutputOpen = false; } else if (outWin && !outWin.closed) outWin.close();
  renderOutput();
}

function renderOutput() {
  const open = outputOpen();
  $('#output-window').textContent = open ? 'move here' : 'open output';
  $('#out-state').textContent = open ? (S.live ? '● open · live' : '● open · black') : 'closed';
  $('#out-state').style.color = open ? (S.live ? 'var(--run)' : 'var(--txt-2)') : '';
  $('#output-close').hidden = !open;
  setSeg('#out-mode', 'full', outFull ? '1' : '0');
  const where = displays.find((x) => String(x.id) === $('#out-display').value);
  $('#status-output').textContent = open ? `output: ${where ? where.label : 'window'}${S.live ? ' · live' : ' · black'}` : 'output: closed';
  $('#status-output').classList.toggle('ok', open && S.live);
}

// F: full screen for the output if it's open, otherwise for the editor.
function fullscreen() {
  if (APP && appOutputOpen) return APP.toggleOutputFullscreen();
  if (outWin && !outWin.closed) {
    const doc = outWin.document;
    if (doc.fullscreenElement) return doc.exitFullscreen();
    return doc.documentElement.requestFullscreen().catch(() => status('Double-click the output window (or press F in it) to make it full screen.'));
  }
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
}

if (OUTPUT) {
  // The output itself: double-click or F toggles full screen; a hint says so briefly.
  const hint = () => {
    $('#out-hint').hidden = !!document.fullscreenElement || APP_OUTPUT;
    clearTimeout(hint.t);
    hint.t = setTimeout(() => { $('#out-hint').hidden = true; }, 3000);
  };
  $('#view').addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
  document.addEventListener('fullscreenchange', hint);
  hint();
} else {
  $('#live').addEventListener('click', () => setLive(!S.live));
  onSwitch('#live-sw', () => setLive(!S.live));
  $('#output-window').addEventListener('click', openOutput);
  $('#output-close').addEventListener('click', closeOutput);
  $('#find-displays').addEventListener('click', () => findDisplays(true));
  $('#out-display').addEventListener('change', (e) => { e.target.blur(); renderOutput(); });
  for (const b of $('#out-mode').querySelectorAll('[data-full]')) b.addEventListener('click', () => { outFull = b.dataset.full === '1'; renderOutput(); });
  if (APP) {
    APP.onOutputClosed?.(() => { appOutputOpen = false; renderOutput(); });
    $('#syphon').hidden = false;
    for (const b of $('#syphon-fps').querySelectorAll('[data-fps]')) b.addEventListener('click', () => APP.setSyphonFps(+b.dataset.fps));
    setInterval(async () => {
      const sy = await APP.syphon();
      setSeg('#syphon-fps', 'fps', sy.fps);
      $('#syphon-info').textContent = `Sending "MIDIMap" ${sy.size || '(starting)'} at ${sy.measured.toFixed(1)} fps (target ${sy.fps}).`;
      $('#status-syphon').textContent = `syphon ${sy.measured.toFixed(0)} fps`;
      lastSyphonFps = sy.fps;
    }, 2000);
  }
  setInterval(renderOutput, 1000);
  findDisplays();
}

// ---- tempo controls -----------------------------------------------------------------------
const spbShort = (spb) => ({ 0.25: '1 / 4 beats', 0.5: '1 / 2 beats', 1: '1 / beat', 2: '2 / beat', 4: '4 / beat' })[spb];
$('#spb').replaceChildren(...STEPS_PER_BEAT.map((v) => Object.assign(document.createElement('option'), { value: String(v), textContent: spbShort(v) })));
onSwitch('#tempo', toggleTempo);
$('#bpm-down').addEventListener('click', (e) => setBpm(S.bpm - (e.shiftKey ? 5 : 1)));
$('#bpm-up').addEventListener('click', (e) => setBpm(S.bpm + (e.shiftKey ? 5 : 1)));
// After typing a BPM, Enter (or leaving the box) applies it and gives the keys back to the editor.
$('#bpm').addEventListener('change', (e) => { setBpm(+e.target.value || S.bpm); e.target.blur(); });
$('#bpm').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
$('#tap').addEventListener('click', tap);
$('#spb').addEventListener('change', (e) => { setStepsPerBeat(+e.target.value); e.target.blur(); });
$('#clock-source').addEventListener('change', (e) => { setClockSource(e.target.value); e.target.blur(); });
for (const b of $('#kick-type').querySelectorAll('[data-kick]')) b.addEventListener('click', () => setKick(b.dataset.kick));
window.blend.clock = clock;
window.blend.onMidi = onMidi; // lets a page feed in a fake clock for testing
sync();

// ---- projects (phase 3; storage in project.js) -------------------------------------------
// The open project's name, and a fingerprint of how it was when saved, so the
// top bar can say saved / unsaved. Unsaved changes are kept as a draft across
// reloads. Looks stay global: a project keeps the effect values that were on.

const projects = new ProjectStore();
const project = { name: null, savedFp: null };
let pendingPhoto = null;   // where to start once the map is ready
let lastSyphonFps = null;

const DEFAULT_PROJECT = () => ({
  version: PROJECT_VERSION, name: null,
  places: DEFAULT_SLOTS.map((x) => ({ ...x })),
  layers: { mode: 1, mix: 0.5, smooth: 0, bMode: 'delay', delay: 8, runB: null },
  effects: neutralLook(),
  camera: { fov: 90, pitch: 0, follow: true, sun: false, sharp: false },
  playback: { dir: 1, fps: 3, photo: null, slot: START_SLOT },
  tempo: { bpm: 120, stepsPerBeat: 1, lock: false, clock: 'internal' },
  audio: { kick: 'off', volume: 0.5, offset: 0 },
  output: { fullscreen: true, display: null, syphonFps: 30 },
  midi: { profile: null },
});

function captureProject(name = project.name) {
  const display = displays.find((d) => String(d.id) === $('#out-display').value);
  return {
    version: PROJECT_VERSION,
    name,
    savedAt: Date.now(),
    places: slots.map((x) => ({ ...x })),
    layers: { mode: S.mode, mix: S.mix, smooth: S.smooth, bMode: S.bMode, delay: S.delay, runB: S.bMode === 'run' ? S.runB?.id || null : null },
    effects: Object.fromEntries(Object.keys(neutralLook()).map((k) => [k, look[k]])),
    camera: { fov: S.fov, pitch: S.pitch, follow: S.follow, sun: S.sun, sharp: S.sharp },
    playback: { dir: S.dir, fps: S.fps, photo: S.runA ? { sequence: S.runA.id, image: S.runA.ids[S.index] } : null, slot: currentSlot },
    tempo: { bpm: S.bpm, stepsPerBeat: S.stepsPerBeat, lock: S.tempo, clock: clock.source },
    audio: { kick: kick.type, volume: kick.volume, offset: kick.offset },
    output: { fullscreen: outFull, display: display?.label || null, syphonFps: lastSyphonFps },
    midi: { profile: profiles.current },
  };
}

// Everything but the photo (which needs the map and the network).
function applySettings(p) {
  const d = DEFAULT_PROJECT();
  const L = { ...d.layers, ...p.layers };
  const C = { ...d.camera, ...p.camera };
  const P = { ...d.playback, ...p.playback };
  const T = { ...d.tempo, ...p.tempo };
  const A = { ...d.audio, ...p.audio };
  const O = { ...d.output, ...p.output };
  setSlots(Array.isArray(p.places) && p.places.length === SLOT_COUNT ? p.places : d.places);
  Object.assign(S, { mode: L.mode, mix: L.mix, smooth: L.smooth, delay: L.delay });
  if (L.bMode !== 'run') setBMode(L.bMode);
  Object.assign(look, neutralLook(), p.effects);
  currentPreset = null;
  if (C.sharp !== S.sharp) shown = { a: null, b: null };
  Object.assign(S, { fov: C.fov, pitch: C.pitch, follow: C.follow, sun: C.sun, sharp: C.sharp });
  Object.assign(S, { dir: P.dir, fps: P.fps });
  currentSlot = P.slot ?? null;
  Object.assign(S, { bpm: T.bpm, stepsPerBeat: T.stepsPerBeat, tempo: T.lock });
  if (T.clock !== clock.source) setClockSource(T.clock);
  kick.setVolume(A.volume);
  kick.offset = A.offset;
  saveKick();
  setKick(A.kick); // the kick is heard from the next click or key (browsers' rule)
  if (A.kick === 'off') S.tempo = T.lock;
  outFull = O.fullscreen;
  const match = displays.find((x) => x.label === O.display);
  if (match) $('#out-display').value = String(match.id);
  if (APP && O.syphonFps && O.syphonFps !== lastSyphonFps) APP.setSyphonFps(O.syphonFps);
  if (p.midi?.profile && p.midi.profile !== profiles.current && profiles.use(p.midi.profile)) status(`MIDI profile: ${p.midi.profile}.`);
  renderSlots();
  renderPresets();
  refreshEffects();
  renderOutput();
  sync();
}

async function goToProjectPhoto(p) {
  const photo = p.playback?.photo;
  if (!photo) return goSlot(p.playback?.slot || START_SLOT);
  await startRun(photo.sequence, photo.image);
  if (p.layers?.bMode === 'run' && p.layers.runB) await useRunB(p.layers.runB, null);
}

// Called when the map is ready: the open project's photo, or the default place.
function startingPlace() {
  if (pendingPhoto) goToProjectPhoto(pendingPhoto); else goSlot(START_SLOT);
  pendingPhoto = null;
}

function loadProject(p, name) {
  p = migrate(p);
  applySettings(p);
  project.name = name;
  project.savedFp = name ? fingerprint(p) : fingerprint(captureProject(null));
  ProjectStore.setCurrent(name, null);
  renderProjectState();
  return p;
}

async function openProject(name) {
  if (isDirty() && !confirm(`Discard the unsaved changes to "${project.name || 'untitled'}"?`)) return;
  try {
    const p = loadProject(projects.all[name], name);
    closeProjectMenu();
    status(`Opened project "${name}".`);
    await goToProjectPhoto(p);
  } catch (err) {
    status(`Could not open "${name}": ${err.message}`, true);
  }
}

function newProject() {
  if (isDirty() && !confirm(`Discard the unsaved changes to "${project.name || 'untitled'}"?`)) return;
  loadProject(DEFAULT_PROJECT(), null);
  closeProjectMenu();
  goSlot(START_SLOT);
  status('New project (untitled). ⌘S saves it.');
}

async function saveProject(name = project.name) {
  if (!name) return openProjectMenu(true);
  try {
    const p = captureProject(name);
    const where = await projects.save(name, p);
    project.name = name;
    project.savedFp = fingerprint(p);
    ProjectStore.setCurrent(name, null);
    closeProjectMenu();
    renderProjects();
    renderProjectState();
    status(`Saved project "${name}" (${where}).`);
  } catch (err) {
    status(`Could not save: ${err.message}`, true);
  }
}

async function deleteProject(name) {
  if (!confirm(`Delete the project "${name}"? This can't be undone.`)) return;
  try {
    await projects.remove(name);
    if (project.name === name) { project.name = null; project.savedFp = fingerprint(captureProject(null)); ProjectStore.setCurrent(null, null); }
    renderProjects();
    renderProjectState();
    status(`Deleted project "${name}".`);
  } catch (err) {
    status(err.message, true);
  }
}

const isDirty = () => project.savedFp !== null && fingerprint(captureProject()) !== project.savedFp;

// ---- the project menu ----

function openProjectMenu(saveAs = false) {
  $('#project-menu').hidden = false;
  $('#midi-panel').hidden = true;
  renderProjects();
  if (saveAs) {
    $('#project-name-input').value = project.name ? `${project.name} copy` : 'my project';
    $('#project-name-input').focus();
    $('#project-name-input').select();
  }
}
function closeProjectMenu() { $('#project-menu').hidden = true; }

const when = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? `today ${d.toTimeString().slice(0, 5)}` : d.toISOString().slice(0, 10);
};

function renderProjects() {
  const all = projects.all;
  const names = Object.keys(all).sort((a, b) => (all[b].savedAt || 0) - (all[a].savedAt || 0));
  $('#project-list').replaceChildren(...(names.length ? names.map((n) => {
    const li = document.createElement('li');
    li.className = n === project.name ? 'on' : '';
    li.innerHTML = '<span class="n"></span><span class="dim w"></span><button class="x" title="Delete">×</button>';
    li.querySelector('.n').textContent = n;
    li.querySelector('.w').textContent = `${when(all[n].savedAt)} · ${projects.isLocal(n) ? 'this browser only' : 'synced'}`;
    li.addEventListener('click', () => openProject(n));
    li.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); deleteProject(n); });
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'dim', textContent: 'No saved projects yet.' })]));
  let sync = projects.sync.canWrite ? 'Projects sync: on (shared with your other browsers and the app).' : 'Projects sync: read-only here; projects you save stay in this browser until the sync key is added (effects tab → looks).';
  if (projects.offline) sync = 'Projects sync: offline, showing the last synced list. Saving works again once connected.';
  $('#project-sync').textContent = sync;
}

function renderProjectState() {
  const dirty = isDirty();
  $('#project-name').textContent = project.name || 'untitled';
  $('#project-state').textContent = !project.name ? '● not saved' : dirty ? '● unsaved changes' : '● saved';
  $('#project-state').className = !project.name || dirty ? 'unsaved' : 'saved';
}

if (!OUTPUT) {
  $('#project-btn').addEventListener('click', () => ($('#project-menu').hidden ? openProjectMenu() : closeProjectMenu()));
  $('#project-save').addEventListener('click', () => saveProject());
  $('#project-new').addEventListener('click', newProject);
  $('#project-save-as').addEventListener('click', () => saveProject($('#project-name-input').value.trim()));
  $('#project-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveProject(e.target.value.trim());
    if (e.key === 'Escape') { e.target.blur(); closeProjectMenu(); }
  });
  $('#project-rename').addEventListener('click', async () => {
    const to = $('#project-name-input').value.trim();
    const from = project.name;
    if (!from) return status('Save the project first, then rename it.');
    if (!to || to === from) return status('Type the new name in the box, then click rename.');
    await saveProject(to);
    if (project.name === to) { await projects.remove(from).catch(() => {}); renderProjects(); status(`Renamed "${from}" to "${to}".`); }
  });
  $('#project-export').addEventListener('click', () => download(captureProject(project.name || 'untitled')));
  $('#project-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = migrate(JSON.parse(await file.text()));
      let name = (p.name || file.name.replace(/\.midimap\.json$|\.json$/, '')).slice(0, 60);
      while (name in projects.all) name = `${name} (imported)`.slice(0, 60);
      await projects.save(name, { ...p, name });
      renderProjects();
      await openProject(name);
    } catch (err) {
      status(`Could not import that file: ${err.message}`, true);
    }
  });

  // Start where you left off: the open project, with any unsaved changes.
  const cur = ProjectStore.current();
  const saved = cur.name ? projects.all[cur.name] : null;
  try {
    const start = cur.draft || saved;
    if (start) {
      applySettings(migrate(start));
      pendingPhoto = start;
    }
  } catch {
    /* a broken draft: start fresh */
  }
  project.name = saved ? cur.name : null;
  project.savedFp = saved ? fingerprint(saved) : fingerprint(captureProject(null));

  // Keep unsaved changes across reloads (every second, and as the page closes,
  // so the last second isn't lost); refresh the saved/unsaved mark.
  const keepDraft = () => ProjectStore.setCurrent(project.name, isDirty() || !project.name ? captureProject() : null);
  setInterval(() => { renderProjectState(); keepDraft(); }, 1000);
  addEventListener('pagehide', keepDraft);
  renderProjectState();
  projects.init().then(() => projects.refresh()).then(renderProjects);
  setInterval(() => projects.refresh().then(renderProjects), 30000);
}

// A project can open with the kick on, but browsers only allow sound after a
// click or key press: the first one starts it.
if (!OUTPUT) for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => { if (kick.ctx?.state === 'suspended') kick.ctx.resume(); }, { capture: true });
if (!OUTPUT) Object.assign(window.blend, { project, captureProject, fingerprint }); // for tests and the console

// ---- the controls MIDI can reach (phase 4) ------------------------------------------------
// id → what it is and how to set it. The ids are what profiles store, and what
// [data-learn] marks on screen.

function buildControls() {
  const range = (id, label, min, max, get, set) => controls.set(id, { id, label, kind: 'range', min, max, get, set });
  const toggle = (id, label, get, flip) => controls.set(id, { id, label, kind: 'toggle', get, flip });
  const trigger = (id, label, run) => controls.set(id, { id, label, kind: 'trigger', run });
  const choice = (id, label, options, get, set) => controls.set(id, { id, label, kind: 'choice', options, get, set });

  // layers & blend
  range('mix', 'blend mix', 0, 1, () => S.mix, (v) => { S.mix = v; sync(); });
  range('smooth', 'cut ↔ dissolve', 0, 1, () => S.smooth, (v) => { S.smooth = v; sync(); });
  range('delay', 'layer b delay', 0, 40, () => S.delay, (v) => { S.delay = Math.round(v); shown.b = null; sync(); });
  choice('bmode', 'layer b', ['delay', 'run', 'off'], () => S.bMode, (v) => { if (v !== 'run' || S.runB) setBMode(v); });
  choice('blend', 'blend mode', BLEND_MODES.map((_, i) => i), () => S.mode, (v) => { S.mode = v; sync(); });
  trigger('blend.next', 'next blend mode', () => { S.mode = (S.mode + 1) % BLEND_MODES.length; sync(); });
  trigger('blend.prev', 'previous blend mode', () => { S.mode = (S.mode + BLEND_MODES.length - 1) % BLEND_MODES.length; sync(); });
  // playback
  trigger('play', 'play / pause', togglePlay);
  trigger('step.fwd', 'step forward', () => step(1));
  trigger('step.back', 'step back', () => step(-1));
  trigger('step.paused', 'step (while paused)', () => { if (!S.playing) step(S.dir); });
  choice('dir', 'direction', [1, -1], () => S.dir, (v) => { S.dir = v; shown.b = null; sync(); });
  range('speed', 'speed (BPM when locked)', 0, 1, () => (S.tempo ? (S.bpm - 40) / 160 : S.fps / 12),
    (v) => { if (S.tempo) setBpm(40 + v * 160); else { S.fps = Math.max(0.5, Math.round(v * 24) / 2); sync(); } });
  // tempo
  range('bpm', 'BPM', 40, 200, () => S.bpm, (v) => setBpm(Math.round(v)));
  toggle('tempo', 'lock to tempo', () => S.tempo, toggleTempo);
  trigger('tap', 'tap tempo', tap);
  choice('spb', 'steps per beat', STEPS_PER_BEAT, () => S.stepsPerBeat, setStepsPerBeat);
  choice('clock', 'clock source', ['internal', 'external'], () => clock.source, setClockSource);
  // camera
  range('fov', 'field of view', 30, 130, () => S.fov, (v) => { S.fov = v; syncCamera(); });
  range('pitch', 'look up', -90, 90, () => S.pitch, (v) => { S.pitch = v; syncCamera(); });
  controls.set('turn', { id: 'turn', label: 'turn (endless knob)', kind: 'turn' });
  controls.set('glance', { id: 'glance', label: 'glance (springs back)', kind: 'glance' });
  trigger('sky', 'look up (sky)', () => { S.pitch = 90; syncCamera(); });
  trigger('horizon', 'back to the horizon', () => { S.pitch = 0; syncCamera(); });
  toggle('follow', 'face the direction of travel', () => S.follow, () => $('#follow').click());
  toggle('sun', 'hold the sun', () => S.sun, toggleSun);
  toggle('sharp', 'sharper photos', () => S.sharp, () => $('#sharp').click());
  // effects
  for (const p of PARAMS) {
    const label = p.label.replace(/ \(.*\)$/, '');
    if (p.step >= 1 && p.max === 1 && p.min === 0) choice(`fx.${p.id}`, label, [0, 1], () => Math.round(look[p.id]), (v) => setParam(p.id, v));
    else range(`fx.${p.id}`, label, p.min, p.max, () => look[p.id], (v) => setParam(p.id, p.step >= 1 ? Math.round(v / p.step) * p.step : v));
  }
  for (let i = 1; i <= 9; i++) trigger(`look.${i}`, `look ${i}`, () => applyPreset(Object.keys(allPresets())[i - 1]));
  // audio
  choice('kick', 'kick (off / 808 / 909)', KICKS, () => kick.type, setKick);
  range('kick.volume', 'kick volume', 0, 1, () => kick.volume, (v) => { kick.setVolume(v); saveKick(); refreshEffects(); });
  range('kick.offset', 'kick offset', -250, 250, () => kick.offset, (v) => { kick.offset = Math.round(v / 5) * 5; saveKick(); refreshEffects(); });
  // places, output
  for (let i = 1; i <= SLOT_COUNT; i++) trigger(`place.${i}`, `place ${i}`, () => goSlot(i));
  toggle('live', 'live', () => S.live, () => setLive(!S.live));
  trigger('record', 'record', toggleRecord);

  // What's on screen for each (the rest are learnable from the MIDI panel).
  const tag = { '#mix': 'mix', '#smooth': 'smooth', '#delay': 'delay', '#bmode': 'bmode', '#modes': 'blend', '#play': 'play',
    '#step-fwd': 'step.fwd', '#step-back': 'step.back', '#direction': 'dir', '#fps': 'speed', '#bpm': 'bpm', '#tempo': 'tempo',
    '#tap': 'tap', '#spb': 'spb', '#clock-source': 'clock', '#fov': 'fov', '#pitch': 'pitch', '#sky': 'sky', '#horizon': 'horizon',
    '#follow': 'follow', '#sun': 'sun', '#sharp': 'sharp', '#kick-type': 'kick', '#live': 'live', '#live-sw': 'live',
    '#record': 'record', '#record-2': 'record' };
  for (const [sel, id] of Object.entries(tag)) if ($(sel)) $(sel).dataset.learn = id;
}

// ---- the MIDI panel ----

function renderMidiPanel() {
  if (OUTPUT || $('#midi-panel').hidden) return;
  const now = performance.now();
  $('#midi-devices').replaceChildren(...(devices.size ? [...devices.entries()].map(([id, d]) => {
    const li = document.createElement('li');
    const roles = [];
    if (profiles.profile.devices?.some((x) => d.name.toLowerCase().includes(x.toLowerCase()))) roles.push(`profile "${profiles.current}"`);
    if (clock.input === id && external()) roles.push('clock in');
    li.innerHTML = `<span class="act${now - d.hit < 200 ? ' hit' : ''}">●</span><span class="n"></span><span class="dim"></span>`;
    li.children[1].textContent = d.name;
    li.children[2].textContent = roles.join(' · ');
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'dim', textContent: 'No MIDI device connected. The keyboard does everything; plug in a controller any time.' })]));
  $('#midi-last').textContent = lastMessage ? `last: ${lastMessage}` : 'last: nothing received yet';

  const sel = $('#midi-profile');
  sel.replaceChildren(...Object.keys(profiles.profiles).map((n) => Object.assign(document.createElement('option'), { value: n, textContent: n })));
  sel.value = profiles.current;
  const p = profiles.profile;
  $('#midi-profile-note').textContent = p.devices?.length ? `Switches in by itself when this controller connects: ${p.devices[0]}.` : 'Not tied to a controller yet: plug one in and click "use with connected controller".';

  const list = p.bindings.map((b, i) => ({ b, i, c: controls.get(b.to) })).sort((x, y) => (x.c?.label || x.b.to).localeCompare(y.c?.label || y.b.to));
  $('#midi-bindings').replaceChildren(...(list.length ? list.map(({ b, i, c }) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="src"></span><span class="to"></span><button class="mode"></button><button class="x" title="Remove">×</button>';
    li.querySelector('.src').textContent = describe(b.src);
    li.querySelector('.to').textContent = `→ ${c ? c.label : b.to}`;
    const mode = li.querySelector('.mode');
    if (b.src.startsWith('cc:')) {
      const modes = { abs: ['⇥', 'knob or fader (0–127)'], rel: ['∞', 'endless knob (nudges)'], press: ['●', 'button (press)'] };
      const [sym, what] = modes[b.mode || 'abs'];
      mode.textContent = sym;
      mode.title = `${what}: click to change`;
      mode.addEventListener('click', () => {
        const order = ['abs', 'rel', 'press'];
        b.mode = order[(order.indexOf(b.mode || 'abs') + 1) % 3];
        profiles.push();
        renderLearn();
      });
    } else mode.hidden = true;
    li.querySelector('.x').addEventListener('click', () => { profiles.unbind(i); renderLearn(); });
    li.addEventListener('mouseenter', () => { for (const el of document.querySelectorAll(`[data-learn="${CSS.escape(b.to)}"]`)) el.classList.add('pointed'); });
    li.addEventListener('mouseleave', () => { for (const el of document.querySelectorAll('.pointed')) el.classList.remove('pointed'); });
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'dim', textContent: 'No mappings in this profile yet: press M, click a control, move a knob.' })]));
}

if (!OUTPUT) {
  buildControls();
  const name = () => $('#midi-name').value.trim();
  $('#midi-btn').addEventListener('click', () => { closeProjectMenu(); renderMidiPanel(); });
  $('#midi-learn').addEventListener('click', () => setLearnMode(!learnMode));
  $('#midi-profile').addEventListener('change', (e) => { profiles.use(e.target.value); e.target.blur(); status(`MIDI profile: ${profiles.current}.`); renderLearn(); });
  $('#midi-new').addEventListener('click', () => {
    const n = name();
    if (!n || n in profiles.profiles) return status(n ? `There's already a profile called "${n}".` : 'Type a name for the new profile first.');
    profiles.create(n);
    status(`New, empty profile "${n}": press M to start mapping.`);
    renderLearn();
  });
  $('#midi-dup').addEventListener('click', () => {
    const n = name() || `${profiles.current} copy`;
    if (n in profiles.profiles) return status(`There's already a profile called "${n}".`);
    profiles.create(n, profiles.profile);
    renderLearn();
  });
  $('#midi-rename').addEventListener('click', async () => {
    const n = name();
    const from = profiles.current;
    if (!n || n === from || n in profiles.profiles) return status('Type a new name in the box first.');
    profiles.create(n, profiles.profile);
    await profiles.remove(from);
    profiles.use(n);
    status(`Renamed "${from}" to "${n}".`);
    renderLearn();
  });
  $('#midi-delete').addEventListener('click', async () => {
    if (!confirm(`Delete the MIDI profile "${profiles.current}"?`)) return;
    await profiles.remove(profiles.current);
    renderLearn();
  });
  $('#midi-reset').addEventListener('click', () => {
    if (!confirm('Put the MiniLab 3 profile back to how MIDIMap knew it?')) return;
    profiles.profiles['minilab 3'] = MINILAB();
    profiles.use('minilab 3');
    profiles.push();
    renderLearn();
  });
  $('#midi-for-device').addEventListener('click', () => {
    const names = [...devices.values()].map((d) => d.name);
    if (!names.length) return status('No MIDI controller connected.');
    for (const p of Object.values(profiles.profiles)) p.devices = (p.devices || []).filter((d) => !names.includes(d));
    profiles.profile.devices = [...new Set([...names, ...(profiles.profile.devices || [])])];
    profiles.push();
    status(`"${profiles.current}" now switches in when ${names.join(', ')} connects.`);
    renderLearn();
  });
  $('#midi-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(profiles.profile, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${profiles.current}.midimap-midi.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  $('#midi-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = JSON.parse(await file.text());
      if (!Array.isArray(p.bindings)) throw new Error('no mappings in it');
      let n = (p.name || file.name.replace(/\..*$/, '')).slice(0, 60);
      while (n in profiles.profiles) n = `${n} (imported)`.slice(0, 60);
      profiles.create(n, { ...p, version: PROFILE_VERSION });
      status(`Imported the MIDI profile "${n}".`);
      renderLearn();
    } catch (err) {
      status(`Could not import that file: ${err.message}`, true);
    }
  });
  for (const b of document.querySelectorAll('[data-arm]')) b.addEventListener('click', () => arm(b.dataset.arm));
  setInterval(renderMidiPanel, 150); // activity lights and the last message
  addEventListener('resize', placeBadges);
  document.addEventListener('scroll', placeBadges, true);
  for (const t of document.querySelectorAll('#insp-tabs [data-tab], #below-tabs [data-below]')) t.addEventListener('click', () => setTimeout(placeBadges, 0));
  profiles.syncNow().then(() => renderLearn()).catch(() => {});
  setInterval(() => profiles.syncNow().catch(() => {}), 30000);
  renderLearn();
  Object.assign(window.blend, { profiles, controls, onMidi });
}
