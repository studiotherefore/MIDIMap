// Input router with "learn": normalises keyboard and Web MIDI events into
// sources, looks up the bound action, and dispatches by action type.

import { DEFAULT_BINDINGS } from './actions.js';

const STORAGE_KEY = 'midimap.bindings.v1';

// Keys the app keeps for itself; they cannot be learned.
export const RESERVED_KEYS = new Set(['Backquote', 'KeyH', 'KeyF', 'Escape']);

export function describeSource(id) {
  const [kind, a, b, c] = id.split(':');
  if (kind === 'key') return keyLabel(a);
  const ch = b === '*' ? 'any ch' : `ch ${b}`;
  if (a === 'cc') return `CC ${c} (${ch})`;
  if (a === 'note') return `Note ${noteName(+c)} (${ch})`;
  if (a === 'pb') return `Pitch bend (${ch})`;
  if (a === 'at') return `Aftertouch (${ch})`;
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
  constructor(actions, { onChange, onMessage, onActivity } = {}) {
    this.actions = new Map(actions.map((a) => [a.id, a]));
    this.onChange = onChange || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onActivity = onActivity || (() => {});
    this.bindings = this._load();
    this.learning = null;       // action id awaiting an input
    this.midiInputs = [];
    this.midiStatus = 'not started';
    this._held = new Map();     // action id -> Set of source ids holding it
    this._lastValue = new Map(); // source id -> last normalised value (edge detection)
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
    this._save();
  }

  resetBindings() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this._save();
  }

  replaceBindings(obj) {
    const clean = {};
    for (const [s, a] of Object.entries(obj || {})) if (this.actions.has(a)) clean[s] = a;
    this.bindings = clean;
    this._save();
  }

  startLearn(actionId) {
    this.learning = actionId;
    this.onChange();
  }

  cancelLearn() {
    this.learning = null;
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
      return;
    }
    try {
      this.midiStatus = 'requesting access…';
      this.onChange();
      const access = await navigator.requestMIDIAccess({ sysex: false });
      const attach = () => {
        this.midiInputs = [];
        for (const input of access.inputs.values()) {
          input.onmidimessage = (m) => this._handleMidi(m.data);
          this.midiInputs.push(input.name || input.id);
        }
        this.midiStatus = this.midiInputs.length ? 'connected' : 'no MIDI inputs found';
        this.onChange();
      };
      access.onstatechange = attach;
      attach();
    } catch (err) {
      this.midiStatus = `access denied (${err.message || err})`;
      this.onChange();
    }
  }

  _handleMidi(data) {
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
    } else {
      return;
    }

    const suffix = num === null ? '' : `:${num}`;
    const id = `midi:${kind}:${ch}${suffix}`;
    const anyId = `midi:${kind}:*${suffix}`;

    if (this.learning) {
      if (kind === 'note' && !pressed) return; // learn on note-on, not note-off
      this._learn(id, true);
      return;
    }

    const sourceId = this.bindings[id] ? id : this.bindings[anyId] ? anyId : null;
    const prev = this._lastValue.get(id) ?? 0;
    this._lastValue.set(id, value);
    this.onActivity(id, sourceId ? this.bindings[sourceId] : null, value);
    if (!sourceId) return;

    const action = this.actions.get(this.bindings[sourceId]);
    if (action.type === 'absolute') {
      action.set(value);
    } else if (action.type === 'trigger') {
      const fire = kind === 'note' ? pressed : prev < 0.5 && value >= 0.5;
      if (fire) action.run();
    } else if (action.type === 'hold') {
      this._setHeld(action, sourceId, kind === 'note' ? pressed : value >= 0.5);
    }
  }

  // ---- internals -----------------------------------------------------------

  _learn(sourceId, continuous) {
    const action = this.actions.get(this.learning);
    if (!action) return;
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
    this.bind(sourceId, action.id);
    this.learning = null;
    const note = previous && previous !== action.id ? ` (was "${label(this.actions.get(previous))}")` : '';
    this.onMessage(`Learned: ${describeSource(sourceId)} → ${label(action)}${note}`);
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
      if (saved) return JSON.parse(saved);
    } catch {
      /* fall through to defaults */
    }
    return { ...DEFAULT_BINDINGS };
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch {
      /* storage unavailable: bindings last for this session only */
    }
    this.onChange();
  }
}

export function label(action) {
  return typeof action.label === 'function' ? action.label() : action.label;
}
