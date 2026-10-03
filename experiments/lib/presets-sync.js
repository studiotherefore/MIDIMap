// Presets (and, for the editor, projects) shared through Cloudflare (D1 via
// src/worker.js). Anyone can read;
// saving and deleting need the sync key. On this Mac (localhost:8000 and the
// MIDIMap app) the key comes from config.local.json; online, it's pasted once
// per browser and kept in that browser.

const LIVE = 'https://midimap.studiotherefore.workers.dev';
const KEY_STORE = 'midimap.syncKey.v1';
const BASE = location.origin === LIVE ? '' : LIVE;

async function call(api, method, path = '', key, body) {
  const res = await fetch(`${BASE}${api}${path}`, {
    method,
    headers: { ...(key && { 'x-midimap-key': key }), ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
    cache: 'no-store',
  });
  if (res.status === 401) throw Object.assign(new Error('The sync key is wrong.'), { wrongKey: true });
  if (!res.ok) throw new Error(`The sync service answered ${res.status}`);
  return res.json();
}

export class PresetSync {
  // api: '/api/presets' (looks) or '/api/projects' (editor projects); both use the same sync key.
  constructor(api = '/api/presets') {
    this.api = api;
    this.key = '';
    this.keySource = null; // 'file' (this Mac) | 'browser' (pasted) | null
  }

  async init() {
    try {
      const res = await fetch('/config.local.json', { cache: 'no-store' });
      if (res.ok) this.key = (await res.json()).presetsKey || '';
    } catch {
      /* not local */
    }
    if (this.key) {
      this.keySource = 'file';
    } else {
      try {
        this.key = localStorage.getItem(KEY_STORE) || '';
      } catch {
        this.key = '';
      }
      if (this.key) this.keySource = 'browser';
    }
    return this;
  }

  get canWrite() {
    return Boolean(this.key);
  }

  list() {
    return call(this.api, 'GET');
  }

  save(name, item) {
    return call(this.api, 'PUT', `/${encodeURIComponent(name)}`, this.key, item);
  }

  remove(name) {
    return call(this.api, 'DELETE', `/${encodeURIComponent(name)}`, this.key);
  }

  // Check a pasted key (deleting a preset that can't exist needs the key but changes nothing).
  async useKey(key) {
    await call(this.api, 'DELETE', `/${encodeURIComponent('__key check__')}`, key.trim());
    this.key = key.trim();
    this.keySource = 'browser';
    try {
      localStorage.setItem(KEY_STORE, this.key);
    } catch {
      /* this session only */
    }
  }

  forgetKey() {
    this.key = '';
    this.keySource = null;
    try {
      localStorage.removeItem(KEY_STORE);
    } catch {
      /* nothing stored */
    }
  }
}
