// Keyboard stand-in for a MIDI controller. Letter keys play pretend knobs and
// pads and produce raw MIDI bytes, which go to the same place hardware MIDI
// goes. MIDI learn and mappings therefore behave exactly as they will on a
// real controller. Knows nothing about Street View or actions.

const CHANNEL = 1;

// Knobs glide while a key is held and stay put on release, like turning a real knob.
export const KNOBS = [
  { up: 'KeyW', down: 'KeyS', cc: 74, seconds: 1.5, hint: 'W ↑  S ↓' },
  { up: 'KeyD', down: 'KeyA', cc: 71, seconds: 4, hint: 'A ←  D →' }, // direction: slower, so turning stays controllable
  { up: 'KeyT', down: 'KeyG', cc: 1, seconds: 1.5, hint: 'T ↑  G ↓' }, // mod wheel
  { up: 'KeyI', down: 'KeyK', cc: 76, seconds: 1.5, hint: 'I ↑  K ↓' },
];
export const PADS = [
  { key: 'KeyZ', note: 36 }, { key: 'KeyX', note: 37 }, { key: 'KeyC', note: 38 },
  { key: 'KeyV', note: 39 }, { key: 'KeyB', note: 40 }, { key: 'KeyN', note: 41 },
];
export const TOGGLE_KEY = 'KeyP';

const FINE = 0.2;       // glide rate multiplier while Shift is held
const VELOCITY = 100;

export class VirtualController {
  // send(bytes) receives each message as a Uint8Array, like MIDIMessageEvent.data.
  constructor(send) {
    this.send = send;
    this.active = false;
    this._knobs = KNOBS.map((k) => ({ ...k, value: 64, sent: 64, upHeld: false, downHeld: false }));
    this._pads = new Map(PADS.map((p) => [p.key, p.note]));
    this._padsDown = new Set();
    this._fine = false;
    this._lastFrame = 0;
    this._running = false;
  }

  setActive(on) {
    if (!on) this.releaseAll();
    this.active = on;
  }

  // Returns true if the key belongs to the stand-in (and was consumed).
  handleKey(e, down) {
    if (!this.active) return false;
    this._fine = e.shiftKey;
    const note = this._pads.get(e.code);
    if (note !== undefined) {
      e.preventDefault();
      if (e.repeat) return true;
      if (down && !this._padsDown.has(note)) {
        this._padsDown.add(note);
        this._emit(0x90, note, VELOCITY);
      } else if (!down && this._padsDown.delete(note)) {
        this._emit(0x80, note, 0);
      }
      return true;
    }
    const knob = this._knobs.find((k) => k.up === e.code || k.down === e.code);
    if (!knob) return false;
    e.preventDefault();
    if (e.code === knob.up) knob.upHeld = down;
    else knob.downHeld = down;
    if (down && !this._running) {
      this._running = true;
      this._lastFrame = 0;
      requestAnimationFrame((t) => this._frame(t));
    }
    return true;
  }

  // Lets go of everything, e.g. when the window loses focus mid-gesture.
  releaseAll() {
    for (const note of this._padsDown) this._emit(0x80, note, 0);
    this._padsDown.clear();
    for (const k of this._knobs) k.upHeld = k.downHeld = false;
  }

  _frame(t) {
    const dt = this._lastFrame ? Math.min((t - this._lastFrame) / 1000, 0.1) : 1 / 60;
    this._lastFrame = t;
    let moving = false;
    for (const k of this._knobs) {
      const dir = (k.upHeld ? 1 : 0) - (k.downHeld ? 1 : 0);
      if (!dir) continue;
      moving = true;
      k.value = Math.max(0, Math.min(127, k.value + dir * (127 / k.seconds) * dt * (this._fine ? FINE : 1)));
      const v = Math.round(k.value);
      if (v !== k.sent) {
        k.sent = v;
        this._emit(0xb0, k.cc, v);
      }
    }
    if (moving) requestAnimationFrame((tt) => this._frame(tt));
    else this._running = false;
  }

  _emit(type, a, b) {
    this.send(new Uint8Array([type | (CHANNEL - 1), a, b]));
  }
}
