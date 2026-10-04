import { fileURLToPath } from 'node:url';
// Phase 5: run strip, loop in/out, place details. Real Mapillary; fake sync service.
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
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ready = (n = 25) => page.waitForFunction((n) => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= n, n, { timeout: 90000 });
await page.goto('http://localhost:8000/editor/');
await ready();
const ev = (f, a) => page.evaluate(f, a);
const S = (k) => ev((k) => window.blend.S[k], k);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
const focus = () => page.click('#view', { position: { x: 300, y: 200 } });
await focus();

// The strip.
await wait(400);
const N = await ev(() => window.blend.S.runA.length);
const px = await ev(() => { const c = document.querySelector('#strip'); const g = c.getContext('2d'); const i = window.blend.S.index; const x = Math.floor(((i + 0.5) / window.blend.S.runA.length) * c.width); const d = g.getImageData(x - 3, Math.round(c.height / 2), 7, 1).data; let best = [0, 0, 0]; for (let k = 0; k < d.length; k += 4) if (d[k] - d[k + 1] > best[0] - best[1]) best = [d[k], d[k + 1], d[k + 2]]; return best; });
check('strip: red mark where we are', px[0] > 200 && px[1] < 120, px.join(','));
const green = await ev(() => { const c = document.querySelector('#strip'); const g = c.getContext('2d'); const d = g.getImageData(0, Math.round(c.height / 2), c.width, 1).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 120 && d[i] < 120) n++; return n; });
check('strip: green where photos are loaded ahead', green > 0, `${green} px`);
const box = await page.locator('#strip').boundingBox();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
const jumped = await S('index');
await page.waitForFunction(() => { const A = window.blend.S.runA; return A.at(window.blend.S.index + 10); }, null, { timeout: 60000 });
check('click the strip: jump a quarter of the way along', Math.abs(jumped - N / 4) < N / 100, `${jumped} of ${N}`);
await ready(20);
check('facts: run, here, heading, other runs', /photos/.test(await page.textContent('#run-facts')) && /°/.test(await page.textContent('#run-facts')) && /within 20 m/.test(await page.textContent('#run-facts')), (await page.textContent('#run-facts')).slice(0, 120));

// The loop.
await focus();
const a = await S('index');
await key('i');
for (let k = 0; k < 10; k++) await key('ArrowRight');
await key('o');
await wait(300);
check('I, then O ten photos on: loop on', (await S('loop')) && (await S('loopIn')) === a && (await S('loopOut')) === a + 10);
check('strip label: the loop, in photos and metres', /loop .* 11 photos .* m/.test(await page.textContent('#strip-loop')), await page.textContent('#strip-loop'));
await ready(11);
await page.click('#speed input, #fps').catch(() => {});
await ev(() => { window.blend.S.fps = 12; });
await focus();
const seen = [];
await key('Space');
for (let k = 0; k < 40; k++) { seen.push(await S('index')); await wait(120); }
await key('Space');
const inside = seen.every((i) => i >= a && i <= a + 10);
const wrapped = seen.some((i, k) => k && seen[k - 1] === a + 10 && i === a);
check('playing stays inside the loop and wraps out → in', inside && wrapped, `${Math.min(...seen)}–${Math.max(...seen)}`);
const bufTxt = await page.textContent('#hud-buffer');
check('photos past the wrap are loaded (buffer follows the loop)', +bufTxt.match(/\d+/)[0] >= 11, bufTxt);
await key('r');
const back = [];
await key('Space');
for (let k = 0; k < 30; k++) { back.push(await S('index')); await wait(120); }
await key('Space');
check('backwards: wraps in → out', back.every((i) => i >= a && i <= a + 10) && back.some((i, k) => k && back[k - 1] === a && i === a + 10));
await key('r');
await key('Shift+I');
check('Shift+I: loop off (switch shows it)', !(await S('loop')) && !(await ev(() => document.querySelector('#loop').classList.contains('on'))));
await key('Shift+I');

// Place details.
await page.click('#below-tabs [data-below="place"]');
await page.waitForFunction(() => { const t = document.querySelector('#place-facts').textContent; return /photographer/.test(t) && !/asking/.test(t); }, null, { timeout: 30000 }).catch(() => {});
const pf = await page.textContent('#place-facts');
check('place: captured, photographer, licence, other dates', /captured/.test(pf) && /photographer/.test(pf) && /CC BY-SA/.test(pf) && !/asking/.test(pf), pf.slice(0, 160));
check('place: link to the photo on mapillary.com', (await page.getAttribute('#place-note a', 'href')).includes('mapillary.com/app/?pKey='));
await page.fill('#place-name', 'the long avenue'); await key('Enter');
check('place: rename the pad from here', (await page.textContent('#slots .slot:nth-child(5) .name')) === 'the long avenue');
await page.selectOption('#place-slot', '6'); await page.click('#place-store');
check('place: store the playing photo on pad 6', (await ev(() => JSON.parse(localStorage.getItem('midimap.fx.slots.v1'))[5].image)) === (await ev(() => window.blend.S.runA.ids[window.blend.S.index])));

// The output follows the loop.
const out = await ctx.newPage();
await out.goto('http://localhost:8000/editor/?output');
await out.waitForTimeout(4000);
check('output window knows the loop', (await out.evaluate(() => [window.blend.S.loop, window.blend.S.loopIn, window.blend.S.loopOut].join())) === [true, a, a + 10].join());
await out.close();

// Projects keep the loop.
await focus();
await key('Meta+s'); await page.fill('#project-name-input', 'loop test'); await key('Enter'); await wait(400);
check('project saves the loop (as photo ids)', !!server.projects['loop test']?.playback.loop?.in && server.projects['loop test'].playback.loop.on === true);
await page.reload();
await page.waitForFunction((a) => window.blend?.S.loopIn === a, a, { timeout: 90000 }).catch(() => {});
check('after a reload: the loop is back', (await S('loop')) && (await S('loopIn')) === a && (await S('loopOut')) === a + 10);
check('loop in / out / on are MIDI-learnable', await ev(() => ['loop', 'loop.in', 'loop.out'].every((id) => window.blend.controls.has(id))));

check('no page errors', errors.length === 0, errors.join(' | '));
await page.click('#below-tabs [data-below="run"]'); await wait(400);
await page.screenshot({ path: `${OUT}phase5.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} phase 5 checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
