// Experiment 1: a Mapillary explorer. A map of Mapillary coverage, a street-level
// viewer, and for the current photo: when and how it was captured, every other
// capture run of the same spot (for "historical ghosting"), and whether the
// browser may read its pixels (which decides how far colour/blend work can go).
// Deliberately separate from the instrument: no MIDI, no recording.

/* global maplibregl, mapillary */
import { DEFAULT_LOCATIONS, SLOTS } from '../../js/locations.js';

const GRAPH = 'https://graph.mapillary.com';
const TILES = 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}';
const NEARBY_METRES = 15;
const CLICK_METRES = 30;
const JUMP_METRES = 150;
const COLOURS = { pano: '#35d07f', flat: '#4ea1ff' };
const YEAR_RAMP = ['#3b4cc0', '#8db0fe', '#f7d25c', '#f06b3c', '#b40426'];
const START = DEFAULT_LOCATIONS['8']; // Karl-Marx-Allee, Berlin: dozens of capture runs since 2015

const $ = (s) => document.querySelector(s);

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').className = error ? 'error' : '';
}

// ---- token ------------------------------------------------------------------
// Same place as the Maps key: config.local.json locally, a Cloudflare secret online.

async function readToken() {
  try {
    const res = await fetch('/config.local.json', { cache: 'no-store' });
    if (res.ok) return (await res.json()).mapillaryToken || '';
  } catch {
    /* no config */
  }
  return '';
}

const token = await readToken();
if (!token) {
  status('No Mapillary token found. Add "mapillaryToken" to config.local.json (locally) or the MAPILLARY_TOKEN secret (Cloudflare).', true);
  throw new Error('no Mapillary token');
}

// Mapillary's API fails intermittently (HTTP 500/503), so retry a few times.
async function graph(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
    const res = await fetch(url);
    if (res.ok) return res.json();
    last = res.status;
    if (res.status < 500) break;
  }
  throw new Error(`Mapillary answered ${last} for ${path}`);
}

// ---- geometry -----------------------------------------------------------------

function bbox({ lng, lat }, metres) {
  const dLat = metres / 111320;
  const dLng = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((n) => n.toFixed(6)).join(',');
}

function distance(a, b) {
  const x = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const y = (b.lat - a.lat) * 111320;
  return Math.hypot(x, y);
}

const toLngLat = (geometry) => ({ lng: geometry.coordinates[0], lat: geometry.coordinates[1] });

// Photos near a point, nearest first, from the map's coverage tiles. Those list
// every photo (id, date, run, 360/flat); the API's search only returns a sample,
// and fails now and then, so it's only a fallback while tiles are still loading.
function imagesNear(lngLat, metres) {
  const seen = new Set();
  const found = [];
  for (const f of map.querySourceFeatures('mly', { sourceLayer: 'image' })) {
    const { id, captured_at, is_pano, sequence_id } = f.properties;
    if (seen.has(id)) continue; // features repeat across tile edges
    seen.add(id);
    const [lng, lat] = f.geometry.coordinates;
    const m = distance(lngLat, { lng, lat });
    if (m <= metres) found.push({ id: String(id), captured_at, is_pano, sequence: sequence_id, metres: m });
  }
  return found.sort((a, b) => a.metres - b.metres);
}

async function imagesNearFromApi(lngLat, metres) {
  const { data } = await graph('images', { fields: 'id,geometry,captured_at,is_pano,sequence', bbox: bbox(lngLat, metres), limit: 500 });
  return data.map((img) => ({ ...img, metres: distance(lngLat, toLngLat(img.geometry)) }))
    .filter((img) => img.metres <= metres)
    .sort((a, b) => a.metres - b.metres);
}

// Resolves once the map has drawn everything for the current view.
const mapIdle = () => new Promise((r) => (map.loaded() && map.areTilesLoaded() ? r() : map.once('idle', r)));

// ---- time ---------------------------------------------------------------------
// Mapillary stores capture time in UTC. Local time is estimated from longitude
// (solar time), which is good enough to tell a night run from a morning one.

function captureTime(ms, { lng, lat }) {
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const hours = (d.getUTCHours() + d.getUTCMinutes() / 60 + lng / 15 + 24) % 24;
  const hh = String(Math.floor(hours)).padStart(2, '0');
  const mm = String(Math.floor((hours % 1) * 60)).padStart(2, '0');
  return { date, local: `${hh}:${mm}`, season: season(d.getUTCMonth(), lat) };
}

// Northern-hemisphere seasons, flipped south of the equator.
function season(month, lat) {
  const north = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][month];
  if (lat >= 0) return north;
  return { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' }[north];
}

// ---- map ----------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.85, 'raster-brightness-max': 0.5 } }],
  },
  center: [START.lng, START.lat],
  zoom: 16,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
// The map only measures its box at start; keep it filling the box when the layout changes.
new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));

const colourExpr = {
  pano: ['case', ['==', ['get', 'is_pano'], true], COLOURS.pano, COLOURS.flat],
  year: ['interpolate', ['linear'], ['get', 'captured_at'],
    Date.UTC(2014, 0), YEAR_RAMP[0], Date.UTC(2017, 0), YEAR_RAMP[1], Date.UTC(2020, 0), YEAR_RAMP[2],
    Date.UTC(2023, 0), YEAR_RAMP[3], Date.UTC(2026, 0), YEAR_RAMP[4]],
};
const LAYERS = ['mly-overview', 'mly-sequences', 'mly-images'];

map.on('load', () => {
  map.addSource('mly', { type: 'vector', tiles: [`${TILES}?access_token=${encodeURIComponent(token)}`], minzoom: 0, maxzoom: 14 });
  map.addLayer({ id: 'mly-overview', type: 'circle', source: 'mly', 'source-layer': 'overview', maxzoom: 6,
    paint: { 'circle-radius': 2, 'circle-color': colourExpr.pano, 'circle-opacity': 0.7 } });
  map.addLayer({ id: 'mly-sequences', type: 'line', source: 'mly', 'source-layer': 'sequence', minzoom: 6,
    paint: { 'line-color': colourExpr.pano, 'line-opacity': 0.75,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 2, 18, 4] } });
  map.addLayer({ id: 'mly-images', type: 'circle', source: 'mly', 'source-layer': 'image', minzoom: 16,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 2, 19, 5], 'circle-color': colourExpr.pano,
      'circle-stroke-width': 0.5, 'circle-stroke-color': '#000' } });
  applyColour();
  applyFilter();
});

function applyColour() {
  const mode = $('#colour-by').value;
  map.setPaintProperty('mly-overview', 'circle-color', colourExpr[mode]);
  map.setPaintProperty('mly-sequences', 'line-color', colourExpr[mode]);
  map.setPaintProperty('mly-images', 'circle-color', colourExpr[mode]);
  $('#legend').innerHTML = mode === 'pano'
    ? `<span><i class="swatch" style="background:${COLOURS.pano}"></i>360°</span><span><i class="swatch" style="background:${COLOURS.flat}"></i>flat</span>`
    : '<span>2014<i class="ramp"></i>2026</span>';
}

function applyFilter() {
  const pano = $('#show-pano').checked;
  const flat = $('#show-flat').checked;
  const filter = pano && flat ? null : ['==', ['get', 'is_pano'], pano];
  for (const id of LAYERS) map.setFilter(id, pano || flat ? filter : ['==', 1, 0]);
}

$('#colour-by').addEventListener('change', () => map.isStyleLoaded() && applyColour());
$('#show-pano').addEventListener('change', () => map.isStyleLoaded() && applyFilter());
$('#show-flat').addEventListener('change', () => map.isStyleLoaded() && applyFilter());

const here = document.createElement('div');
here.className = 'here';
const marker = new maplibregl.Marker({ element: here, rotationAlignment: 'map' });

map.on('click', async (e) => {
  if (map.getZoom() < 14) {
    map.easeTo({ center: e.lngLat, zoom: 16 });
    status('Zoomed in. Click on a coloured line to open that spot.');
    return;
  }
  await openNear(e.lngLat, CLICK_METRES);
});
map.on('mouseenter', 'mly-sequences', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'mly-sequences', () => { map.getCanvas().style.cursor = ''; });

// ---- viewer -------------------------------------------------------------------

const viewer = new mapillary.Viewer({
  accessToken: token,
  container: 'viewer',
  component: { cover: false },
});

// Handle for inspecting the experiment from the browser console.
window.explorer = { map, viewer };

async function openNear(lngLat, metres) {
  status('Looking for the nearest photo…');
  try {
    await mapIdle();
    let [nearest] = imagesNear(lngLat, metres);
    if (!nearest) [nearest] = await imagesNearFromApi(lngLat, metres);
    if (!nearest) return status(`No Mapillary photo within ${metres} m of that spot. Try a coloured line.`);
    await viewer.moveTo(nearest.id);
  } catch (err) {
    status(`Could not open that spot: ${err.message}`, true);
  }
}

viewer.on('image', ({ image }) => {
  marker.setLngLat(image.lngLat).addTo(map);
  if (!map.getBounds().contains(image.lngLat)) map.easeTo({ center: image.lngLat });
  describe(image.id, image.lngLat);
});
viewer.on('bearing', ({ bearing }) => marker.setRotation(bearing));

// ---- info panel ------------------------------------------------------------------

let describing = 0;

async function describe(id, lngLat) {
  const ticket = ++describing;
  status('');
  try {
    const img = await graph(id, { fields: 'id,captured_at,is_pano,camera_type,make,model,sequence,creator,thumb_256_url' });
    if (ticket !== describing) return;
    renderCurrent(img, lngLat);
    checkPixels(img.thumb_256_url, ticket);
    await mapIdle();
    if (ticket !== describing) return;
    const runs = renderNearby(imagesNear(lngLat, NEARBY_METRES), img.sequence, lngLat);
    addCameras(runs, ticket);
  } catch (err) {
    status(`Could not read this photo's details: ${err.message}`, true);
  }
}

function renderCurrent(img, lngLat) {
  const t = captureTime(img.captured_at, lngLat);
  const camera = [img.make, img.model].filter(Boolean).join(' ') || 'unknown camera';
  const rows = [
    ['captured', `${t.date} · about ${t.local} local · ${t.season}`],
    ['kind', img.is_pano ? '360° panorama' : `flat photo (${img.camera_type || 'perspective'})`],
    ['camera', camera],
    ['by', img.creator?.username || 'unknown'],
    ['sequence', `${img.sequence}`],
    ['pixel access', '<span id="pixels">checking…</span>'],
  ];
  $('#current-details').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#current').hidden = false;
}

// Can the page read this photo's pixels? If yes, real image processing
// (shaders, true blending) is possible later; if not, only CSS filters.
function checkPixels(url, ticket) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (ticket !== describing) return;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      $('#pixels').innerHTML = `<i class="avg" style="background:rgb(${r},${g},${b})"></i>yes (this is the photo's average colour)`;
    } catch {
      $('#pixels').textContent = 'no (the browser blocks reading these pixels)';
    }
  };
  img.onerror = () => { if (ticket === describing) $('#pixels').textContent = 'could not load the thumbnail'; };
  img.src = url;
}

function renderNearby(near, currentSequence, lngLat) {
  // One row per capture run: its closest photo to this spot.
  const runs = new Map();
  for (const img of near) if (!runs.has(img.sequence)) runs.set(img.sequence, img);
  const list = [...runs.values()].sort((a, b) => a.captured_at - b.captured_at);
  if (!list.length) {
    $('#nearby-title').textContent = 'Other captures here: none within 15 m';
    $('#nearby-list').replaceChildren();
    $('#nearby').hidden = false;
    return list;
  }
  $('#nearby-title').textContent = `Other captures here: ${list.length} run${list.length === 1 ? '' : 's'}`;
  $('#nearby-list').replaceChildren(...list.map((img) => {
    const t = captureTime(img.captured_at, lngLat);
    const li = document.createElement('li');
    if (img.sequence === currentSequence) li.className = 'current';
    li.innerHTML = `<span>${t.date}</span><span class="dim">${t.local} ${t.season}</span>` +
      `<span class="${img.is_pano ? 'kind-pano' : 'kind-flat'}">${img.is_pano ? '360°' : 'flat'}</span>` +
      `<span class="dim camera" data-id="${img.id}">…</span>` +
      `<span class="dim">${Math.round(img.metres)} m</span>`;
    li.addEventListener('click', () => viewer.moveTo(img.id).catch((err) => status(err.message, true)));
    return li;
  }));
  $('#nearby').hidden = false;
  return list;
}

// Camera makes aren't in the map tiles; fetch them for the listed runs in one request.
async function addCameras(list, ticket) {
  if (!list.length) return;
  try {
    const { data } = await graph('images', { image_ids: list.map((i) => i.id).join(','), fields: 'id,make,model' });
    if (ticket !== describing) return;
    const byId = new Map(data.map((d) => [d.id, [d.make, d.model].filter(Boolean).join(' ')]));
    for (const el of document.querySelectorAll('#nearby-list .camera')) el.textContent = byId.get(el.dataset.id) || '—';
  } catch {
    for (const el of document.querySelectorAll('#nearby-list .camera')) el.textContent = '—';
  }
}

// ---- jump list ------------------------------------------------------------------

$('#jump').replaceChildren(...SLOTS.map((s) => {
  const o = document.createElement('option');
  o.value = s;
  o.textContent = `${s}: ${DEFAULT_LOCATIONS[s].name}`;
  return o;
}));
$('#jump').value = '8';
$('#jump').addEventListener('change', () => {
  const loc = DEFAULT_LOCATIONS[$('#jump').value];
  map.jumpTo({ center: [loc.lng, loc.lat], zoom: 16 });
  openNear({ lng: loc.lng, lat: loc.lat }, JUMP_METRES);
});

openNear({ lng: START.lng, lat: START.lat }, JUMP_METRES);
