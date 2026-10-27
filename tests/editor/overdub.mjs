import { fileURLToPath } from 'node:url';
// Experiment 4: overdub (Shift+Q) and its undo (⌘Z). Real Mapillary, fake MiniLab, fake sync service.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
const ready = (n = 25) => page.waitForFunction((n) => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= n, n, { timeout: 90000 });
await page.goto('http://localhost:8000/experiments/record/');
await ready();
const ev = (f, a) => page.evaluate(f, a);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const midi = (...b) => ev((b) => window.__midi(...b), b);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
await page.click('#view', { position: { x: 300, y: 200 } });
await page.click('#view', { position: { x: 300, y: 200 } });

// The changes of one key through a take, as [beat, value] pairs.
const keyTrack = (k) => ev((k) => window.blend.take.prep.take.frames.flatMap((f, i) => (k in f.d ? [[i ? f.b : 0, f.d[k]]] : [])), k);
const lanesOpen = () => ev(() => [...(window.blend.take.od?.open.keys() || [])]);

// 1. A take: the photos move, the mix knob goes up and down, bloom comes on.
await key('b'); await key('Period'); // locked, 2 steps a beat, 120 BPM
await key('Space');
await key('q');
await wait(900); await midi(0xb0, 74, 127);
await wait(900); await ev(() => { window.blend.look.bloom = 0.6; });
await wait(900); await midi(0xb0, 74, 0);
await wait(1200);
await key('q');
await key('Space');
const orig = await ev(() => JSON.parse(JSON.stringify(window.blend.take.prep.take)));
const before = { index: await keyTrack('index'), bloom: await keyTrack('look.bloom'), mix: await keyTrack('mix') };
check('a take to overdub: photos, mix and bloom', orig.beats >= 7 && before.index.length >= 8 && before.mix.length >= 2 && before.bloom.length >= 1, `${orig.beats} beats, ${before.index.length} photo changes`);

// 2. Shift+Q with nothing playing: the take starts on the next beat, overdubbing.
await ev(() => { window.blend.S.index -= 12; });
await ready(10);
await key('Shift+KeyQ');
check('Shift+Q: overdub on, the take starts on the next beat', await ev(() => !!window.blend.take.od && (window.blend.take.pendingAt > 0 || window.blend.take.playing)));
check('the overdub button and the HUD show it', await ev(() => document.querySelector('#take-od').classList.contains('on')));
await wait(2500);
check('nothing is taken over until you change something (no false punch-ins)', (await lanesOpen()).length === 0, (await lanesOpen()).join(' '));
check('the HUD counts the overdub\'s beats', (await ev(() => document.querySelector('#hud-rec').textContent)).includes('overdub'));

// 3. Turn the mix knob through more than one pass of the loop.
const tOd = await ev(() => performance.now());
const ramp = [];
for (let i = 0; i < 24; i++) { const v = 10 + i * 4; ramp.push(+(v / 127).toFixed(3)); await midi(0xb0, 74, v); await wait(250); }
check('the mix lane is yours (red), the others are not', JSON.stringify(await lanesOpen()) === '["blend"]' && await ev(() => [...document.querySelectorAll('#lanes .lane.od .lname')].map((e) => e.textContent).join() === 'blend'), (await lanesOpen()).join(' '));
check('bloom keeps playing from the take during the overdub', await ev(() => window.blend.take.playing && window.blend.look.bloom >= 0));
const passes = await ev(() => window.blend.take.od.segs.filter((s) => s.lane === 'blend').length);
check('the loop came round while overdubbing (a stretch per pass)', passes >= 1, `${passes + 1} passes`);
await page.screenshot({ path: `${OUT}overdub-red.png` });
await page.locator('#lanes').screenshot({ path: `${OUT}overdub-lanes.png` });
const tStop = await ev(() => performance.now());
await key('Shift+KeyQ');
check('Shift+Q again: overdub off, the take keeps playing', await ev(() => !window.blend.take.od && window.blend.take.playing));

// 4. What the overdub kept.
const after = { index: await keyTrack('index'), bloom: await keyTrack('look.bloom'), mix: await keyTrack('mix') };
check('the route is exactly as it was', JSON.stringify(after.index) === JSON.stringify(before.index));
check('bloom is exactly as it was', JSON.stringify(after.bloom) === JSON.stringify(before.bloom));
const rampSet = new Set(ramp);
check('the mix lane holds only the new knob values (a whole loop was covered)', after.mix.length >= 4 && after.mix.every(([, v]) => rampSet.has(v)), after.mix.slice(0, 6).map(([b, v]) => `${b}:${v}`).join(' '));
check('the take is the same length', await ev(() => window.blend.take.prep.take.beats) === orig.beats);
const saved = await ev(() => JSON.parse(localStorage.getItem('midimap.record.takes.v1'))[window.blend.take.current].frames.length);
check('the overdubbed take is kept in this browser', saved === (await ev(() => window.blend.take.prep.take.frames.length)));

// Photo changes during the overdub, measured against the grid as take.mjs does.
const offs = await ev(([t0, t1]) => window.__changes.filter((c) => c.t > t0 && c.t < t1).map((c) => { const bm = 60000 / window.blend.S.bpm / 2; const o = ((c.t - window.blend.clock.origin) % bm + bm) % bm; return Math.round(Math.min(o, bm - o)); }), [tOd, tStop]);
const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
check('photo changes stay on the grid during the overdub (avg within 2 frames)', offs.length >= 8 && avg(offs) <= 34, `avg ${avg(offs)} ms: ${offs.slice(0, 10).join(' ')}`);

// 5. Playback follows the new mix; the sliders follow playback.
await wait(1200);
const mixNow = await ev(() => window.blend.S.mix);
check('playback plays the overdubbed mix', rampSet.has(mixNow), mixNow);
await ev(() => { window.blend.look.bloom = 0.123; }); // behind the panel's back: the take's next frame puts it right
await wait(1500);
const shown = await ev(() => ({ slider: +[...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('bloom')).querySelector('input').value, look: window.blend.look.bloom }));
check('the effect sliders follow the take', shown.look !== 0.123 && Math.abs(shown.slider - shown.look) < 1e-6, `${shown.slider} vs ${shown.look}`);

// 6. ⌘Z undoes, again redoes.
const merged = await ev(() => JSON.stringify(window.blend.take.prep.take.frames));
await key('Meta+KeyZ');
check('⌘Z: the take is exactly as it was before the overdub', await ev(() => JSON.stringify(window.blend.take.prep.take.frames)) === JSON.stringify(orig.frames));
check('the button now says redo', (await ev(() => document.querySelector('#take-undo').textContent)).startsWith('redo'));
await key('Meta+KeyZ');
check('⌘Z again: the overdub is back', await ev(() => JSON.stringify(window.blend.take.prep.take.frames)) === merged);

// 7. Overdub the camera while the take plays; stop with W. A short touch only replaces a stretch.
await ev(() => { window.blend.take.loop = false; });
await key('w'); // stop
await wait(300);
await key('w'); // play from the next beat
await wait(1200);
await key('Shift+KeyQ');
await wait(800);
const b0 = await ev(() => window.blend.take.beat);
await key('ArrowUp');
await wait(1000);
await key('ArrowDown');
await wait(500);
const b1 = await ev(() => window.blend.take.beat);
check('looking up takes over the camera lane', JSON.stringify(await lanesOpen()) === '["camera"]', (await lanesOpen()).join(' '));
await key('w');
check('W stops the take and keeps the overdub', await ev(() => !window.blend.take.od && !window.blend.take.playing));
const pitch = await keyTrack('pitch');
const at = (track, b) => track.filter(([t]) => t <= b).at(-1)?.[1];
check('the camera looks up only where you did, before and after it is as it was', at(pitch, b0 - 0.2) === 0 && pitch.some(([b, v]) => v === 90 && b >= b0 && b <= b1) && at(pitch, orig.beats - 0.01) === 0, pitch.map(([b, v]) => `${b}:${v}`).join(' '));
check('mix and route untouched by the camera overdub', JSON.stringify(await keyTrack('index')) === JSON.stringify(before.index) && (await keyTrack('mix')).every(([, v]) => rampSet.has(v)));

// 8. An overdub where nothing changes leaves the take alone; reverse refuses it.
const frames2 = await ev(() => JSON.stringify(window.blend.take.prep.take.frames));
await page.click('#take-od');
await wait(2000);
await page.click('#take-od');
check('overdub (button) with no changes: the take is untouched', await ev(() => JSON.stringify(window.blend.take.prep.take.frames)) === frames2 && (await ev(() => document.querySelector('#status').textContent)).includes('nothing was changed'));
await key('w');
await ev(() => { window.blend.take.reverse = true; });
await key('Shift+KeyQ');
check('overdub refuses reverse, in plain words', await ev(() => !window.blend.take.od && document.querySelector('#status').textContent.includes('forward only')));
await ev(() => { window.blend.take.reverse = false; });
check('overdub and undo are MIDI-learnable', await ev(() => window.blend.controls?.has?.('take.overdub') ?? !!document.querySelector('[data-learn="take.overdub"]')) && !!(await ev(() => document.querySelector('[data-learn="take.undo"]'))));
check('the keys table lists Shift+Q and ⌘Z', await ev(() => document.body.innerHTML.includes('Shift+Q · ⌘Z')));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} overdub checks failed` : `\nall ${results.length} overdub checks passed`);
process.exit(failed ? 1 : 0);
