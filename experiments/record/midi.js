// MIDI controller profiles (EDITOR-PLAN.md, phase 4). A profile belongs to a
// controller, not to a project: it's a list of bindings "this knob/pad/key →
// that control", shared by every project and synced like looks and projects.
// When a controller connects, the profile that lists it switches in.
//
//   profile = { version, name, devices: [input names], bindings: [binding] }
//   binding = { src, to, mode?, range? }
//     src:   'cc:<ch>:<n>' | 'note:<ch>:<n>' | 'pc:<ch>:<n>' | 'pb:<ch>'
//            (<ch> 1–16 or '*'; for notes and programs <n> may be '*')
//     to:    a control id (see the registry in app.js)
//     mode:  'abs' (0–127 → the control's range) or 'rel' (an endless knob:
//            64 ± steps); buttons, pads and keys just press
//     range: optional [min, max] instead of the control's own

import { ProjectStore } from './project.js';

export const PROFILE_VERSION = 1;
const STORE = 'midimap.editor.midi.v1';        // { current, profiles } in this browser
const OLD_LEARN = 'midimap.fx.learn.v1';       // experiment 3's learned effect knobs ('ch:cc' → param)

// Raw bytes → { type, ch, n, v } (v: 0–127; pitch bend also v14: 0–16383).
export function parse([st, a = 0, b = 0]) {
  const ch = (st & 0x0f) + 1;
  switch (st & 0xf0) {
    case 0xb0: return { type: 'cc', ch, n: a, v: b };
    case 0x90: return b > 0 ? { type: 'note', ch, n: a, v: b } : { type: 'off', ch, n: a, v: 0 };
    case 0x80: return { type: 'off', ch, n: a, v: 0 };
    case 0xc0: return { type: 'pc', ch, n: a, v: 127 };
    case 0xe0: { const v14 = (b << 7) | a; return { type: 'pb', ch, n: 0, v: v14 >> 7, v14 }; }
    default: return null; // aftertouch etc.: ignored
  }
}

export const srcOf = (m) => (m.type === 'pb' ? `pb:${m.ch}` : `${m.type}:${m.ch}:${m.n}`);

export function matches(src, m) {
  const [type, ch, n] = src.split(':');
  if (type !== m.type) return false;
  if (ch !== '*' && +ch !== m.ch) return false;
  return type === 'pb' || n === '*' || +n === m.n;
}

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function describe(src) {
  const [type, ch, n] = src.split(':');
  const on = ch === '*' ? '' : ` · ch ${ch}`;
  if (type === 'cc') return `cc ${n}${on}`;
  if (type === 'note') return n === '*' ? `any key${on}` : `note ${NOTE[n % 12]}${Math.floor(n / 12) - 1}${on}`;
  if (type === 'pc') return n === '*' ? `any pad${on}` : `pad / program ${+n + 1}${on}`;
  if (type === 'pb') return `pitch bend${on}`;
  return src;
}
export const shortName = (src) => {
  const [type, , n] = src.split(':');
  return type === 'cc' ? `cc${n}` : type === 'note' ? (n === '*' ? 'keys' : `n${n}`) : type === 'pc' ? (n === '*' ? 'pads' : `pad${+n + 1}`) : 'bend';
};

// The Arturia MiniLab 3, as experiment 3 knew it (recorded with a CoreMIDI
// listener, 2026-09): pads send program changes 0–7, the main knob is endless.
// Knobs 5–8 and faders 2–4 are Arturia's factory numbers, guessed.
export const MINILAB = () => ({
  version: PROFILE_VERSION,
  name: 'minilab 3',
  devices: ['Minilab3 MIDI', 'MiniLab 3', 'Minilab3'],
  bindings: [
    { src: 'cc:*:1', to: 'pitch', mode: 'abs', range: [0, 90] },   // mod strip: horizon → sky
    { src: 'cc:*:74', to: 'mix', mode: 'abs' },                    // knob 1
    { src: 'cc:*:71', to: 'delay', mode: 'abs' },                  // knob 2
    { src: 'cc:*:76', to: 'smooth', mode: 'abs' },                 // knob 3
    { src: 'cc:*:77', to: 'speed', mode: 'abs' },                  // knob 4: speed, or BPM when locked
    { src: 'cc:*:114', to: 'turn', mode: 'rel' },                  // main knob (endless)
    { src: 'cc:*:82', to: 'fov', mode: 'abs' },                    // fader 1
    { src: 'pb:*', to: 'glance', mode: 'abs' },                    // pitch strip
    ...Array.from({ length: 8 }, (_, i) => ({ src: `pc:*:${i}`, to: `place.${i + 1}` })), // pads 1–8
    { src: 'note:*:*', to: 'step.paused' },                        // keys: step a photo while paused
    { src: 'cc:1:93', to: 'fx.echo', mode: 'abs' },
    { src: 'cc:1:18', to: 'fx.bloom', mode: 'abs' },
    { src: 'cc:1:19', to: 'fx.recall', mode: 'abs' },
    { src: 'cc:1:16', to: 'fx.tint', mode: 'abs' },
    { src: 'cc:1:83', to: 'fx.blur', mode: 'abs' },
    { src: 'cc:1:85', to: 'fx.smear', mode: 'abs' },
    { src: 'cc:1:17', to: 'fx.grain', mode: 'abs' },
  ],
});

export const EMPTY = (name) => ({ version: PROFILE_VERSION, name, devices: [], bindings: [] });

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

export class Profiles {
  constructor() {
    const saved = read(STORE, null);
    if (saved?.profiles && Object.keys(saved.profiles).length) {
      this.profiles = saved.profiles;
      this.current = saved.profiles[saved.current] ? saved.current : Object.keys(saved.profiles)[0];
    } else {
      // First run: the MiniLab profile, plus whatever was learned in experiment 3.
      const m = MINILAB();
      for (const [key, param] of Object.entries(read(OLD_LEARN, {}))) {
        const [ch, cc] = key.split(':');
        const to = param.startsWith('kick.') ? param : `fx.${param}`;
        m.bindings = m.bindings.filter((b) => b.to !== to && b.src !== `cc:${ch}:${cc}`);
        m.bindings.push({ src: `cc:${ch}:${cc}`, to, mode: 'abs' });
      }
      this.profiles = { [m.name]: m };
      this.current = m.name;
      this.save();
    }
    // Synced like projects (same sync key); this browser's copy is the working one.
    this.store = new ProjectStore({ api: '/api/midi', field: 'profiles', remoteCache: 'midimap.editor.midi.remote.v1', localOnly: 'midimap.editor.midi.local.v1' });
    this.ready = this.store.init();
  }

  get profile() {
    return this.profiles[this.current];
  }

  save() {
    write(STORE, { current: this.current, profiles: this.profiles });
  }

  // Upload this browser's profiles and take in ones saved elsewhere (newest wins by name).
  async syncNow() {
    await this.ready;
    await this.store.refresh();
    for (const [name, p] of Object.entries(this.store.all)) {
      if (!this.profiles[name] || (p.savedAt || 0) > (this.profiles[name].savedAt || 0)) this.profiles[name] = p;
    }
    this.save();
  }

  async push(name = this.current) {
    const p = this.profiles[name];
    p.savedAt = Date.now();
    this.save();
    try { await this.ready; return await this.store.save(name, p); } catch { return 'this browser only'; }
  }

  // The bindings that answer this message.
  find(m) {
    return this.profile.bindings.filter((b) => matches(b.src, m));
  }

  // Bind a source to a control: the source leaves any other control; the control keeps only this source.
  bind(to, src, mode) {
    const p = this.profile;
    p.bindings = p.bindings.filter((b) => b.src !== src && b.to !== to);
    const b = { src, to, ...(mode && { mode }) };
    p.bindings.push(b);
    this.push();
    return b;
  }

  unbind(index) {
    this.profile.bindings.splice(index, 1);
    this.push();
  }

  bindingsFor(to) {
    return this.profile.bindings.filter((b) => b.to === to);
  }

  use(name) {
    if (!this.profiles[name]) return false;
    this.current = name;
    this.save();
    return true;
  }

  create(name, from = null) {
    this.profiles[name] = from ? { ...structuredClone(from), name } : EMPTY(name);
    this.current = name;
    this.push(name);
  }

  async remove(name) {
    delete this.profiles[name];
    if (!Object.keys(this.profiles).length) this.profiles = { 'minilab 3': MINILAB() };
    if (this.current === name) this.current = Object.keys(this.profiles)[0];
    this.save();
    await this.store.remove(name).catch(() => {});
  }

  // The profile made for one of these connected inputs, if any.
  forDevices(names) {
    return Object.values(this.profiles).find((p) => (p.devices || []).some((d) => names.some((n) => n.toLowerCase().includes(d.toLowerCase()))));
  }
}
