import { fileURLToPath } from 'node:url';
// Phase 3: projects. Uses a fake sync service, so nothing real is written.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const server = { projects: {}, presets: {}, up: true };
await ctx.route(/\/api\/(projects|presets)/, (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const [, coll, rawName] = url.pathname.match(/\/api\/(projects|presets)\/?(.*)/);
  if (!server.up) return route.abort('internetdisconnected');
  const name = decodeURIComponent(rawName || '');
  const headers = { 'access-control-allow-origin': '*' };
  if (req.method() === 'GET') return route.fulfill({ json: { [coll]: server[coll], updated: {} }, headers });
  if (req.method() === 'PUT') { server[coll][name] = JSON.parse(req.postData()); return route.fulfill({ json: { saved: name }, headers }); }
  if (req.method() === 'DELETE') { delete server[coll][name]; return route.fulfill({ json: { deleted: name }, headers }); }
  return route.fulfill({ json: {}, headers });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ready = () => page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 5, null, { timeout: 90000 });
await page.goto('http://localhost:8000/editor/');
await ready();
const ev = (f, a) => page.evaluate(f, a);
const S = (k) => ev((k) => window.blend.S[k], k);
const q = (sel) => page.textContent(sel);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
const focusView = () => page.click('#view', { position: { x: 300, y: 200 } });
const state = async () => { await wait(1100); return q('#project-state'); };

check('starts untitled, not saved', (await q('#project-name')) === 'untitled' && (await state()).includes('not saved'));

// Make a setup.
await focusView();
await key('k');                                   // kick 808 (+ tempo lock)
await key('Equal');                               // 121 BPM
await ev(() => { window.blend.look.bloom = 0.5; });
await key('Alt+Digit3');                          // place 3 = this exact photo
await page.click('#bmode [data-b="off"]');
await page.click('#insp-tabs [data-tab="camera"]'); await page.click('#follow');
await focusView();
await key('r');                                   // backward
await key('ArrowRight'); await key('ArrowRight');
const where = await ev(() => ({ seq: window.blend.S.runA.id, image: window.blend.S.runA.ids[window.blend.S.index] }));

// ⌘S on an untitled project asks for a name.
await key('Meta+s');
check('⌘S (untitled) opens the menu with a name box', !(await page.isHidden('#project-menu')) && (await ev(() => document.activeElement.id)) === 'project-name-input');
await page.fill('#project-name-input', 'test set');
await key('Enter');
await wait(400);
check('saved to the sync service', server.projects['test set']?.version === 1);
const saved = server.projects['test set'];
check('the project holds the setup', saved.audio.kick === '808' && saved.tempo.bpm === 121 && saved.effects.bloom === 0.5
  && saved.places[2].image && saved.layers.bMode === 'off' && saved.camera.follow === false && saved.playback.dir === -1
  && saved.playback.photo.image === where.image, JSON.stringify({ kick: saved.audio.kick, bpm: saved.tempo.bpm, photo: saved.playback.photo?.image }));
check('top bar: name and ● saved', (await q('#project-name')) === 'test set' && (await state()) === '● saved');

await ev(() => { window.blend.look.bloom = 0.8; });
check('a change shows ● unsaved changes', (await state()).includes('unsaved'));
await key('Meta+s'); await wait(400);
check('⌘S saves it again', server.projects['test set'].effects.bloom === 0.8 && (await state()) === '● saved');

// While playing, moving along the run doesn't count as a change.
await key('Space'); await wait(2500); await key('Space');
check('playing along the run is not an unsaved change', (await state()) === '● saved');

// New: defaults.
await page.click('#project-btn');
await page.click('#project-new');
await wait(300);
check('new project: defaults (no kick, 120 BPM, no bloom, place 3 back to default)',
  (await ev(() => window.blend.kick.type)) === 'off' && (await S('bpm')) === 120 && (await ev(() => window.blend.look.bloom)) === 0
  && !(await ev(() => JSON.parse(localStorage.getItem('midimap.fx.slots.v1'))[2].image)) && (await q('#project-name')) === 'untitled');
await ready();

// Open it back.
await page.click('#project-btn');
await ev(() => [...document.querySelectorAll('#project-list li')].find((li) => li.textContent.includes('test set')).click());
await page.waitForFunction((img) => window.blend.S.runA?.ids[window.blend.S.index] === img, saved.playback.photo.image, { timeout: 90000 }).catch(() => {});
check('open: every setting comes back', (await ev(() => window.blend.kick.type)) === '808' && (await S('bpm')) === 121
  && (await ev(() => window.blend.look.bloom)) === 0.8 && (await S('bMode')) === 'off' && (await S('follow')) === false && (await S('dir')) === -1
  && (await q('#slots .slot:nth-child(3) .src')).includes('exact'));
check('open: back at the saved photo', (await ev(() => window.blend.S.runA?.ids[window.blend.S.index])) === saved.playback.photo.image);
check('open: switches and buttons show it', await ev(() => document.querySelector('#kick-type [data-kick="808"]').classList.contains('on') && !document.querySelector('#follow').classList.contains('on')));

// Reload: still the same project.
await page.reload();
await ready();
check('after a reload: same project, saved, same settings', (await q('#project-name')) === 'test set' && (await state()) === '● saved'
  && (await ev(() => window.blend.look.bloom)) === 0.8 && (await S('bpm')) === 121);
check('after a reload: back at the saved photo', (await ev(() => window.blend.S.runA?.ids[window.blend.S.index])) === saved.playback.photo.image);

// Unsaved changes survive a reload.
await ev(() => { window.blend.look.grain = 0.4; });
await wait(1200);
await page.reload();
await ready();
check('unsaved changes survive a reload (marked unsaved)', (await ev(() => window.blend.look.grain)) === 0.4 && (await state()).includes('unsaved'));

// Export and import.
await page.click('#project-btn');
const dl = page.waitForEvent('download');
await page.click('#project-export');
const file = `${OUT}test-set.midimap.json`;
await (await dl).saveAs(file);
const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
check('export file: a versioned project', exported.version === 1 && exported.name === 'test set' && exported.effects.grain === 0.4);
page.once('dialog', (d) => d.accept());
await page.setInputFiles('#project-import', file);
await wait(800);
check('import: added under a new name and opened', 'test set (imported)' in server.projects && (await q('#project-name')) === 'test set (imported)');

// Rename and delete.
await page.click('#project-btn');
await page.fill('#project-name-input', 'gig copy');
await page.click('#project-rename');
await wait(600);
check('rename', 'gig copy' in server.projects && !('test set (imported)' in server.projects) && (await q('#project-name')) === 'gig copy');
page.once('dialog', (d) => d.accept());
await ev(() => [...document.querySelectorAll('#project-list li')].find((li) => li.textContent.includes('gig copy')).querySelector('.x').click());
await wait(500);
check('delete: gone, editor back to untitled', !('gig copy' in server.projects) && (await q('#project-name')) === 'untitled');

// Offline: saved in this browser, uploaded when back.
server.up = false;
await page.click('#project-btn');
await page.fill('#project-name-input', 'offline set');
await key('Enter');
await wait(500);
check('offline: saved in this browser only', !('offline set' in server.projects) && (await q('#project-list')).includes('this browser only'));
server.up = true;
await page.reload();
await ready();
await wait(1500);
check('back online: uploaded', 'offline set' in server.projects);

check('no page errors', errors.length === 0, errors.join(' | '));
await page.click('#project-btn');
await page.screenshot({ path: `${OUT}projects-menu.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} project checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
