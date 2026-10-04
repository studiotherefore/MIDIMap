import { fileURLToPath } from 'node:url';
// Experiment 4: the performance recorder. Real Mapillary, fake MiniLab, fake sync service.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.route(/\/api\/(projects|presets|midi)/, (r) => r.fulfill({ json: { presets: {}, projects: {}, profiles: {}, updated: {} } }));
await ctx.addInitScript(() => {
  const inp = { id: 'm', name: 'Minilab3 MIDI', state: 'connected', onmidimessage: null };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['m', inp]]), onstatechange: null });
  window.__midi = (...b) => inp.onmidimessage({ data: new Uint8Array(b), timeStamp: performance.now() });
  window.__changes = [];
  let last = null;
  const watch = () => { const i = window.blend?.S.index; if (i !== undefined && i !== last) { if (last !== null) window.__changes.push({ i, t: performance.now() }); last = i; } requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const URL_ = 'http://localhost:8000/experiments/record/';
const ready = (n = 25) => page.waitForFunction((n) => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= n, n, { timeout: 90000 });
await page.goto(URL_);
await ready();
const ev = (f, a) => page.evaluate(f, a);
const S = (k) => ev((k) => window.blend.S[k], k);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const midi = (...b) => ev((b) => window.__midi(...b), b);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
await page.click('#view', { position: { x: 300, y: 200 } });
await page.click('#below-tabs [data-below="seq"]');
await page.click('#view', { position: { x: 300, y: 200 } });

// A short performance at 120 BPM, locked, 2 steps a beat.
await key('b'); await key('Period');
const startIndex = await S('index');
const tRec = await ev(() => performance.now());
await key('q');
check('Q: recording (button and HUD)', await ev(() => document.querySelector('#take-rec').classList.contains('on')));
await key('Space');
await wait(1000); await midi(0xb0, 74, 127);        // mix up
await wait(1000); await key('ArrowUp');             // look up
await wait(1000); await ev(() => { window.blend.look.bloom = 0.7; });
await wait(1000); await key('k');                   // kick 808
await wait(1000); await midi(0xb0, 74, 0);          // mix down
await wait(1000);
await key('Space');
await key('q');
const t = await ev(() => { const t = window.blend.take.prep.take; return { name: t.name, beats: t.beats, frames: t.frames.length, lanes: [...window.blend.take.prep.lanes.keys()], end: window.blend.take.prep.states.at(-1) }; });
check('Q again: a take of whole beats (~12)', t.beats >= 11 && t.beats <= 14, `${t.name}: ${t.beats} beats, ${t.frames} changes`);
check('lanes: route, camera, blend, kick, bloom', ['route', 'camera', 'blend', 'kick', 'fx.bloom'].every((l) => t.lanes.includes(l)), t.lanes.join(' '));
check('it ends with mix 0, looking up, bloom 0.7, the 808', t.end.mix === 0 && t.end.pitch === 90 && t.end['look.bloom'] === 0.7 && t.end.kick === '808');
const recIdx = await ev(() => window.blend.take.prep.take.frames.filter((f) => 'index' in f.d).map((f) => f.b));
check('photo changes were recorded on the step grid', recIdx.length >= 8 && recIdx.every((b) => Math.abs(b * 2 - Math.round(b * 2)) < 1e-6), recIdx.slice(0, 6).join(' '));
check('the timeline shows the lanes', (await ev(() => document.querySelectorAll('#lanes .lane').length)) >= 5);

// Put things somewhere else, then play the take back.
await ev(() => { window.blend.S.mix = 0.5; window.blend.S.pitch = 0; window.blend.look.bloom = 0; });
await page.click('#kick-type [data-kick="off"]').catch(() => {});
await ev(() => { window.blend.S.index -= 20; });
await page.click('#view', { position: { x: 300, y: 200 } });
await ready(10);
const tPlay = await ev(() => performance.now());
await key('w');
check('W: waits for the next beat, then plays', (await ev(() => window.blend.take.pendingAt > 0 || window.blend.take.playing)));
const lenMs = t.beats * 500;
await wait(lenMs - 600);
const mid = await ev(() => ({ playing: window.blend.take.playing, kick: window.blend.kick.type, idx: window.blend.S.index, pitch: window.blend.S.pitch, kickLast: window.blend.kick.last }));
check('playback brings the recorded state back (look up, 808 kick)', mid.playing && mid.pitch === 90 && mid.kick === '808');
check('the kick sounds during playback', mid.kickLast > tPlay);
const ch = await ev((t0) => window.__changes.filter((c) => c.t > t0), tPlay);
const offs = await ev(([cs]) => cs.map((c) => { const bm = 60000 / window.blend.S.bpm / 2; const o = ((c.t - window.blend.clock.origin) % bm + bm) % bm; return Math.round(Math.min(o, bm - o)); }), [ch]);
const live = await ev(([t0, t1]) => window.__changes.filter((c) => c.t > t0 && c.t < t1).map((c) => { const bm = 60000 / window.blend.S.bpm / 2; const o = ((c.t - window.blend.clock.origin) % bm + bm) % bm; return Math.round(Math.min(o, bm - o)); }), [tRec, tPlay]);
const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
console.log(`      live playing, measured the same way: ${live.slice(0, 10).join(' ')} (avg ${avg(live)} ms)`);
check('photo changes in playback are as close to the grid as live playing (±1 frame)', ch.length >= 6 && Math.abs(avg(offs) - avg(live)) <= 17, `playback avg ${avg(offs)} ms: ${offs.slice(0, 10).join(' ')}`);
await wait(1200);
check('loop on: still playing after the end', await ev(() => window.blend.take.playing));
const fin = await ev(() => ({ mix: window.blend.S.mix, bloom: window.blend.look.bloom }));
check('values follow the take', fin.bloom === 0.7 || fin.bloom === 0, JSON.stringify(fin));

// Output window follows playback.
const out = await ctx.newPage();
await out.goto(`${URL_}?output`);
await out.waitForTimeout(5000);
check('output window follows the take', (await out.evaluate(() => window.blend.S.index)) === (await S('index')));
await out.close();
await key('w');
check('W stops', !(await ev(() => window.blend.take.playing)));

// Reverse, 2×.
await page.click('#take-rev'); await page.click('#take-rate [data-rate="2"]');
await page.click('#view', { position: { x: 300, y: 200 } });
const r0 = await ev(() => performance.now());
await key('w'); await wait(2500); await key('w');
const rch = await ev((t0) => window.__changes.filter((c) => c.t > t0).map((c) => c.i), r0);
const downs = rch.slice(1).filter((i, k) => i < rch[k]).length;
check('reverse at 2×: the photos go backwards, twice as fast', downs >= rch.length - 2 && rch.length >= 6, `${rch.length} changes: ${rch.slice(0, 8).join(' ')}`);
await page.click('#take-rev'); await page.click('#take-rate [data-rate="1"]');

// Mute the route: playback leaves the photos to you.
await ev(() => [...document.querySelectorAll('#lanes .lane')].find((l) => l.textContent.startsWith('route')).querySelector('.m').click());
await page.click('#view', { position: { x: 300, y: 200 } });
const before = await S('index');
await key('w'); await wait(1500);
check('route muted: the take no longer moves the photos', (await S('index')) === before);
await key('ArrowRight');
check('… and → still steps by hand', (await S('index')) === before + 1);
await key('w');
await ev(() => [...document.querySelectorAll('#lanes .lane')].find((l) => l.textContent.startsWith('route')).querySelector('.m').click());

// Clear a lane, trim.
page.once('dialog', (d) => d.accept());
await ev(() => [...document.querySelectorAll('#lanes .lane')].find((l) => l.textContent.includes('bloom')).querySelector('.c').click());
await wait(200);
check('clear: the bloom lane is gone', !(await ev(() => window.blend.take.prep.lanes.has('fx.bloom'))));
await ev(() => { window.blend.take.beat = 4; });
await page.click('#take-trim-out');
check('trim the end at beat 4', (await ev(() => window.blend.take.prep.take.beats)) === 4);

// Kept, exported, imported.
await page.reload();
await page.waitForFunction(() => window.blend?.take, null, { timeout: 30000 });
check('after a reload the take is still there', (await ev(() => window.blend.take.prep?.take.beats)) === 4);
await page.click('#below-tabs [data-below="seq"]');
const dl = page.waitForEvent('download');
await page.click('#take-export');
const file = `${OUT}take.midimap-take.json`;
await (await dl).saveAs(file);
await page.setInputFiles('#take-import', file);
await wait(300);
check('export / import', (await ev(() => Object.keys(window.blend.take.all).length)) === 2 && JSON.parse(fs.readFileSync(file, 'utf8')).beats === 4);
check('Q, W, take loop are MIDI-learnable', await ev(() => ['take.record', 'take.play', 'take.loop'].every((id) => window.blend.controls.has(id))));

check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: `${OUT}take.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} recorder checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
