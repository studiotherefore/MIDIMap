// Input router with "learn": normalises keyboard and Web MIDI events into
// sources, looks up the bound action, and dispatches by action type.

import { DEFAULT_BINDINGS, DEFAULTS_ADDED, DEFAULTS_VERSION } from './actions.js';
import { TOGGLE_KEY } from './virtual-midi.js';

const STORAGE_KEY = 'midimap.bindings.v1';
const VERSION_KEY = 'midimap.bindings.defaultsVersion';
const RELATIVE_KEY = 'midimap.relative.v1';

// Endless knobs (e.g. the MiniLab 3 main encoder) send 64 ± steps: 65 = one step up,
// 63 = one step down. A learn listens this long to tell them apart from ordinary knobs.
const LEARN_PROBE_MS = 350;
// Bank select arrives just before each program change; it's never a useful control.
const BANK_SELECT = new Set([0, 32]);

// Keys the app keeps for itself; they cannot be learned.
export const RESERVED_KEYS = new Set(['Backquote', 'KeyH', 'KeyF', 'Escape', TOGGLE_KEY]);

export function describeSource(id) {
  const [kind, a, b, c] = id.split(':');
  if (kind === 'key') return keyLabel(a);
  const ch = b === '*' ? 'any ch' : `ch ${b}`;
  if (a === 'cc') return `CC ${c} (${ch})`;
  if (a === 'note') return `Note ${noteName(+c)} (${ch})`;
  if (a === 'pb') return `Pitch bend (${ch})`;
  if (a === 'at') return `Aftertouch (${ch})`;
  if (a === 'pc') return `Program ${+c + 1} (${ch})`;
  return id;
}

function keyLabel(code) {
  const map = { Equal: '= / +', Minus: '−', Space: 'Space', NumpadAdd: 'Num +', NumpadSubtract: 'Num −',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (map[code]) return map[code];
  return code.replace(/^Key|^Digit/, '');
}

function noteName(n) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}

export class InputRouter {
  constructor(actions, { onChange, onMessage, onActivity, onDevices } = {}) {
    this.actions = new Map(actions.map((a) => [a.id, a]));
    this.onChange = onChange || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onActivity = onActivity || (() => {});
    this.onDevices = onDevices || (() => {}); // called with the list of hardware input names
    this.bindings = this._load();
    this.relative = this._loadRelative(); // source ids that are endless knobs
    this.learning = null;       // action id awaiting an input
    this.midiInputs = [];
    this.midiStatus = 'not started';
    this._held = new Map();     // action id -> Set of source ids holding it
    this._lastValue = new Map(); // source id -> last normalised value (edge detection)
    this._probe = null;          // CC values collected during a learn, see _probeLearn
  }

  // ---- bindings ------------------------------------------------------------

  sourcesFor(actionId) {
    return Object.keys(this.bindings).filter((s) => this.bindings[s] === actionId);
  }

  bind(sourceId, actionId) {
    this.bindings[sourceId] = actionId;
    this._save();
  }

  unbind(sourceId) {
    delete this.bindings[sourceId];
    this.relative.delete(sourceId);
    this._save();
  }

  resetBindings() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this.relative.clear();
    this._saveVersion();
    this._save();
  }

  replaceBindings(obj, relative = []) {
    const clean = {};
    for (const [s, a] of Object.entries(obj || {})) if (this.actions.has(a)) clean[s] = a;
    this.bindings = clean;
    this.relative = new Set(relative.filter((s) => s in clean));
    this._save();
  }

  // Switch a CC binding between "position" knob and endless knob.
  toggleRelative(sourceId) {
    if (this.relative.has(sourceId)) this.relative.delete(sourceId);
    else this.relative.add(sourceId);
    this._save();
  }

  startLearn(actionId) {
    if (this._probe) clearTimeout(this._probe.timer);
    this._probe = null;
    this.learning = actionId;
    this.onChange();
  }

  cancelLearn() {
    this.learning = null;
    if (this._probe) clearTimeout(this._probe.timer);
    this._probe = null;
    this.onChange();
  }

  releaseAll() {
    for (const [actionId, set] of this._held) {
      if (set.size) this.actions.get(actionId)?.hold?.(false);
    }
    this._held.clear();
  }

  // ---- keyboard ------------------------------------------------------------

  handleKey(e, down) {
    const id = `key:${e.code}`;
    if (this.learning && down) {
      this._learn(id, false);
      e.preventDefault();
      return true;
    }
    const actionId = this.bindings[id];
    if (!actionId) return false;
    e.preventDefault();
    const action = this.actions.get(actionId);
    if (action.type === 'trigger') {
      if (down && (!e.repeat || action.repeat)) action.run();
    } else if (action.type === 'hold') {
      if (!e.repeat) this._setHeld(action, id, down);
    }
    if (down && !e.repeat) this.onActivity(id, actionId);
    return true;
  }

  // ---- MIDI ----------------------------------------------------------------

  async startMidi() {
    if (!navigator.requestMIDIAccess) {
      this.midiStatus = 'Web MIDI not supported in this browser (use Chrome or Edge)';
      this.onChange();
      this.onDevices([]);
      return;
    }
    try {
      this.midiStatus = 'requesting access…';
      this.onChange();
      const access = await navigator.requestMIDIAccess({ sysex: false });
      const attach = () => {
        this.midiInputs = [];
        for (const input of access.inputs.values()) {
          if (input.state === 'disconnected') continue;
          input.onmidimessage = (m) => this.handleMidi(m.data);
          this.midiInputs.push(input.name || input.id);
        }
        this.midiStatus = this.midiInputs.length ? 'connected' : 'no MIDI inputs found';
        this.onChange();
        this.onDevices(this.midiInputs);
      };
      access.onstatechange = attach;
      attach();
    } catch (err) {
      this.midiStatus = `access denied (${err.message || err})`;
      this.onChange();
      this.onDevices([]);
    }
  }

  // Raw MIDI bytes from hardware or from the keyboard stand-in (virtual: true).
  handleMidi(data, { virtual = false } = {}) {
    const status = data[0];
    if (status >= 0xf0) return; // clock, active sensing, sysex: ignore
    const type = status & 0xf0;
    const ch = (status & 0x0f) + 1;
    let kind, num = null, value, pressed = null;

    if (type === 0x90 || type === 0x80) {
      kind = 'note';
      num = data[1];
      pressed = type === 0x90 && data[2] > 0;
      value = pressed ? data[2] / 127 : 0;
    } else if (type === 0xb0) {
      kind = 'cc';
      num = data[1];
      value = data[2] / 127;
    } else if (type === 0xe0) {
      kind = 'pb';
      value = ((data[2] << 7) | data[1]) / 16383;
    } else if (type === 0xd0) {
      kind = 'at';
      value = data[1] / 127;
    } else if (type === 0xc0) {
      // Program change: a one-shot button press (MiniLab 3 pads send these out of the box).
      kind = 'pc';
      num = data[1];
      pressed = true;
      value = 1;
    } else {
      return;
    }

    const suffix = num === null ? '' : `:${num}`;
    const id = `midi:${kind}:${ch}${suffix}`;
    const anyId = `midi:${kind}:*${suffix}`;

    if (this.learning) {
      if (kind === 'note' && !pressed) return; // learn on note-on, not note-off
      if (kind === 'cc' && BANK_SELECT.has(num)) return;
      if (kind === 'cc' && this.actions.get(this.learning)?.type === 'absolute') {
        this._probeLearn(id, data[2]);
        return;
      }
      this._learn(id, true);
      return;
    }

    const sourceId = this.bindings[id] ? id : this.bindings[anyId] ? anyId : null;
    const prev = this._lastValue.get(id) ?? 0;
    this._lastValue.set(id, value);
    this.onActivity(id, sourceId ? this.bindings[sourceId] : null, value, virtual);
    if (!sourceId) return;

    const action = this.actions.get(this.bindings[sourceId]);
    if (action.type === 'absolute' && this.relative.has(sourceId)) {
      const steps = data[2] - 64;
      if (steps && action.nudge) action.nudge(steps);
    } else if (action.type === 'absolute') {
      action.set(value);
    } else if (action.type === 'trigger') {
      const fire = kind === 'note' || kind === 'pc' ? pressed : prev < 0.5 && value >= 0.5;
      if (fire) action.run();
    } else if (action.type === 'hold') {
      this._setHeld(action, sourceId, kind === 'note' ? pressed : value >= 0.5);
    }
  }

  // ---- internals -----------------------------------------------------------

  // Knob actions listen briefly before binding a CC, to recognise endless knobs:
  // they hover around 64 and repeat the same value while turning, whereas an
  // ordinary knob only sends when its position changes.
  _probeLearn(id, raw) {
    if (!this._probe) {
      this._probe = { id, values: [], timer: setTimeout(() => {
        const { values } = this._probe;
        this._probe = null;
        const endless = values.length >= 2 && values.every((v) => v !== 64 && Math.abs(v - 64) <= 8) &&
          values.some((v, i) => i > 0 && v === values[i - 1]);
        this._learn(id, true, endless);
      }, LEARN_PROBE_MS) };
    }
    if (this._probe.id === id) this._probe.values.push(raw);
  }

  _learn(sourceId, continuous, endless = false) {
    const action = this.actions.get(this.learning);
    if (!action) return;
    if (sourceId.startsWith('midi:pc') && action.type !== 'trigger') {
      this.onMessage(`"${label(action)}" needs something you hold or turn. A program change is a single press.`);
      return;
    }
    if (action.type === 'absolute' && !continuous) {
      this.onMessage(`"${label(action)}" needs a knob, fader, wheel or pedal — not a key.`);
      return;
    }
    if (action.type === 'absolute' && sourceId.startsWith('midi:note')) {
      this.onMessage(`"${label(action)}" needs a knob, fader, wheel or pedal — not a note.`);
      return;
    }
    // One input drives one action: a learned input replaces any earlier binding
    // (including a wildcard-channel default for the same control).
    const anyId = sourceId.replace(/^(midi:\w+:)\d+/, '$1*');
    if (anyId !== sourceId && this.bindings[anyId]) delete this.bindings[anyId];
    const previous = this.bindings[sourceId];
    if (endless) this.relative.add(sourceId);
    else this.relative.delete(sourceId);
    this.bind(sourceId, action.id);
    this.learning = null;
    const note = previous && previous !== action.id ? ` (was "${label(this.actions.get(previous))}")` : '';
    this.onMessage(`Learned: ${describeSource(sourceId)}${endless ? ', endless knob' : ''} → ${label(action)}${note}`);
    this.onChange();
  }

  _setHeld(action, sourceId, on) {
    let set = this._held.get(action.id);
    if (!set) this._held.set(action.id, (set = new Set()));
    const wasActive = set.size > 0;
    if (on) set.add(sourceId);
    else set.delete(sourceId);
    const active = set.size > 0;
    if (active !== wasActive) action.hold(active);
  }

  _load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return this._addNewDefaults(JSON.parse(saved));
    } catch {
      /* fall through to defaults */
    }
    this._saveVersion();
    return { ...DEFAULT_BINDINGS };
  }

  // Mappings saved before a default was introduced gain it once, unless that input is already in use.
  _addNewDefaults(bindings) {
    let version = 1;
    try {
      version = Number(localStorage.getItem(VERSION_KEY)) || 1;
    } catch {
      /* treat as oldest */
    }
    for (const [v, added] of Object.entries(DEFAULTS_ADDED)) {
      if (Number(v) <= version) continue;
      for (const [s, a] of Object.entries(added)) if (!(s in bindings)) bindings[s] = a;
    }
    if (version < DEFAULTS_VERSION) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
      } catch {
        /* storage unavailable */
      }
      this._saveVersion();
    }
    return bindings;
  }

  _saveVersion() {
    try {
      localStorage.setItem(VERSION_KEY, String(DEFAULTS_VERSION));
    } catch {
      /* storage unavailable */
    }
  }

  _loadRelative() {
    try {
      return new Set(JSON.parse(localStorage.getItem(RELATIVE_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
      localStorage.setItem(RELATIVE_KEY, JSON.stringify([...this.relative]));
    } catch {
      /* storage unavailable: bindings last for this session only */
    }
    this.onChange();
  }
}

export function label(action) {
  return typeof action.label === 'function' ? action.label() : action.label;
}
