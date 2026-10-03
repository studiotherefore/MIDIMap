// Projects: the whole setup saved under a name (EDITOR-PLAN.md, phase 3).
// Shared through Cloudflare like looks (same sync key); a cached copy covers
// offline; projects saved where there's no sync key yet stay in this browser
// and are uploaded once there is one. Looks are NOT inside projects: they're a
// global library; a project keeps the effect values that were on.
//
// A project is one JSON document:
//   { version, name, savedAt, places, layers, effects, camera, playback,
//     tempo, audio, output, midi }
// `version` lets later phases add fields: migrate() upgrades older ones.

import { PresetSync } from '../experiments/lib/presets-sync.js';

export const PROJECT_VERSION = 1;
const REMOTE_CACHE = 'midimap.editor.projects.remote.v1';
const LOCAL_ONLY = 'midimap.editor.projects.local.v1';
const CURRENT = 'midimap.editor.current.v1'; // { name, draft } — the open project and unsaved changes

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

// Older projects become current ones here (nothing to do yet at version 1).
export function migrate(p) {
  if (!p || typeof p !== 'object' || typeof p.version !== 'number') throw new Error('That is not a MIDIMap project.');
  if (p.version > PROJECT_VERSION) throw new Error('That project was made by a newer MIDIMap: update this one first.');
  return p;
}

// What counts as "changed since saving": everything except where playback has got to.
export const fingerprint = (p) => JSON.stringify({ ...p, name: undefined, savedAt: undefined, playback: { ...p.playback, photo: undefined } });

export class ProjectStore {
  constructor() {
    this.sync = new PresetSync('/api/projects');
    this.remote = read(REMOTE_CACHE, {});
    this.updated = {};
    this.local = read(LOCAL_ONLY, {});
    this.offline = false;
  }

  async init() {
    await this.sync.init();
    return this;
  }

  get all() {
    return { ...this.remote, ...this.local };
  }

  isLocal(name) {
    return name in this.local;
  }

  async refresh() {
    try {
      const { projects, updated } = await this.sync.list();
      this.remote = projects;
      this.updated = updated || {};
      write(REMOTE_CACHE, this.remote);
      this.offline = false;
      if (this.sync.canWrite) for (const n of Object.keys(this.local)) await this.save(n, this.local[n]);
    } catch {
      this.offline = true; // keep the cached list
    }
  }

  // Returns where it went: 'shared' or 'this browser only'.
  async save(name, project) {
    if (this.sync.canWrite) {
      try {
        await this.sync.save(name, project);
        this.remote[name] = project;
        this.updated[name] = Date.now();
        delete this.local[name];
        write(REMOTE_CACHE, this.remote);
        write(LOCAL_ONLY, this.local);
        return 'shared';
      } catch (err) {
        if (err.wrongKey) throw err;
        // Offline: keep it here and upload later.
      }
    }
    this.local[name] = project;
    write(LOCAL_ONLY, this.local);
    return 'this browser only';
  }

  async remove(name) {
    if (name in this.local) {
      delete this.local[name];
      write(LOCAL_ONLY, this.local);
      return;
    }
    if (!this.sync.canWrite) throw new Error('Deleting a shared project needs the sync key in this browser (effects tab → looks).');
    await this.sync.remove(name);
    delete this.remote[name];
    write(REMOTE_CACHE, this.remote);
  }

  // The open project's name and any unsaved changes, kept across reloads.
  static current() {
    return read(CURRENT, { name: null, draft: null });
  }

  static setCurrent(name, draft) {
    write(CURRENT, { name, draft });
  }
}

export function download(project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${project.name || 'untitled'}.midimap.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
