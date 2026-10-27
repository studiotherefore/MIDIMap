// Recording the picture to a standard video file (V), shared by the editor and
// experiment 4.
//
// The file is always an ordinary MP4 that QuickTime, Premiere, Resolve and
// iMovie open, trim and export without converting first:
// - H.264 (High profile, level to suit the size) + AAC sound (the kick);
// - a fixed frame size (1280×720 or 1920×1080), the picture fitted into it;
// - a steady frame rate (30 or 60): frames are taken on a fixed clock and
//   their times put exactly on the frame grid;
// - not fragmented: Chrome writes fragmented MP4, which QuickTime plays but
//   won't edit or export ("Clip is not editable"), so it is repackaged
//   (mp4-flatten.js) before it's saved. Nothing is re-encoded.
//
// Settings live in localStorage `midimap.video.v1` (both pages share them).

import { flattenMp4 } from './mp4-flatten.js';

const KEY = 'midimap.video.v1';
export const SIZES = { 720: [1280, 720], 1080: [1920, 1080] };
const MBPS = { 720: 8, 1080: 16 }; // standard quality at 30 fps; high = ×2, 60 fps = ×1.5
const LEVEL = { '720:30': '1f', '720:60': '20', '1080:30': '28', '1080:60': '2a' }; // H.264 levels 3.1, 3.2, 4.0, 4.2

export function loadVideoSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* defaults */ }
  return { size: SIZES[s.size] ? +s.size : 1080, fps: s.fps === 60 ? 60 : 30, quality: s.quality === 'standard' ? 'standard' : 'high' };
}
export function saveVideoSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window: settings last this visit */ }
}
export const videoMbps = (s) => MBPS[s.size] * (s.quality === 'high' ? 2 : 1) * (s.fps === 60 ? 1.5 : 1);

// One line describing what a recording will be, for the output tab.
export function describeVideo(s) {
  const [w, h] = SIZES[s.size];
  const mbps = videoMbps(s);
  return `mp4 · h.264 + aac · ${w}×${h} · ${s.fps} fps steady · ${mbps} Mbit/s (about ${Math.round((mbps * 60) / 8 / 10) * 10} MB a minute)`;
}

export class VideoRecorder {
  constructor(settings) {
    this.s = { ...settings };
    const [w, h] = SIZES[this.s.size];
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.g.fillStyle = '#000';
    this.chunks = [];
    this.due = 0;
  }

  // Start with the kick's audio tracks. Returns false if this browser can't write MP4.
  // The recorder itself starts with the first picture (frame()): started
  // earlier, the canvas's empty first frame went into the file as a black one.
  start(audioTracks = []) {
    const lv = LEVEL[`${this.s.size}:${this.s.fps}`];
    const types = [`video/mp4;codecs=avc1.6400${lv},mp4a.40.2`, 'video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'];
    this.mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!this.mimeType) return false;
    this.audioTracks = audioTracks;
    this.on = true;
    return true;
  }

  begin() {
    this.stream = this.canvas.captureStream(0); // frames only when we say (requestFrame), on our clock
    this.track = this.stream.getVideoTracks()[0];
    for (const t of this.audioTracks) this.stream.addTrack(t);
    this.rec = new MediaRecorder(this.stream, { mimeType: this.mimeType, videoBitsPerSecond: videoMbps(this.s) * 1e6, audioBitsPerSecond: 192e3 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
  }

  // Call every display frame, right after the picture is drawn: copies it in
  // (fitted, centred) when the next frame of the steady rate is due.
  frame(source, now = performance.now()) {
    if (!this.on) return;
    const step = 1000 / this.s.fps;
    if (now < this.due - step * 0.4) return; // not yet (a 60 Hz screen gives 30 fps every other frame)
    this.due = now - this.due > step * 2 ? now + step : this.due + step; // fell far behind: start the clock again
    const { width: W, height: H } = this.canvas;
    const sw = source.width;
    const sh = source.height;
    if (!sw || !sh) return;
    const k = Math.min(W / sw, H / sh);
    const dw = Math.round(sw * k);
    const dh = Math.round(sh * k);
    if (dw < W || dh < H) this.g.fillRect(0, 0, W, H);
    this.g.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
    if (!this.rec) this.begin(); // the stream's first frame is this picture
    this.track.requestFrame();
  }

  // Stop, and give back the finished file (a Blob) and whether it was repackaged.
  stop() {
    this.on = false;
    if (!this.rec) return Promise.resolve({ blob: new Blob([], { type: 'video/mp4' }), fixed: false, error: 'no picture was recorded' });
    return new Promise((resolve) => {
      this.rec.onstop = async () => {
        const raw = new Blob(this.chunks, { type: 'video/mp4' });
        try {
          resolve({ blob: await flattenMp4(raw, { fps: this.s.fps }), fixed: true });
        } catch (err) {
          console.warn('could not repackage the recording', err);
          resolve({ blob: raw, fixed: false, error: err.message });
        }
      };
      this.rec.stop();
      this.rec = null;
    });
  }
}
