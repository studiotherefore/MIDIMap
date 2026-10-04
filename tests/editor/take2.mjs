import { fileURLToPath } from 'node:url';
// Experiment 4, round 2: take loops (whole and in/out), takes on pads and on learned MIDI presses.
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
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const URL_ = 'http://localhost:8000/experiments/record/';
await page.goto(URL_);
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 25, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const midi = (...b) => ev((b) => window.__midi(...b), b);
const T = (f) => ev(f);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
const view = () => page.click('#view', { position: { x: 300, y: 200 } });
await view();

// Record a take: 2 photos a beat for 6 s at 120 BPM.
await key('b'); await key('Period');
await key('q'); await key('Space'); await wait(6000); await key('Space'); await key('q');
const take = await T(() => { const t = window.blend.take.prep.take; return { name: t.name, beats: t.beats, first: window.blend.take.prep.states[0].image }; });
check('recorded a take', take.beats >= 11, `${take.name}, ${take.beats} beats`);

// 1. Whole take loops, and the picture really goes back to the start.
await key('w');
await page.waitForFunction(() => window.blend.take.playing, null, { timeout: 3000 });
await page.waitForFunction((len) => window.blend.take.beat > len - 1, take.beats, { timeout: 15000 });
await page.waitForFunction(() => window.blend.take.beat < 2, null, { timeout: 5000 }).catch(() => {});
await wait(150);
check('whole take loops: the first photo is on screen again', (await T(() => window.blend.onScreen())) === take.first);

// 2. I / O inside the take (sequence tab open), on whole beats.
await page.click('#below-tabs [data-below="seq"]'); await view();
await page.waitForFunction(() => window.blend.take.beat >= 3.2 && window.blend.take.beat < 4.2, null, { timeout: 15000 });
await key('i');
await page.waitForFunction(() => window.blend.take.beat >= 7.2 && window.blend.take.beat < 8.2, null, { timeout: 15000 });
await key('o');
await wait(100);
const span = await T(() => [window.blend.take.prep.take.loopIn, window.blend.take.prep.take.loopOut]);
check('I / O set the take loop on whole beats', span[0] === 3 || span[0] === 4, span.join(' → '));
const beats = [];
for (let i = 0; i < 24; i++) { beats.push(await T(() => window.blend.take.beat)); await wait(250); }
check('the take loops inside in/out', beats.every((b) => b >= span[0] && b < span[1]) && beats.some((b, i) => i && b < beats[i - 1]), `${Math.min(...beats).toFixed(2)}–${Math.max(...beats).toFixed(2)}`);
check('the lanes say so', (await page.textContent('#take-loop-info')).includes(`loop ${span[0] + 1} → ${span[1]}`));
await page.click('#loop');
check('the transport loop switch turns the take loop off', !(await T(() => window.blend.take.loop)));
await page.click('#loop');
await page.click('#take-clear-loop');
check('clear loop: loops whole again', (await T(() => window.blend.take.prep.take.loopIn)) === undefined);
await view(); await key('w');

// 3. A take on a pad.
await page.selectOption('#take-pad', '3');
await page.click('#take-to-pad');
check('put on pad 3: the pad shows the take', (await page.textContent('#slots .slot:nth-child(3)')).includes(`take · ${take.beats} beats`));
await view();
await key('Digit3');
check('key 3 launches it on the next beat', await T(() => window.blend.take.pendingAt > 0 || window.blend.take.playing));
await wait(1200);
check('… and it plays', await T(() => window.blend.take.playing));
await key('Digit3');
check('key 3 again stops it', !(await T(() => window.blend.take.playing || window.blend.take.pendingAt > 0)));
await midi(0xc0, 2); await wait(1200);
check('MiniLab pad 3 (program 3) launches it too', await T(() => window.blend.take.playing));
await midi(0xc0, 2);

// 4. Any learned MIDI press.
await key('m');
await ev((n) => [...document.querySelectorAll('#take-launchers .launch')].find((b) => b.textContent.includes(n)).click(), take.name);
await midi(0x90, 40, 100);
await key('m');
check('learn: a key onto the take\'s launch button', (await T(() => window.blend.profiles.bindingsFor(`take:${window.blend.take.current}`)[0]?.src)) === 'note:1:40');
await midi(0x90, 40, 100); await wait(1200);
check('that key launches the take', await T(() => window.blend.take.playing));
await midi(0x90, 40, 100);
check('… and stops it', !(await T(() => window.blend.take.playing || window.blend.take.pendingAt > 0)));

// 5. Rename: the pad and the MIDI key follow.
await page.fill('#take-name', 'avenue loop'); await page.press('#take-name', 'Enter');
check('rename: the pad follows', (await T(() => JSON.parse(localStorage.getItem('midimap.fx.slots.v1'))[2].take)) === 'avenue loop');
check('rename: the MIDI key follows', (await T(() => window.blend.profiles.bindingsFor('take:avenue loop')[0]?.src)) === 'note:1:40');

// 6. Reload: all still there.
await page.reload();
await page.waitForFunction(() => window.blend?.take, null, { timeout: 30000 });
await wait(1500);
check('after a reload: the pad still holds the take', (await page.textContent('#slots .slot:nth-child(3)')).includes('take ·'));
await view();
await key('Digit3'); await wait(1200);
check('… and launches it', await T(() => window.blend.take.playing && window.blend.take.current === 'avenue loop'));
await key('Digit3');

check('no page errors', errors.length === 0, errors.join(' | '));
await page.click('#below-tabs [data-below="seq"]'); await wait(300);
await page.screenshot({ path: `${OUT}take2.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
