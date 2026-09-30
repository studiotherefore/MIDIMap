// A reference kick drum on the beat, synthesised live (no samples): '808' is a
// low sine that drops in pitch and rings; '909' is shorter and punchier, with a
// click on the front and a little drive. It's scheduled a little ahead on the
// audio clock from each beat's exact time, so it lands with the photo changes
// rather than late.
//
// Two voices, because the picture and a recording lag differently (measured on
// the author's Mac, 2026-09-30, real Chrome window):
// - speakers: a photo change reaches the screen ~PICTURE_MS after its beat (the
//   next frame drawn, then shown), so the kick sounds that much after the beat.
//   `offset` (ms, + = later) then lines it up by ear in the room (Bluetooth
//   speakers, projectors and Syphon chains add their own delay).
// - `stream`, for recording: in the recorded file the sound came ~REC_LEAD_MS
//   late against the picture, so this voice plays that much early. `offset`
//   doesn't apply: a recording has no room.

export const KICKS = ['off', '808', '909'];
const PICTURE_MS = 30;
const REC_LEAD_MS = 30;

export class Kick {
  constructor() {
    this.type = 'off';
    this.volume = 0.5;
    this.offset = 0;
    this.ctx = null;
    this.last = 0; // performance.now() time of the last beat scheduled
    this.onHit = null; // (performanceTime, audioTime) for testing
  }

  // Browsers only allow sound after a click or key press: call from one.
  start() {
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
      this.out = ctx.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(ctx.destination);
      this.recOut = ctx.createGain();
      this.recOut.gain.value = this.volume;
      this.recDest = ctx.createMediaStreamDestination();
      this.recOut.connect(this.recDest);
      const noise = (this.noise = ctx.createBuffer(1, ctx.sampleRate * 0.02, ctx.sampleRate));
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const curve = (this.curve = new Float32Array(1024));
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 511.5) - 1) * 2.5);
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    return this;
  }

  get stream() {
    return this.recDest?.stream || null;
  }

  setVolume(v) {
    this.volume = v;
    if (!this.out) return;
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    this.recOut.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // Seconds between the audio clock and hearing it.
  latency() {
    return this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
  }

  // The audio clock time that will be *heard* at performance.now() time `perf`.
  // getOutputTimestamp already says what's reaching the speakers now, so the
  // output latency is included (don't subtract it again).
  audioTime(perf) {
    const ts = this.ctx.getOutputTimestamp();
    if (!ts.performanceTime) return this.ctx.currentTime - this.latency() + (perf - performance.now()) / 1000;
    return ts.contextTime + (perf - ts.performanceTime) / 1000;
  }

  // Schedule the beats due soon. beatAfter(t): the first beat time after t;
  // beatMs: beat length. Called every ~25 ms while playing.
  schedule(beatAfter, beatMs) {
    if (this.type === 'off' || !this.ctx || this.ctx.state !== 'running') return;
    const now = performance.now();
    const lat = this.latency();
    // How far ahead of a beat its voices must be started.
    const early = Math.max(lat * 1000 - this.offset - PICTURE_MS, REC_LEAD_MS);
    const horizon = now + 100 + early;
    let b = beatAfter(Math.max(now + early - 5, this.last + beatMs / 2));
    for (; b < horizon; b += beatMs) {
      const cur = this.ctx.currentTime;
      const heard = this.audioTime(b) + (PICTURE_MS + this.offset) / 1000;
      // Audio made at context time x enters the recording `lat` before it's heard.
      const rec = this.audioTime(b) + lat - REC_LEAD_MS / 1000;
      if (heard >= cur - 0.005) this.hit(Math.max(heard, cur), this.out);
      if (rec >= cur - 0.005) this.hit(Math.max(rec, cur), this.recOut);
      this.onHit?.(b, heard);
      this.last = b;
    }
  }

  reset() {
    this.last = 0;
  }

  hit(t, dest = this.out, type = this.type) {
    const ctx = this.ctx;
    const is909 = type === '909';
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const decay = is909 ? 0.32 : 0.9;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(is909 ? 260 : 155, t);
    osc.frequency.exponentialRampToValueAtTime(is909 ? 52 : 47, t + (is909 ? 0.045 : 0.11));
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(1, t + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    let last = amp;
    if (is909) {
      const drive = ctx.createWaveShaper();
      drive.curve = this.curve;
      amp.connect(drive);
      last = drive;
      // The click: a 10 ms burst of filtered noise.
      const click = ctx.createBufferSource();
      click.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.5, t);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      click.connect(hp).connect(cg).connect(dest);
      click.start(t);
      click.stop(t + 0.02);
    }
    osc.connect(amp);
    last.connect(dest);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}
