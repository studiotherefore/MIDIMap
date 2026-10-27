// Takes: what was played, as beat-timed changes (experiment 4).
//
// A take records the state the output follows: the place and photo (or Street
// View panorama), the camera, blend, every effect, live and the kick. Nothing
// about the tempo itself, so a take plays at whatever BPM is set (that's the
// stretch). Times are in beats from the take's first beat line. Photos are
// stored by id: the imagery loads live.
//
//   take = { version, name, bpm, beats, created, frames: [{ b, d }] }
//     frames[0].d is the whole state; later frames hold only what changed.
//
// Each key belongs to a lane; lanes can be muted (left to the performer),
// soloed, or cleared (their changes removed, so the take's first value holds).

export const TAKE_VERSION = 1;

// State key → lane.
export function laneOf(key) {
  if (['source', 'run', 'index', 'image', 'dir', 'sv.pano', 'sv.heading', 'sv.pitch'].includes(key)) return 'route';
  if (['pitch', 'yawOffset', 'glance', 'fov', 'sun', 'follow'].includes(key)) return 'camera';
  if (['mode', 'mix', 'smooth', 'bMode', 'delay', 'runB'].includes(key)) return 'blend';
  if (key === 'live') return 'live';
  if (key === 'kick') return 'kick';
  if (key.startsWith('look.tint_')) return 'fx.tint';
  if (key.startsWith('look.')) return `fx.${key.slice(5)}`;
  return 'other';
}

export const LANE_LABEL = { route: 'route', camera: 'camera', blend: 'blend', live: 'live', kick: 'kick' };
export const LANE_TITLE = {
  route: 'places, photos, Street View panoramas, direction', camera: 'looking up, turning, glancing, field of view, hold the sun',
  blend: 'blend mode, mix, dissolve, layer B', live: 'live on/off', kick: 'kick off / 808 / 909',
};

export class Recorder {
  constructor() {
    this.take = null;      // the take being recorded
    this.beat = 0;         // where recording has got to, in beats
    this.last = null;      // the last recorded state, flat
  }

  start(state, phase) {
    this.take = { version: TAKE_VERSION, name: '', bpm: 0, beats: 0, created: Date.now(), frames: [{ b: 0, d: { ...state } }] };
    this.beat = phase; // the take starts on the beat line before now
    this.last = { ...state };
    this.take.frames[0].b = 0;
    this.offset = phase;
  }

  // Called while recording. step: the tempo grid in beats (when locked), so a
  // photo change recorded just after its step lands exactly on it.
  advance(beats, state, step = 0) {
    this.beat += beats;
    const d = {};
    for (const [k, v] of Object.entries(state)) if (v !== this.last[k]) d[k] = v;
    if (Object.keys(d).length) {
      let b = this.beat;
      if (step && Object.keys(d).some((k) => laneOf(k) === 'route')) {
        const snapped = Math.round(b / step) * step;
        if (Math.abs(snapped - b) < 0.15) {
          b = snapped;
          // Changes caught in the moment between the step and the photo arriving
          // move back onto the step too, so the photo change isn't pushed after them.
          for (let i = this.take.frames.length - 1; i > 0 && this.take.frames[i].b > b; i--) this.take.frames[i].b = b;
        }
      }
      const lastB = this.take.frames.at(-1).b;
      this.take.frames.push({ b: +Math.max(b, lastB).toFixed(4), d });
      Object.assign(this.last, d);
    }
  }

  stop(bpm) {
    const t = this.take;
    t.bpm = bpm;
    t.beats = Math.max(1, Math.ceil(this.beat - 1e-6)); // whole beats, so a take loops on the beat
    this.take = null;
    return t;
  }
}

// For playback: the whole state at every frame, and which lanes the take moves.
export function prepare(take) {
  const states = [];
  let cur = {};
  for (const f of take.frames) {
    cur = { ...cur, ...f.d };
    states.push(cur);
  }
  const lanes = new Map(); // lane → number of changes after the start
  for (const f of take.frames.slice(1)) for (const k of Object.keys(f.d)) { const l = laneOf(k); lanes.set(l, (lanes.get(l) || 0) + 1); }
  return { take, states, times: take.frames.map((f) => f.b), lanes };
}

// The frame in force at beat b (the last one at or before it).
export function frameAt(prep, b) {
  const t = prep.times;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= b) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Remove a lane's changes (its value at the start holds).
export function clearLane(take, lane) {
  for (const f of take.frames.slice(1)) for (const k of Object.keys(f.d)) if (laneOf(k) === lane) delete f.d[k];
  take.frames = take.frames.filter((f, i) => i === 0 || Object.keys(f.d).length);
}

// Keep only [from, to) beats: the state at `from` becomes the new start.
export function trim(take, from, to) {
  const prep = prepare(take);
  const start = prep.states[frameAt(prep, from)];
  const frames = [{ b: 0, d: { ...start } }];
  for (const f of take.frames) if (f.b > from && f.b < to) frames.push({ b: +(f.b - from).toFixed(4), d: f.d });
  take.frames = frames;
  take.beats = Math.max(1, Math.round(to - from));
}

// Overdub: lay what was played over a take, lane by lane.
//   segs = [{ lane, a, b, events: [{ b, k, v }] }], in the order they were
//   played (a new one each time round a loop). In a segment's lane the take's
//   changes in [a, b) are replaced by the segment's (a later pass wins); where
//   a covered stretch ends, the lane goes back to what the take had there.
//   Lanes without segments are left exactly as they were. Returns a new take.
export function overdub(take, segs) {
  const base = { ...take.frames[0].d };
  let events = [];
  for (const f of take.frames.slice(1)) for (const [k, v] of Object.entries(f.d)) events.push({ b: f.b, k, v });
  // The lane's values at beat b, as the take stands so far.
  const laneAt = (lane, b) => {
    const st = {};
    for (const [k, v] of Object.entries(base)) if (laneOf(k) === lane) st[k] = v;
    for (const e of events) if (e.b <= b && laneOf(e.k) === lane) st[e.k] = e.v;
    return st;
  };
  for (const s of segs) {
    if (!(s.b > s.a)) continue;
    const back = s.b < take.beats ? laneAt(s.lane, s.b) : {}; // where this pass ends, the lane goes back to this
    events = events.filter((e) => !(laneOf(e.k) === s.lane && e.b >= s.a && e.b < s.b));
    events = events.filter((e) => !(laneOf(e.k) === s.lane && e.b === s.b && e.back)); // an earlier pass's way back, now replaced
    events.push(...s.events.filter((e) => e.b >= s.a && e.b < s.b));
    for (const [k, v] of Object.entries(back)) events.push({ b: s.b, k, v, back: true });
    events.sort((x, y) => x.b - y.b || (y.back ? 1 : 0) - (x.back ? 1 : 0)); // the way back first, then the take's own changes at that beat
  }
  const cur = { ...base };
  const frames = [{ b: 0, d: base }];
  for (const e of events) {
    const b = +Math.max(0, e.b).toFixed(4);
    if (b === 0) { base[e.k] = e.v; cur[e.k] = e.v; continue; }
    if (cur[e.k] === e.v) continue;
    cur[e.k] = e.v;
    const last = frames.at(-1);
    if (frames.length > 1 && last.b === b) last.d[e.k] = e.v; else frames.push({ b, d: { [e.k]: e.v } });
  }
  return { ...take, frames };
}
