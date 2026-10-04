import { fileURLToPath } from 'node:url';
// One-off check of experiment 3's external MIDI clock, on the real page (real Mapillary photos),
// with fake MIDI inputs sending clock pulses at exact times plus ±1 ms jitter.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  const mk = (id, name) => ({ id, name, state: 'connected', onmidimessage: null });
  const inputs = { a: mk('a', 'Fake drum machine'), b: mk('b', 'Fake DAW') };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map(Object.entries(inputs)), onstatechange: null });
  const T = (window.__t = { steps: [], pulses: { a: 0, b: 0 }, gens: {} });
  const send = (inp, bytes, t) => inputs[inp].onmidimessage({ data: new Uint8Array(bytes), timeStamp: t });
  window.__send = (inp, ...bytes) => send(inp, bytes, performance.now());
  // Pulses at a BPM, timestamped at the exact due time ± 1 ms (like USB MIDI).
  window.__gen = (inp, bpm) => {
    const g = (T.gens[inp] = { bpm, next: performance.now(), on: true });
    const loop = () => {
      if (!g.on) return;
      const now = performance.now();
      while (g.next <= now) {
        const before = window.blend.S.index;
        send(inp, [0xf8], g.next + (Math.random() * 2 - 1));
        T.pulses[inp]++;
        if (window.blend.S.index !== before) T.steps.push({ t: g.next, by: 'pulse', n: window.blend.clock.pulses - 1 });
        g.next += 60000 / g.bpm / 24;
      }
      setTimeout(loop, 2);
    };
    loop();
  };
  window.__stop = (inp) => { if (T.gens[inp]) T.gens[inp].on = false; };
  // Steps made by the frame loop (internal clock).
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
});

await page.goto('http://localhost:8000/experiments/fx/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer').textContent) && +RegExp.$1 >= 25, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const q = (sel) => page.textContent(sel);
const key = (k) => page.keyboard.press(k);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const wait = (ms) => page.waitForTimeout(ms);
// Intervals between consecutive pulse-driven steps in a time window.
const intervals = async (from, to, by = 'pulse') => ev(([f, t, b]) => {
  const s = window.__t.steps.filter((x) => x.t >= f && x.t <= t && x.by === b);
  return s.slice(1).map((x, i) => Math.round((x.t - s[i].t) * 10) / 10);
}, [from, to, by]);
const now = () => ev(() => performance.now());

check('starts on the internal clock', (await q('#clock-status')).startsWith('Internal clock'));
await page.click('body', { position: { x: 1200, y: 400 } });
await key('c');
await wait(300);
check('C: switches to external, waiting', (await q('#clock-status')).startsWith('Waiting for MIDI clock'), await q('#clock-status'));
check('C: tempo lock turned on', await ev(() => window.blend.S.tempo));
check('C: select shows external', (await page.inputValue('#clock-source')) === 'external');

// Start + 130 BPM from the drum machine.
const t130 = await now();
await ev(() => { window.__send('a', 0xfa); window.__gen('a', 130); });
await wait(7000);
const t130e = await now();
const S1 = await ev(() => ({ bpm: window.blend.S.bpm, playing: window.blend.S.playing }));
check('Start: playing', S1.playing);
check('BPM follows 130', Math.abs(S1.bpm - 130) <= 0.3, S1.bpm);
check('status names the input', (await q('#clock-status')).includes('Fake drum machine'), await q('#clock-status'));
check('HUD says MIDI clock', (await q('#hud-tempo')).includes('MIDI clock'), await q('#hud-tempo'));
check('BPM field locked', await page.isDisabled('#bpm'));
check('Tap locked', await page.isDisabled('#tap'));
const firstStep = await ev((f) => window.__t.steps.find((x) => x.t >= f), t130);
check('Start: first step on beat 1 (pulse 0)', firstStep?.n === 0, JSON.stringify(firstStep));
const iv130 = await intervals(t130, t130e);
const beat130 = 60000 / 130;
check('steps land every beat (461.5 ms)', iv130.length > 8 && iv130.every((d) => Math.abs(d / beat130 - Math.round(d / beat130)) < 0.01), iv130.join(' '));
check('steps on pulse multiples of 24', await ev((f) => window.__t.steps.filter((x) => x.t >= f && x.by === 'pulse').every((x) => x.n % 24 === 0), t130));

// Tempo change to 90 BPM.
await ev(() => { window.__t.gens.a.bpm = 90; });
await wait(2500);
const t90 = await now();
await wait(4000);
const bpm90 = await ev(() => window.blend.S.bpm);
check('BPM follows a change to 90', Math.abs(bpm90 - 90) <= 0.3, bpm90);
const iv90 = await intervals(t90, await now());
check('steps every 666.7 ms at 90', iv90.length >= 4 && iv90.every((d) => Math.abs(d / 666.67 - Math.round(d / 666.67)) < 0.01), iv90.join(' '));

// Two steps per beat.
await key('.');
const tsp = await now();
await wait(4000);
const ivsp = await intervals(tsp, await now());
check('. : two steps per beat (333 ms)', ivsp.length >= 8 && ivsp.every((d) => Math.abs(d / 333.33 - Math.round(d / 333.33)) < 0.02), ivsp.join(' '));
const skipped = ivsp.filter((d) => d > 400).length;
console.log(`      (${skipped} of ${ivsp.length} steps waited a beat for photos)`);

// Keyboard tempo is ignored while following.
await key('Equal');
check('= ignored while following', (await ev(() => window.blend.S.bpm)) === bpm90 || Math.abs((await ev(() => window.blend.S.bpm)) - 90) < 0.3);
check('= explains why', (await q('#status')).includes('follows the external MIDI clock'), await q('#status'));

// Stop pauses (pulses keep coming, as most devices do).
await ev(() => window.__send('a', 0xfc));
const tstop = await now();
await wait(2000);
check('Stop: paused', !(await ev(() => window.blend.S.playing)));
check('Stop: no steps while stopped', (await ev((f) => window.__t.steps.filter((x) => x.t > f).length, tstop)) === 0);
check('Stop: status says stopped', (await q('#clock-status')).includes('stopped (Start'), await q('#clock-status'));

// Space while the device is stopped plays on the grid at the device's tempo; Space again pauses.
await key('Space');
const tsp2 = await now();
await wait(2500);
const ivsp2 = await intervals(tsp2, await now(), 'frame');
check('Space while stopped: plays at the device tempo (333 ms)', ivsp2.length >= 4 && ivsp2.every((d) => Math.abs(d / 333.33 - Math.round(d / 333.33)) < 0.1), ivsp2.join(' '));
await key('Space');
check('Space again: paused', !(await ev(() => window.blend.S.playing)));

// A second input sending clock is ignored while the first one runs.
await ev(() => window.__gen('b', 150));
await wait(2000);
check('second clock ignored', Math.abs((await ev(() => window.blend.S.bpm)) - 90) <= 0.3, await ev(() => window.blend.S.bpm));
await ev(() => window.__stop('b'));

// Continue plays on without resetting.
const pBefore = await ev(() => window.blend.clock.pulses);
await ev(() => window.__send('a', 0xfb));
await wait(1000);
check('Continue: playing, pulse count carried on', (await ev(() => window.blend.S.playing)) && (await ev(() => window.blend.clock.pulses)) > pBefore);

// Song position pointer: 16 sixteenths = 4 beats = 96 pulses.
await ev(() => { window.__send('a', 0xfc); window.__send('a', 0xf2, 16, 0); });
check('Song position sets the pulse count', (await ev(() => window.blend.clock.pulses)) === 96);
await ev(() => window.__send('a', 0xfb));

// Pulses stop: fall back to the internal clock at the last tempo.
await ev(() => window.__stop('a'));
const tlost = await now();
await wait(3500);
check('lost: status says so', (await q('#clock-status')).includes('stopped arriving'), await q('#clock-status'));
check('lost: BPM field usable again', !(await page.isDisabled('#bpm')));
const ivlost = await intervals(tlost + 700, await now(), 'frame');
check('lost: internal clock keeps stepping at ~333 ms', ivlost.length >= 4 && ivlost.every((d) => Math.abs(d / 333.33 - Math.round(d / 333.33)) < 0.1), ivlost.join(' '));

// Clock comes back.
await ev(() => window.__gen('a', 120));
await wait(3000);
check('back: following again at 120', (await q('#clock-status')).startsWith('Following') && Math.abs((await ev(() => window.blend.S.bpm)) - 120) <= 0.3, await q('#clock-status'));
await ev(() => window.__stop('a'));

// K back to internal; choice remembered after reload.
await key('c');
await wait(300);
check('C: back to internal', (await q('#clock-status')).startsWith('Internal clock'));
await key('c');
await page.reload();
await page.waitForFunction(() => window.blend?.clock);
check('external choice remembered after reload', (await page.inputValue('#clock-source')) === 'external');
await page.selectOption('#clock-source', 'internal');
check('select switches back to internal', (await ev(() => window.blend.clock.source)) === 'internal');

check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: fileURLToPath(new URL('./clock-panel.png', import.meta.url)) });
console.log(results.every(Boolean) ? '\nall clock checks passed' : '\nSOME CHECKS FAILED');
await browser.close();
