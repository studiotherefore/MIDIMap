// Shared Mapillary helpers for the experiments (token, API with retries,
// geometry). Lessons from experiment 1 are baked in: the search API returns a
// sample and fails now and then, so "what's here" comes from the coverage
// tiles, and every API call retries.

export const GRAPH = 'https://graph.mapillary.com';
export const TILES = 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}';

// Same place as the Maps key: config.local.json locally, a Cloudflare secret online.
export async function readToken() {
  try {
    const res = await fetch('/config.local.json', { cache: 'no-store' });
    if (res.ok) return (await res.json()).mapillaryToken || '';
  } catch {
    /* no config */
  }
  return '';
}

export function makeGraph(token) {
  return async function graph(path, params = {}) {
    const url = new URL(`${GRAPH}/${path}`);
    url.searchParams.set('access_token', token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
      const res = await fetch(url);
      if (res.ok) return res.json();
      last = res.status;
      if (res.status < 500) break;
    }
    throw new Error(`Mapillary answered ${last} for ${path}`);
  };
}

export function distance(a, b) {
  const x = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const y = (b.lat - a.lat) * 111320;
  return Math.hypot(x, y);
}

// Compass bearing from a to b, degrees clockwise from north.
export function bearing(a, b) {
  const x = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
  const y = b.lat - a.lat;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

export const toLngLat = (geometry) => ({ lng: geometry.coordinates[0], lat: geometry.coordinates[1] });

// Every photo near a point, nearest first, from the map's loaded coverage tiles.
export function imagesNearFromTiles(map, lngLat, metres, filter = () => true) {
  const seen = new Set();
  const found = [];
  for (const f of map.querySourceFeatures('mly', { sourceLayer: 'image' })) {
    const p = f.properties;
    if (seen.has(p.id) || !filter(p)) continue;
    seen.add(p.id);
    const [lng, lat] = f.geometry.coordinates;
    const m = distance(lngLat, { lng, lat });
    if (m <= metres) found.push({ id: String(p.id), captured_at: p.captured_at, is_pano: p.is_pano, sequence: p.sequence_id, lng, lat, metres: m });
  }
  return found.sort((a, b) => a.metres - b.metres);
}

// A capture run: its photos in order, with details fetched in chunks on demand.
const FIELDS = 'id,geometry,computed_geometry,compass_angle,computed_compass_angle,captured_at,is_pano,thumb_1024_url,thumb_2048_url';

export class Run {
  constructor(graph, sequenceId) {
    this.graph = graph;
    this.id = sequenceId;
    this.ids = [];
    this.details = new Map(); // id -> { lng, lat, compass, captured_at, url1024, url2048 }
    this._pending = new Map(); // chunk index -> promise
  }

  async load() {
    const { data } = await this.graph('image_ids', { sequence_id: this.id });
    this.ids = data.map((d) => d.id);
    return this;
  }

  get length() {
    return this.ids.length;
  }

  // Details for photos [from, to), fetched 50 at a time.
  async ensure(from, to) {
    const CHUNK = 50;
    const jobs = [];
    for (let c = Math.floor(Math.max(0, from) / CHUNK); c * CHUNK < Math.min(to, this.ids.length); c++) {
      if (!this._pending.has(c)) {
        const ids = this.ids.slice(c * CHUNK, (c + 1) * CHUNK);
        this._pending.set(c, this.graph('images', { image_ids: ids.join(','), fields: FIELDS }).then(({ data }) => {
          for (const d of data) {
            const g = toLngLat(d.computed_geometry || d.geometry);
            this.details.set(d.id, {
              ...g,
              compass: d.computed_compass_angle ?? d.compass_angle ?? 0,
              captured_at: d.captured_at,
              is_pano: d.is_pano,
              url1024: d.thumb_1024_url,
              url2048: d.thumb_2048_url,
            });
          }
        }).catch((err) => {
          this._pending.delete(c); // allow a later retry
          throw err;
        }));
      }
      jobs.push(this._pending.get(c));
    }
    await Promise.all(jobs);
  }

  at(index) {
    return this.details.get(this.ids[index]);
  }

  // Index of this run's photo nearest to a point (only among loaded details).
  nearestIndex(lngLat) {
    let best = -1;
    let bestM = Infinity;
    this.ids.forEach((id, i) => {
      const d = this.details.get(id);
      if (!d) return;
      const m = distance(lngLat, d);
      if (m < bestM) {
        bestM = m;
        best = i;
      }
    });
    return { index: best, metres: bestM };
  }
}
