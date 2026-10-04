import { fileURLToPath } from 'node:url';
// Phase 4: MIDI profiles, learn mode, the MIDI panel. Fake devices, fake sync service.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const server = { projects: {}, presets: {}, profiles: {} };
await ctx.route(/\/api\/(projects|presets|midi)/, (route) => {
  const req = route.request();
  const [, coll, raw] = new URL(req.url()).pathname.match(/\/api\/(projects|presets|midi)\/?(.*)/);
  const field = coll === 'midi' ? 'profiles' : coll;
  const name = decodeURIComponent(raw || '');
  if (req.method() === 'GET') return route.fulfill({ json: { [field]: server[field], updated: {} } });
  if (req.method() === 'PUT') { server[field][name] = JSON.parse(req.postData()); return route.fulfill({ json: {} }); }
  if (req.method() === 'DELETE') { delete server[field][name]; return route.fulfill({ json: {} }); }
});
await ctx.addInitScript(() => {
  const mk = (id, name) => ({ id, name, state: 'connected', onmidimessage: null });
  const ins = { m: mk('m', 'Minilab3 MIDI'), l: mk('l', 'Fake Launch Control') };
  const access = { inputs: new Map([['m', ins.m]]), onstatechange: null };
  navigator.requestMIDIAccess = async () => access;
  window.__midi = (...b) => ins.m.onmidimessage({ data: new Uint8Array(b), timeStamp: performance.now() });
  window.__lc = (...b) => ins.l.onmidimessage({ data: new Uint8Array(b), timeStamp: performance.now() });
  window.__plug = (id, on) => { if (on) access.inputs.set(id, ins[id]); else access.inputs.delete(id); access.onstatechange?.({}); };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8000/editor/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 5, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const S = (k) => ev((k) => window.blend.S[k], k);
const midi = (...b) => ev((b) => window.__midi(...b), b);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
await page.click('#view', { position: { x: 300, y: 200 } });

// The MiniLab works as before (the default profile).
check('default profile: minilab 3', (await ev(() => window.blend.profiles.current)) === 'minilab 3');
await midi(0xb0, 74, 127); check('knob 1 (cc 74) → mix', (await S('mix')) === 1);
await midi(0xb0, 1, 127); check('mod strip (cc 1) → look up 0–90°', (await S('pitch')) === 90);
await midi(0xb0, 1, 0);
const yaw0 = await S('yawOffset'); await midi(0xb0, 114, 66); check('main knob (endless cc 114) turns', (await S('yawOffset')) === yaw0 + 6);
await midi(0xe0, 0, 0); check('pitch strip → glance', (await S('glance')) === -90); await midi(0xe0, 0, 64);
await midi(0xb0, 18, 127); check('knob (cc 18, ch 1) → bloom', (await ev(() => window.blend.look.bloom)) === 1);
await midi(0xb0, 18, 0);
const i0 = await S('index'); await midi(0x90, 60, 100); check('keys step a photo while paused', (await S('index')) === i0 + 1);
await midi(0xc0, 1); await wait(300); check('pad 2 (program 1) → place 2', (await ev(() => document.querySelector('#slots .slot:nth-child(2)').classList.contains('on'))));
await midi(0xc0, 4); await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 5, null, { timeout: 90000 }).catch(() => {});

// Learn mode.
await key('m');
const outlined = await ev(() => document.querySelectorAll('[data-learn]').length);
check('M: learn mode outlines every mappable control', (await ev(() => document.body.classList.contains('midi-learn'))) && outlined > 40, `${outlined} controls`);
const mix0 = await S('mix');
await page.click('#mix', { position: { x: 5, y: 7 } });
check('clicking a slider arms it without moving it', (await ev(() => document.querySelector('#mix').classList.contains('armed'))) && (await S('mix')) === mix0);
await midi(0xb0, 20, 64);
check('a knob binds to it (cc 20)', (await ev(() => window.blend.profiles.bindingsFor('mix').map((b) => b.src).join())) === 'cc:1:20');
await page.click('#play');
check('clicking play in learn mode arms it, does not play', (await ev(() => document.querySelector('#play').classList.contains('armed'))) && !(await S('playing')));
await midi(0x90, 36, 100);
check('a key (note 36) binds to play', (await ev(() => window.blend.profiles.bindingsFor('play')[0]?.src)) === 'note:1:36');
await page.click('#slots .slot:nth-child(3)');
await midi(0xc0, 10);
check('a pad (program 11) binds to place 3', (await ev(() => window.blend.profiles.bindingsFor('place.3').map((b) => b.src).join())) === 'pc:1:10');
await page.click('#insp-tabs [data-tab="audio"]');
await page.click('#kick-type');
await midi(0xb0, 40, 0);
await page.click('#insp-tabs [data-tab="effects"]');
await ev(() => [...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('hue')).click());
for (const v of [65, 63, 65, 66, 65]) await midi(0xb0, 30, v);
check('an endless knob is recognised (∞)', (await ev(() => window.blend.profiles.bindingsFor('fx.hue')[0]?.mode)) === 'rel');
await wait(300);
const badges = await ev(() => [...document.querySelectorAll('#learn-layer .badge')].map((b) => b.textContent));
check('learn mode shows what each control is mapped to', badges.includes('cc20') && badges.includes('n36'), badges.slice(0, 8).join(' '));
await key('m');
check('M again leaves learn mode', !(await ev(() => document.body.classList.contains('midi-learn'))) && (await ev(() => document.querySelectorAll('#learn-layer .badge').length)) === 0);

// The new bindings work; the old source has let go.
await midi(0xb0, 20, 0); check('cc 20 now drives mix', (await S('mix')) === 0);
await midi(0xb0, 74, 127); check('cc 74 no longer does (one source per control)', (await S('mix')) === 0);
const moved = await ev(() => { const i = window.blend.S.index; window.__midi(0x90, 36, 100); return window.blend.S.index - i; });
check('note 36 plays; the "any key steps" mapping stays out of it', (await S('playing')) && moved === 0);
await midi(0x90, 36, 100);
await midi(0xc0, 10); await wait(200); check('program 11 → place 3', await ev(() => document.querySelector('#slots .slot:nth-child(3)').classList.contains('on')));
await midi(0xc0, 4);
await midi(0xb0, 40, 64); check('a knob on a three-way choice (kick: off/808/909) picks by position', (await ev(() => window.blend.kick.type)) === '808');
await midi(0xb0, 40, 0);
const hue0 = await ev(() => window.blend.look.hue);
await midi(0xb0, 30, 70); check('the endless knob nudges hue (+6 steps)', Math.abs((await ev(() => window.blend.look.hue)) - hue0 - 21.6) <= 0.5, `${hue0} → ${await ev(() => window.blend.look.hue)}`);

// The panel.
await page.click('#midi-btn');
await wait(300);
check('panel: the device, with its profile', (await page.textContent('#midi-devices')).includes('Minilab3 MIDI') && (await page.textContent('#midi-devices')).includes('minilab 3'));
await midi(0xb0, 99, 5); await wait(200);
check('panel: the last message', (await page.textContent('#midi-last')).includes('cc 99 · ch 1 = 5'), await page.textContent('#midi-last'));
const bindTxt = await page.textContent('#midi-bindings');
check('panel: the mapping list', bindTxt.includes('cc 20 · ch 1') && bindTxt.includes('→ blend mix') && bindTxt.includes('pad / program 11'));
const mixRow = page.locator('#midi-bindings li', { hasText: '→ blend mix' });
await mixRow.locator('.mode').click();
check('panel: ⇥ → ∞ changes the mapping type', (await ev(() => window.blend.profiles.bindingsFor('mix')[0].mode)) === 'rel');
await mixRow.locator('.x').click();
check('panel: × removes a mapping', (await ev(() => window.blend.profiles.bindingsFor('mix').length)) === 0);
await page.click('[data-arm="glance"]');
await midi(0xb0, 50, 100);
check('learn from the panel (glance, not on screen)', (await ev(() => window.blend.profiles.bindingsFor('glance')[0]?.src)) === 'cc:1:50');
check('profile synced', server.profiles['minilab 3']?.bindings.some((b) => b.src === 'cc:1:50'));

// Profiles.
await page.fill('#midi-name', 'launch control');
await page.click('#midi-new');
check('new empty profile', (await ev(() => window.blend.profiles.current)) === 'launch control' && (await ev(() => window.blend.profiles.profile.bindings.length)) === 0);
const mixA = await S('mix');
await midi(0xb0, 20, 127); check('an empty profile ignores the knobs', (await S('mix')) === mixA);
await ev(() => window.__plug('l', true));
await page.click('#midi-for-device');
check('"use with connected controller" ties it to the devices', (await ev(() => window.blend.profiles.profile.devices)).includes('Fake Launch Control'));
await page.selectOption('#midi-profile', 'minilab 3');
await ev(() => window.__plug('l', false));
await ev(() => window.__plug('l', true));
await wait(200);
check('plugging a controller in brings its profile', (await ev(() => window.blend.profiles.current)) === 'launch control');
await page.selectOption('#midi-profile', 'minilab 3');

// A project remembers the profile.
await key('Escape');
await key('Meta+s'); await page.fill('#project-name-input', 'midi test'); await key('Enter'); await wait(400);
check('a project keeps the profile name', server.projects['midi test']?.midi.profile === 'minilab 3');

// Reload: profiles and bindings are still there.
await page.reload();
await page.waitForFunction(() => window.blend?.profiles, null, { timeout: 30000 });
await wait(800);
check('after a reload: profiles and mappings kept', (await ev(() => Object.keys(window.blend.profiles.profiles).sort().join())) === 'launch control,minilab 3'
  && (await ev(() => window.blend.profiles.profiles['minilab 3'].bindings.some((b) => b.src === 'cc:1:50'))));

check('no page errors', errors.length === 0, errors.join(' | '));
await page.click('#midi-btn'); await key('m'); await wait(400);
await page.screenshot({ path: `${OUT}phase4-learn.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} MIDI checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
