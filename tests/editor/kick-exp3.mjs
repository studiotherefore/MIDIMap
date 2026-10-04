import { fileURLToPath } from 'node:url';
// Checks experiment 3's reference kick on the real page: kick onsets measured at the audio
// engine (AudioWorklet probe) vs photo changes, internal + external clock, offset, recording.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !process.env.HEADED, args: ['--autoplay-policy=user-gesture-required', '--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await page.addInitScript(() => {
  const inp = { id: 'a', name: 'Fake drum machine', state: 'connected', onmidimessage: null };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['a', inp]]), onstatechange: null });
  const T = (window.__t = { steps: [], onsets: [] });
  const send = (bytes, t) => inp.onmidimessage({ data: new Uint8Array(bytes), timeStamp: t });
  window.__send = (...b) => send(b, performance.now());
  window.__gen = (bpm) => {
    const g = (T.gen = { bpm, next: performance.now(), on: true });
    const loop = () => {
      if (!g.on) return;
      const now = performance.now();
      while (g.next <= now) {
        const before = window.blend.S.index;
        send([0xf8], g.next + (Math.random() * 2 - 1));
        if (window.blend.S.index !== before) T.steps.push({ t: g.next, by: 'pulse' });
        g.next += 60000 / g.bpm / 24;
      }
      setTimeout(loop, 2);
    };
    loop();
  };
  let last = -1;
  const watch = (now) => {
    const i = window.blend?.S.index;
    if (last !== -1 && i !== last) {
      const p = T.steps.at(-1);
      if (!p || p.by !== 'pulse' || now - p.t > 60) T.steps.push({ t: now, by: 'frame' });
    }
    last = i ?? -1;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  // Probe: timestamps each kick onset on the audio clock, then converts to "heard" performance time.
  window.__probe = async () => {
    const k = window.blend.kick;
    const code = `class P extends AudioWorkletProcessor { constructor(){super();this.q=1e9;this.env=0;this.k=Math.exp(-1/(0.02*sampleRate));} process(ins){const x=ins[0][0]; if(!x) return true;
      for(let i=0;i<x.length;i++){const a=Math.abs(x[i]); if(a>0.05 && this.q>sampleRate*0.3){this.port.postMessage(currentTime+i/sampleRate); this.q=0;} this.q++;} return true;} }
      registerProcessor('probe', P);`;
    await k.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(k.ctx, 'probe');
    const sink = k.ctx.createGain(); sink.gain.value = 0;
    k.out.connect(node).connect(sink).connect(k.ctx.destination);
    node.port.onmessage = ({ data }) => {
      const ts = k.ctx.getOutputTimestamp();
      T.onsets.push({ heard: ts.performanceTime + (data - ts.contextTime) * 1000 });
    };
  };
});

await page.goto('http://localhost:8000/experiments/fx/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer').textContent) && +RegExp.$1 >= 25, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const q = (sel) => page.textContent(sel);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const now = () => ev(() => performance.now());
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
// For each onset in the window: ms from the nearest photo change (+ = kick after the change).
const pair = (from, to) => ev(([f, t]) => {
  const on = window.__t.onsets.filter((o) => o.heard >= f && o.heard <= t);
  const st = window.__t.steps.filter((s) => s.t >= f - 300 && s.t <= t + 300);
  return { onsets: on.length, steps: st.length, gaps: on.slice(1).map((o, i) => Math.round(o.heard - on[i].heard)),
    diffs: on.map((o) => { const s = st.reduce((b, x) => (Math.abs(x.t - o.heard) < Math.abs(b.t - o.heard) ? x : b), st[0] || { t: Infinity }); return Math.round((o.heard - s.t) * 10) / 10; }) };
}, [from, to]);
const stats = (a) => a.length ? `min ${Math.min(...a)}, max ${Math.max(...a)}, n ${a.length}` : 'none';

await page.click('body', { position: { x: 1200, y: 400 } });
check('kick starts off', (await ev(() => window.blend.kick.type)) === 'off');
await key('k');
check('K → 808', (await ev(() => window.blend.kick.type)) === '808' && (await page.inputValue('#kick-type')) === '808');
check('kick turned tempo lock on', await ev(() => window.blend.S.tempo));
check('audio running', (await ev(() => window.blend.kick.ctx.state)) === 'running');
await ev(() => window.__probe());
console.log(`      audio latency reported: ${await ev(() => Math.round(window.blend.kick.latency() * 1000))} ms`);

// Internal clock, 120 BPM, 1 step per beat.
await key('Space');
const t0 = await now();
await wait(6000);
let r = await pair(t0 + 500, await now());
check('808: a kick every beat (500 ms)', r.onsets >= 9 && r.gaps.every((g) => Math.abs(g - 500) <= 3), r.gaps.join(' '));
check('808: kicks within 20 ms of the photo change', r.diffs.every((d) => Math.abs(d) <= 20), stats(r.diffs));
const base = r.diffs.reduce((x, y) => x + y, 0) / r.diffs.length;
check('HUD shows the kick', (await q('#hud-tempo')).includes('808 kick'), await q('#hud-tempo'));

// Two steps per beat: kick stays on the beat, every other change.
await key('.');
const t1 = await now();
await wait(4000);
r = await pair(t1 + 500, await now());
check('2 steps/beat: kick still every 500 ms', r.gaps.length >= 5 && r.gaps.every((g) => Math.abs(g - 500) <= 3), r.gaps.join(' '));
check('2 steps/beat: each kick on a change', r.diffs.every((d) => Math.abs(d) <= 20), stats(r.diffs));
await key(',');

// 909.
await key('k');
check('K → 909', (await ev(() => window.blend.kick.type)) === '909');
const t2 = await now();
await wait(3000);
r = await pair(t2 + 300, await now());
check('909: kicks on the beat', r.onsets >= 4 && r.diffs.every((d) => Math.abs(d) <= 20), `${stats(r.diffs)}; gaps ${r.gaps.join(' ')}`);

// Offset +100 ms.
await ev(() => { const x = document.querySelectorAll('#kick-params input')[1]; x.value = 100; x.dispatchEvent(new Event('input')); });
const t3 = await now();
await wait(3000);
r = await pair(t3 + 500, await now());
check('offset +100: kicks 100 ms later than without', r.onsets >= 3 && r.diffs.every((d) => Math.abs(d - 100 - base) <= 5), stats(r.diffs));
await ev(() => { const x = document.querySelectorAll('#kick-params input')[1]; x.value = 0; x.dispatchEvent(new Event('input')); });

// Volume slider reaches the gain.
await ev(() => { const x = document.querySelectorAll('#kick-params input')[0]; x.value = 0.3; x.dispatchEvent(new Event('input')); });
await wait(200);
check('volume slider sets the level', Math.abs((await ev(() => window.blend.kick.out.gain.value)) - 0.3) < 0.01);

// Paused: silence.
await key('Space');
const t4 = await now();
await wait(2000);
check('paused: no kicks', (await ev((f) => window.__t.onsets.filter((o) => o.heard > f + 100).length, t4)) === 0);

// External clock at 128 BPM: Start → kicks on the pulse beats, beat 1 included.
await key('c');
await ev(() => { window.__gen(128); });
await wait(1000);
const t5 = await now();
await ev(() => window.__send(0xfa));
await wait(5000);
r = await pair(t5, await now());
const beat = 60000 / 128;
check('external 128: kicks every 468.75 ms', r.gaps.length >= 7 && r.gaps.every((g) => Math.abs(g - beat) <= 3), r.gaps.join(' '));
check('external: each kick 30 ms after its pulse-driven change, i.e. when the screen shows it (beat 1 too)', r.onsets >= 8 && r.diffs.every((d) => Math.abs(d - 30) <= 5), stats(r.diffs));
await ev(() => window.__send(0xfc));
await wait(1500);
const t6 = await now();
await wait(1500);
check('external Stop: silence', (await ev((f) => window.__t.onsets.filter((o) => o.heard > f).length, t6)) === 0);
await ev(() => { window.__t.gen.on = false; });
await wait(700);
await key('c');

// K → off.
await key('k');
check('K → off', (await ev(() => window.blend.kick.type)) === 'off');
await key('k'); // 808 again for the recording

// Recording: picture + kick, then look inside the file.
await key('Space');
await wait(1000);
const dl = page.waitForEvent('download');
await key('v');
await wait(6000);
await key('v');
const file = `${OUT}kick-recording${(await dl).suggestedFilename().slice(-4)}`;
await (await dl).saveAs(file);
await key('Space');
console.log(`      recording: ${file.split('/').pop()}, ${Math.round(fs.statSync(file).size / 1e3)} kB`);
// Decode the file's sound and look at its frames in the page.
const b64 = fs.readFileSync(file).toString('base64');
const inFile = await ev(async ([data, type]) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const ac = new OfflineAudioContext(1, 48000, 48000);
  const buf = await ac.decodeAudioData(bytes.buffer.slice(0));
  const x = buf.getChannelData(0);
  const onsets = [];
  let q = 1e9; let env = 0; const k = Math.exp(-1 / (0.02 * buf.sampleRate));
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > 0.03 && q > buf.sampleRate * 0.3) { onsets.push(i / buf.sampleRate); q = 0; } q++; }
  // Frames: play the video, measure how much each frame differs from the one before.
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([bytes], { type }));
  v.muted = true;
  const c = new OffscreenCanvas(64, 36);
  const g = c.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let prev = null;
  await new Promise((res) => {
    const f = (_, m) => {
      g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      let diff = 0;
      if (prev) for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]);
      prev = d;
      frames.push({ t: m.mediaTime, diff: diff / (64 * 36) });
      if (!v.ended) v.requestVideoFrameCallback(f);
    };
    v.requestVideoFrameCallback(f);
    v.onended = res;
    v.play();
    setTimeout(res, 15000);
  });
  const cuts = frames.filter((f) => f.diff > 8).map((f) => f.t);
  return { duration: buf.duration, onsets, cuts, frames: frames.length };
}, [b64, file.endsWith('.mp4') ? 'video/mp4' : 'video/webm']);
check('recording has sound with kicks', inFile.onsets.length >= 8, `${inFile.onsets.length} kicks in ${inFile.duration.toFixed(1)} s`);
const fileGaps = inFile.onsets.slice(1).map((o, i) => Math.round((o - inFile.onsets[i]) * 1000));
const recBeat = 60000 / (await ev(() => window.blend.S.bpm));
check(`recording: kicks ${recBeat.toFixed(1)} ms apart`, fileGaps.every((g) => Math.abs(g - recBeat) <= 5), fileGaps.join(' '));
const avDiffs = inFile.onsets.map((o) => { const c = inFile.cuts.reduce((b, x) => (Math.abs(x - o) < Math.abs(b - o) ? x : b), Infinity); return Math.round((o - c) * 1000); });
console.log(`      recording: ${inFile.frames} frames decoded, ${inFile.cuts.length} photo changes seen`);
check('recording: kick vs photo change in the file within ±25 ms', avDiffs.length && avDiffs.every((d) => Math.abs(d) <= 25), avDiffs.join(' '));

check('no page errors', errors.length === 0, errors.join(' | '));
await page.evaluate(() => document.querySelector('.tempo').scrollIntoView());
await page.screenshot({ path: `${OUT}kick-panel.png` });
console.log(results.every(Boolean) ? '\nall kick checks passed' : '\nSOME CHECKS FAILED');
await browser.close();
