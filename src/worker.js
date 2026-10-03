// Cloudflare Worker for MIDIMap. Serves the site's files, answers the page's
// key-file request (config.local.json, the same path as a local setup) from
// secrets, and keeps saved looks (presets) and editor projects in a D1 database.
//   npx wrangler secret put MAPS_API_KEY       Google Maps key (the instrument)
//   npx wrangler secret put MAPILLARY_TOKEN    Mapillary client token (experiments)
//   npx wrangler secret put PRESETS_KEY        sync key: required to save or delete presets and projects

const KEY_PATH = '/config.local.json';
// Two collections with the same rules: anyone can read, writing needs the sync key.
const COLLECTIONS = {
  '/api/presets': { table: 'presets', field: 'presets', noun: 'preset', maxBytes: 20000 },
  '/api/projects': { table: 'projects', field: 'projects', noun: 'project', maxBytes: 200000 },
  '/api/midi': { table: 'midi_profiles', field: 'profiles', noun: 'MIDI profile', maxBytes: 50000 },
};
// Browser pages allowed to call the presets API from another address: the local copies.
const LOCAL_ORIGINS = new Set(['http://localhost:8000', 'http://localhost:8765']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === KEY_PATH) return keyFile(env);
    for (const [base, c] of Object.entries(COLLECTIONS)) {
      if (url.pathname === base || url.pathname.startsWith(`${base}/`)) return collection(request, env, url, base, c);
    }
    return env.ASSETS.fetch(request);
  },
};

function keyFile(env) {
  // Never the sync key: this file is public online.
  const config = {};
  if (env.MAPS_API_KEY) config.mapsApiKey = env.MAPS_API_KEY;
  if (env.MAPILLARY_TOKEN) config.mapillaryToken = env.MAPILLARY_TOKEN;
  // Nothing set: 404, and the page falls back to a key saved in the browser.
  if (!Object.keys(config).length) return new Response('Not found', { status: 404 });
  return json(config, 200, { 'cache-control': 'no-store' });
}

// GET    /api/presets          all presets: { presets: { name: preset }, updated: { name: ms } }
// PUT    /api/presets/<name>   save one (body: the preset as JSON); needs the sync key
// DELETE /api/presets/<name>   delete one; needs the sync key
// The same for /api/projects (field "projects"; bodies up to 200 kB) and
// /api/midi (controller profiles, field "profiles"; up to 50 kB).
async function collection(request, env, url, base, { table, field, noun, maxBytes }) {
  const origin = request.headers.get('origin');
  const cors = LOCAL_ORIGINS.has(origin) ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, PUT, DELETE',
    'access-control-allow-headers': 'content-type, x-midimap-key',
    vary: 'origin',
  } : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT name, data, updated_at FROM ${table}`).all();
    const out = { [field]: {}, updated: {} };
    for (const r of results) {
      out[field][r.name] = JSON.parse(r.data);
      out.updated[r.name] = r.updated_at;
    }
    return json(out, 200, { ...cors, 'cache-control': 'no-store' });
  }

  if (!(await sameSecret(request.headers.get('x-midimap-key') || '', env.PRESETS_KEY || ''))) {
    return json({ error: 'The sync key is missing or wrong.' }, 401, cors);
  }
  const name = decodeURIComponent(url.pathname.slice(base.length + 1)).trim();
  if (!name || name.length > 60) return json({ error: `A ${noun} needs a name of up to 60 characters.` }, 400, cors);

  if (request.method === 'PUT') {
    const text = await request.text();
    let item;
    try {
      item = JSON.parse(text);
    } catch {
      item = null;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item) || text.length > maxBytes) {
      return json({ error: `That is not a ${noun}.` }, 400, cors);
    }
    await env.DB.prepare(`INSERT INTO ${table} (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .bind(name, JSON.stringify(item), Date.now()).run();
    return json({ saved: name }, 200, cors);
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM ${table} WHERE name = ?`).bind(name).run();
    return json({ deleted: name }, 200, cors);
  }
  return json({ error: 'Method not allowed.' }, 405, cors);
}

// Compare secrets without leaking how much of the guess was right.
async function sameSecret(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
