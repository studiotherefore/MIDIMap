// Experiment 2: two-layer blend. Plays a 360° Mapillary run like a film and
// blends a second layer over it: the same run delayed by N frames, or another
// 360° run of the same street matched photo by photo. Look straight up for the
// sky. Separate from the instrument; its MIDI mapping is fixed and simple.

/* global maplibregl */
import { readToken, makeGraph, TILES, imagesNearFromTiles, bearing, distance, Run } from '../lib/mapillary.js';
import { PanoBlend, BLEND_MODES } from './renderer.js';
import { DEFAULT_LOCATIONS, SLOTS } from '../../js/locations.js';

const $ = (s) => document.querySelector(s);
const MAX_B_METRES = 40;   // don't show another run's photo if it's further than this from layer A
const START_SLOT = '8';    // Karl-Marx-Allee: ten 360° runs, winter 2021 to spring 2026
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

// ---- state ----------------------------------------------------------------------

const S = {
  runA: null, runB: null, bMode: 'delay', delay: 8,
  index: 0, playing: false, dir: 1, fps: 3,
  mode: 1, mix: 0.5, smooth: 0, sharp: false,
  pitch: 0, fov: 90, follow: true, yawOffset: 0, glance: 0, travel: 0,
};
let shown = { a: null, b: null };  // photo ids currently on each layer
let lastStep = 0;
let stalledSince = 0;
window.blend = { S, renderer }; // for inspecting from the console

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

function tick(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (S.runA && S.runA.length) {
    if (S.playing && now - lastStep >= 1000 / S.fps) {
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
    const f = framesFor(S.index);
    show('a', f.a);
    show('b', f.b);

    // Face the direction of travel, turning smoothly rather than snapping each frame.
    const target = S.follow ? travelHeading(S.index) : 0;
    const diff = ((target - S.travel + 540) % 360) - 180;
    S.travel = (S.travel + diff * (1 - Math.exp(-dt * 3)) + 360) % 360;
  }
  renderer.render(
    { yaw: S.travel + S.yawOffset + S.glance, pitch: S.pitch, fov: S.fov },
    { mode: S.mode, mix: S.mix },
    S.smooth * (1000 / S.fps),
  );
  hud(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

let hudAt = 0;
function hud(now) {
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
  $('#hud-wait').textContent = stalledSince && now - stalledSince > 400 ? 'waiting for photos…' : '';
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

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
const mapIdle = () => new Promise((r) => (map.loaded() && map.areTilesLoaded() ? r() : map.once('idle', r)));

map.on('load', () => {
  map.addSource('mly', { type: 'vector', tiles: [`${TILES}?access_token=${encodeURIComponent(token)}`], minzoom: 0, maxzoom: 14 });
  map.addLayer({ id: 'pano-runs', type: 'line', source: 'mly', 'source-layer': 'sequence', filter: ['==', ['get', 'is_pano'], true],
    paint: { 'line-color': '#35d07f', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 17, 3] } });
  jumpTo(START_SLOT);
});

const here = Object.assign(document.createElement('div'), { style: 'width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:14px solid #ff5a36' });
const marker = new maplibregl.Marker({ element: here, rotationAlignment: 'map' });
let listedAt = null;
setInterval(() => {
  const a = S.runA && S.runA.at(S.index);
  if (!a) return;
  marker.setLngLat(a).setRotation(S.travel + S.yawOffset + S.glance).addTo(map);
  if (!map.getBounds().contains(a)) map.easeTo({ center: a });
  if (!listedAt || distance(listedAt, a) > 40) {
    listedAt = a;
    listOtherRuns();
  }
}, 400);

async function openNear(lngLat, metres) {
  await mapIdle();
  const [img] = imagesNearFromTiles(map, lngLat, metres, (p) => p.is_pano);
  if (!img) return status(`No 360° photo within ${metres} m of that spot. Try a green line.`);
  listedAt = null;
  await startRun(img.sequence, img.id);
}

map.on('click', (e) => (map.getZoom() < 14 ? map.easeTo({ center: e.lngLat, zoom: 16 }) : openNear(e.lngLat, 30)));

function jumpTo(slot) {
  const loc = DEFAULT_LOCATIONS[slot];
  map.jumpTo({ center: [loc.lng, loc.lat], zoom: 16 });
  openNear(loc, 80);
}
$('#jump').replaceChildren(...SLOTS.map((s) => Object.assign(document.createElement('option'), { value: s, textContent: `${s}: ${DEFAULT_LOCATIONS[s].name}` })));
$('#jump').value = START_SLOT;
$('#jump').addEventListener('change', () => jumpTo($('#jump').value));

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

const togglePlay = () => { S.playing = !S.playing; lastStep = 0; sync(); };
const step = (d) => { if (S.runA) { S.index = (S.index + d + S.runA.length) % S.runA.length; prefetch(S.index); } };
$('#play').addEventListener('click', togglePlay);
$('#reverse').addEventListener('click', () => { S.dir = -S.dir; shown.b = null; sync(); });
$('#sky').addEventListener('click', () => { S.pitch = 90; });
$('#horizon').addEventListener('click', () => { S.pitch = 0; });

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
  else if (e.code === 'ArrowUp') { e.preventDefault(); S.pitch = 90; }
  else if (e.code === 'ArrowDown') { e.preventDefault(); S.pitch = 0; }
  else if (e.code === 'KeyR') { S.dir = -S.dir; shown.b = null; sync(); }
  else if (e.code === 'KeyH') $('#panel').hidden = !$('#panel').hidden;
  else if (/^Digit[1-8]$/.test(e.code)) { S.mode = +e.code.slice(5) - 1; sync(); }
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

function onMidi([st, a, b]) {
  const type = st & 0xf0;
  if (type === 0xb0) {
    const v = b / 127;
    if (a === 1) S.pitch = v * 90;                               // mod strip: horizon → sky
    else if (a === 74) S.mix = v;                                // knob 1
    else if (a === 71) { S.delay = Math.round(v * 40); shown.b = null; } // knob 2
    else if (a === 76) S.smooth = v;                             // knob 3
    else if (a === 77) S.fps = Math.max(0.5, Math.round(v * 24) / 2); // knob 4
    else if (a === 114) S.yawOffset += (b - 64) * 3;             // main knob (endless): turn
    else if (a === 82) S.fov = 30 + v * 100;                     // fader 1
    else return;
    sync();
  } else if (type === 0xe0) {
    S.glance = (((b << 7) | a) / 16383 - 0.5) * 180;             // pitch strip: glance ±90°, springs back
  } else if (type === 0xc0) {
    S.mode = a % BLEND_MODES.length;                             // pads 1–8
    sync();
  } else if (type === 0x90 && b > 0 && !S.playing) {
    step(S.dir);                                                 // keys: step a frame
  }
}

if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then((access) => {
    const attach = () => {
      const names = [];
      for (const input of access.inputs.values()) {
        if (input.state === 'disconnected') continue;
        input.onmidimessage = (m) => onMidi(m.data);
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
