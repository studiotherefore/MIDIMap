// The action vocabulary. Every input (key, MIDI note, CC, pitch bend, aftertouch)
// is bound to one of these. Three kinds:
//   trigger  – fires once (key press, note on, CC crossing the midpoint upward)
//   hold     – active while held (key down, note held, CC above the midpoint)
//   absolute – follows a continuous value 0..1 (CC, pitch bend, aftertouch only)

import { SLOTS } from './locations.js';

export function buildActions(engine, getLocations) {
  const actions = [];

  for (const slot of SLOTS) {
    actions.push({
      id: `goto.${slot}`,
      group: 'Locations',
      label: () => `Go to ${slot}: ${getLocations()[slot]?.name ?? '(empty)'}`,
      type: 'trigger',
      run: () => engine.goto(getLocations()[slot]),
    });
  }

  actions.push(
    { id: 'speed.up', group: 'Motion', label: 'Speed +', type: 'trigger', repeat: true, run: () => engine.changeSpeed(1) },
    { id: 'speed.down', group: 'Motion', label: 'Speed −', type: 'trigger', repeat: true, run: () => engine.changeSpeed(-1) },
    { id: 'speed.set', group: 'Motion', label: 'Speed (knob: reverse ← stop → forward)', type: 'absolute', set: (v) => engine.setSpeedNormalized(v) },
    { id: 'pause', group: 'Motion', label: 'Pause / resume motion', type: 'trigger', run: () => engine.togglePause() },
    { id: 'mode', group: 'Motion', label: 'Toggle drift / travel', type: 'trigger', run: () => engine.toggleMode() },

    { id: 'pitch.up', group: 'Camera', label: 'Tilt up (hold)', type: 'hold', hold: (on) => engine.setHold('pitchUp', on) },
    { id: 'pitch.down', group: 'Camera', label: 'Tilt down (hold)', type: 'hold', hold: (on) => engine.setHold('pitchDown', on) },
    { id: 'pitch.set', group: 'Camera', label: 'Tilt (mod wheel / expression)', type: 'absolute', set: (v) => engine.setPitchNormalized(v) },
    { id: 'turn.left', group: 'Camera', label: 'Turn left (hold)', type: 'hold', hold: (on) => engine.setHold('turnLeft', on) },
    { id: 'turn.right', group: 'Camera', label: 'Turn right (hold)', type: 'hold', hold: (on) => engine.setHold('turnRight', on) },
    { id: 'heading.set', group: 'Camera', label: 'Direction (knob: 0–360°)', type: 'absolute', set: (v) => engine.setHeadingNormalized(v) },
  );

  return actions;
}

// Source ids:  key:<KeyboardEvent.code>
//              midi:cc:<channel|*>:<number>   midi:note:<channel|*>:<number>
//              midi:pb:<channel|*>            midi:at:<channel|*>
export const DEFAULT_BINDINGS = {
  'key:Digit1': 'goto.1', 'key:Digit2': 'goto.2', 'key:Digit3': 'goto.3',
  'key:Digit4': 'goto.4', 'key:Digit5': 'goto.5', 'key:Digit6': 'goto.6',
  'key:Digit7': 'goto.7', 'key:Digit8': 'goto.8', 'key:Digit9': 'goto.9',
  'key:Digit0': 'goto.0',
  'key:Equal': 'speed.up', 'key:NumpadAdd': 'speed.up',
  'key:Minus': 'speed.down', 'key:NumpadSubtract': 'speed.down',
  'key:Space': 'pause',
  'key:KeyM': 'mode',
  'key:ArrowUp': 'pitch.up', 'key:ArrowDown': 'pitch.down',
  'key:ArrowLeft': 'turn.left', 'key:ArrowRight': 'turn.right',
  // Any controller's mod wheel (CC1) or expression pedal (CC11) tilts the camera.
  'midi:cc:*:1': 'pitch.set',
  'midi:cc:*:11': 'pitch.set',
};
