import { fileURLToPath } from 'node:url';
// Phase 1 parity check: the editor does what experiment 3 does, from keys, mouse and MIDI.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !process.env.HEADED, args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
// The shared looks database is faked, so nothing real is written.
const saved = {};
await ctx.route('**/api/presets**', (route) => {
  const req = route.request();
  const name = decodeURIComponent(new URL(req.url()).pathname.split('/api/presets/')[1] || '');
  if (req.method() === 'GET') return route.fulfill({ json: { presets: saved } });
  if (req.method() === 'PUT') { saved[name] = JSON.parse(req.postData()); return route.fulfill({ json: { ok: true } }); }
  if (req.method() === 'DELETE') { delete saved[name]; return route.fulfill({ json: { ok: true } }); }
  return route.fulfill({ json: { ok: true } });
});
await ctx.addInitScript(() => {
  const inp = { id: 'm', name: 'Fake MiniLab', state: 'connected', onmidimessage: null };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['m', inp]]), onstatechange: null });
  window.__midi = (...b) => inp.onmidimessage({ data: new Uint8Array(b), timeStamp: performance.now() });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8000/editor/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer').textContent) && +RegExp.$1 >= 20, null, { timeout: 90000 });

const ev = (f, a) => page.evaluate(f, a);
const S = (k) => ev((k) => window.blend.S[k], k);
const q = (sel) => page.textContent(sel);
const has = (sel, cls) => ev(([s, c]) => document.querySelector(s).classList.contains(c), [sel, cls]);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
await page.click('#view', { position: { x: 300, y: 200 } });

// Playback
const i0 = await S('index');
await key('Space'); await wait(2500);
check('Space plays; photos advance', (await S('playing')) && (await S('index')) !== i0, `${i0} → ${await S('index')}`);
check('play button shows pause', (await q('#play')).includes('pause') && await has('#play', 'on'));
await key('Space');
const i1 = await S('index');
await key('ArrowRight');
check('→ steps one photo', (await S('index')) === i1 + 1);
await page.click('#step-back');
check('step ◀ button steps back', (await S('index')) === i1);
await key('r');
check('R reverses; segmented shows backward', (await S('dir')) === -1 && await has('#direction [data-dir="-1"]', 'on'));
await page.click('#direction [data-dir="1"]');
check('forward button', (await S('dir')) === 1);

// Blend and layers
await key('BracketRight');
check('] next blend mode, button marked', (await S('mode')) === 2 && await ev(() => document.querySelectorAll('#modes button')[2].classList.contains('on')));
await page.click('#bmode [data-b="off"]');
check('layer b off', (await S('bMode')) === 'off');
await page.click('#bmode [data-b="delay"]');
await page.fill('#delay', '20'); await page.dispatchEvent('#delay', 'input');
check('delay slider', (await S('delay')) === 20 && (await q('#delay-val')) === '20');
const runs = await ev(() => document.querySelectorAll('#runs li').length);
check('other runs listed', runs > 0, `${runs}`);

// Camera
await page.click('#insp-tabs [data-tab="camera"]');
check('camera tab shows its panel', await page.isVisible('#fov') && !(await page.isVisible('#fx-params')));
await key('ArrowUp');
check('↑ looks up; slider follows', (await S('pitch')) === 90 && (await wait(300), +(await page.inputValue('#pitch'))) === 90);
await key('ArrowDown');
await page.click('#follow');
check('follow switch toggles', (await S('follow')) === false && !(await has('#follow', 'on')));
await page.click('#follow');
await key('s');
check('S holds the sun (switch on)', (await S('sun')) === true && await has('#sun', 'on'));
await key('s');

// Tempo (top bar)
await key('b');
check('B locks to tempo (switch on); speed slider gives way', (await S('tempo')) && await has('#tempo', 'on') && !(await page.isVisible('#fps')));
await key('Equal');
check('= raises BPM', (await S('bpm')) === 121);
await page.click('#bpm-down');
check('− button lowers BPM', (await S('bpm')) === 120);
await key('Period');
check('. two steps per beat; menu follows', (await S('stepsPerBeat')) === 2 && (await page.inputValue('#spb')) === '2');
await key('Comma');
for (let i = 0; i < 3; i++) { await key('t'); await wait(400); }
check('T taps the tempo (~150)', Math.abs((await S('bpm')) - 150) <= 6, await S('bpm'));
await page.fill('#bpm', '120'); await page.dispatchEvent('#bpm', 'change');
await key('c');
await wait(300);
const cs = await ev(() => ({ src: window.blend.clock.source, txt: document.querySelector('#clock-status').textContent, focus: document.activeElement.id || document.activeElement.tagName }));
check('C external clock; status bar says so', cs.src === 'external' && cs.txt.includes('Waiting'), JSON.stringify(cs));
await key('c');

// Audio
await page.click('#insp-tabs [data-tab="audio"]');
await key('k');
check('K: 808, segmented shows it', (await ev(() => window.blend.kick.type)) === '808' && await has('#kick-type [data-kick="808"]', 'on'));
await page.click('#kick-type [data-kick="off"]');
check('kick off button', (await ev(() => window.blend.kick.type)) === 'off');

// Places
await key('Digit2');
check('2 goes to place 2; pad marked', (await q('#status')).includes('Shibuya') || (await has('#slots .slot:nth-child(2)', 'on')));
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer').textContent) && +RegExp.$1 >= 5, null, { timeout: 90000 }).catch(() => {});
await key('Alt+Digit3');
const slot3 = await ev(() => JSON.parse(localStorage.getItem('midimap.fx.slots.v1'))[2]);
check('Option+3 stores the playing photo in place 3', !!slot3.sequence && (await q('#slots .slot:nth-child(3) .src')).includes('exact'), slot3.name);
await page.dblclick('#slots .slot:nth-child(3) .name');
await page.keyboard.press('Meta+a'); await page.keyboard.type('my corner'); await key('Enter');
check('double-click renames a pad', (await q('#slots .slot:nth-child(3) .name')) === 'my corner');
await key('p');
check('P folds the places row', await has('#pads', 'closed'));
await page.click('#pads-head');
check('clicking the row title unfolds it', !(await has('#pads', 'closed')));
await key('Digit5');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer').textContent) && +RegExp.$1 >= 5, null, { timeout: 90000 }).catch(() => {});

// Effects + looks
await page.click('#insp-tabs [data-tab="effects"]');
await key('Shift+Digit2');
check('Shift+2 applies the "sun trails" look; echo style shows trails', (await ev(() => window.blend.look.echo)) === 0.9 && await ev(() => [...document.querySelectorAll('.fx-row .seg button')].find((b) => b.textContent === 'trails').classList.contains('on')));
await ev(() => [...document.querySelectorAll('.fx-row .seg button')].find((b) => b.textContent === 'blend').click());
check('echo style buttons set it', (await ev(() => window.blend.look.echo_trails)) === 0);
await key('Shift+Digit1');
await page.click('#save-preset');
await page.fill('#preset-name', 'parity test'); await page.click('#save-confirm');
await wait(500);
check('save look (to a fake server)', 'parity test' in saved && (await q('#presets')).includes('parity test'));
page.once('dialog', (d) => d.accept());
await ev(() => [...document.querySelectorAll('#presets button')].find((b) => b.textContent.includes('parity test')).querySelector('.x').click());
await wait(500);
check('delete look', !('parity test' in saved));

// MIDI: fixed MiniLab mapping, pads, and learn
await ev(() => window.__midi(0xb0, 74, 127));
check('knob 1 (CC 74) sets mix; slider follows', (await S('mix')) === 1 && (await page.inputValue('#mix')) === '1');
await ev(() => window.__midi(0xc0, 0));
check('pad 1 (program 0) goes to place 1', (await q('#status')).includes('Times Square') || await has('#slots .slot:nth-child(1)', 'on'));
await ev(() => [...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('instability')).querySelector('.learn').click());
check('learn waits for a control', (await ev(() => [...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('instability')).classList.contains('learning'))));
await ev(() => window.__midi(0xb0, 30, 64));
await ev(() => window.__midi(0xb0, 30, 127));
check('learned CC 30 drives instability', (await ev(() => window.blend.look.instability)) === 1 && (await ev(() => [...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('instability')).textContent)).includes('cc30'));
check('midi shows the controller (top bar dot, status bar)', await has('#midi-dot', 'ok') && (await q('#status-midi')).includes('Fake MiniLab'));
await ev(() => window.blend.look.instability = 0);

// H: picture only
await key('h');
const bare = await ev(() => ({ bare: document.body.classList.contains('bare'), w: document.querySelector('#view').clientWidth, h: document.querySelector('#view').clientHeight }));
check('H: picture only, filling the window', bare.bare && bare.w === 1440 && bare.h === 900, `${bare.w}×${bare.h}`);
await key('h');

// Output window mirrors the editor
const out = await ctx.newPage();
await out.goto('http://localhost:8000/editor/?output');
await out.waitForTimeout(6000);
await key('ArrowRight'); await key('ArrowRight');
await out.waitForTimeout(1500);
const o = await out.evaluate(() => ({ index: window.blend.S.index, run: window.blend.S.runA?.id, w: document.querySelector('#view').clientWidth, topbar: getComputedStyle(document.querySelector('.topbar')).display }));
const c = await ev(() => ({ index: window.blend.S.index, run: window.blend.S.runA?.id }));
check('output window follows the editor (same run and photo)', o.run === c.run && o.index === c.index, `${o.index} vs ${c.index}`);
check('output window: picture only, full width', o.topbar === 'none' && o.w === 1440);
await out.close();

// Recording (picture + kick)
await key('k');
await key('Space');
const dl = page.waitForEvent('download');
await key('v');
await wait(300);
check('V: rec buttons turn red', await has('#record', 'on'));
await wait(3000);
await key('v');
const file = `${OUT}editor-recording${(await dl).suggestedFilename().slice(-4)}`;
await (await dl).saveAs(file);
await key('Space'); await key('k'); await key('k');
check('recording saved', fs.statSync(file).size > 100000, `${Math.round(fs.statSync(file).size / 1e3)} kB, ${file.slice(-3)}`);

check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: `${OUT}parity-end.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} parity checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
