// End-to-end smoke test: serves the app, swaps Google Maps for a mock,
// fakes a MIDI device, and drives the page in headless Chromium.
//
//   npm install      (once)
//   npm test
//
// Real Street View imagery is never loaded; this checks our code, not Google's.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = fs.readFileSync(path.join(root, 'tests/google-maps-mock.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  // Never serve the author's real key file (config.local.json) to the tests.
  if (!file.startsWith(root) || file.endsWith('.local.json') || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// device: whether the fake MIDI controller starts plugged in. __plug(on) plugs/unplugs it later.
async function open(url, { mock = true, device = true, setup } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript((plugged) => {
    const input = { name: 'Fake controller', id: 'x', state: 'connected', onmidimessage: null };
    const access = { inputs: new Map(plugged ? [['x', input]] : []), onstatechange: null };
    window.__midi = (...bytes) => input.onmidimessage({ data: new Uint8Array(bytes) });
    window.__plug = (on) => {
      if (on) access.inputs.set('x', input); else access.inputs.delete('x');
      access.onstatechange?.({ port: input });
    };
    navigator.requestMIDIAccess = async () => access;
  }, device);
  if (setup) await setup(page);
  if (mock) await page.route('https://maps.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  await page.goto(url);
  await page.waitForTimeout(1500);
  return page;
}

const text = (page, sel) => page.textContent(sel);
const pov = (page) => page.evaluate(() => window.__pano.getPov());
const learn = (page, rowText) => page.locator('#mappings tr', { hasText: rowText }).getByRole('button', { name: 'Learn' }).click();

// ---- startup ---------------------------------------------------------------
{
  const page = await open(`${base}/?key=TESTabcd`);
  const steps = await page.$$eval('#checklist-items li', (l) => l.map((x) => x.className));
  check('startup checklist all green', steps.length === 5 && steps.every((s) => s === 'ok'), steps.join(','));
  const box = await page.evaluate(() => { const r = document.getElementById('pano').getBoundingClientRect(); return [r.width, r.height]; });
  check('viewer fills the screen', box[0] === 1000 && box[1] === 600, box.join('x'));
  check('arrives at slot 1', (await text(page, '#hud-location')) === 'Times Square, New York');

  // ---- keyboard ------------------------------------------------------------
  const h1 = (await pov(page)).heading;
  await page.waitForTimeout(1000);
  const drift = (await pov(page)).heading - h1;
  check('drift turns ~9°/s at speed 3', drift > 7 && drift < 11, drift.toFixed(1));

  await page.keyboard.press('Equal'); await page.keyboard.press('Equal'); await page.keyboard.press('Minus');
  check('+/− change speed', (await text(page, '#hud-speed')) === 'speed +4');

  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(600); await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(800);
  const pitch = (await pov(page)).pitch;
  check('holding ↑ tilts up', pitch > 20, pitch.toFixed(1));

  await page.keyboard.press('Digit2'); await page.waitForTimeout(700);
  check('number key changes location', (await text(page, '#hud-location')) === 'Shibuya Crossing, Tokyo');

  await page.keyboard.press('KeyM');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Equal');
  await page.evaluate(() => { window.__setPanoCalls.length = 0; });
  await page.waitForTimeout(2500);
  const steps2 = await page.evaluate(() => window.__setPanoCalls.length);
  check('travel mode steps along links', steps2 >= 2, `${steps2} steps in 2.5s`);
  await page.keyboard.press('KeyM');

  // ---- MIDI ----------------------------------------------------------------
  await page.evaluate(() => window.__midi(0xb2, 1, 127)); await page.waitForTimeout(1200);
  const modPitch = (await pov(page)).pitch;
  check('mod wheel (CC1, any channel) tilts', modPitch > 75, modPitch.toFixed(1));

  await page.keyboard.press('Backquote');
  check('key panel shows saved key', (await text(page, '#api-key-state')).includes('…abcd'));

  await learn(page, 'Tilt (mod wheel');
  await page.keyboard.press('KeyQ'); await page.waitForTimeout(100);
  check('knob action refuses a key', (await text(page, '#toast')).includes('needs a knob'));
  await page.keyboard.press('Escape');

  await learn(page, 'Speed (knob');
  // A knob learn listens briefly (to spot endless knobs) before it binds.
  await page.evaluate(() => window.__midi(0xb0, 74, 100)); await page.waitForTimeout(500);
  await page.evaluate(() => window.__midi(0xb0, 74, 0)); await page.waitForTimeout(50);
  check('learned CC74 sets speed', (await text(page, '#hud-speed')) === 'speed -10');

  await learn(page, 'Go to 5');
  await page.evaluate(() => { window.__midi(0x90, 60, 90); window.__midi(0x80, 60, 0); window.__midi(0x90, 60, 90); });
  await page.waitForTimeout(700);
  check('learned note jumps to slot 5', (await text(page, '#hud-location')) === 'Piazza San Marco, Venice');

  await learn(page, 'Pause');
  await page.keyboard.press('KeyQ'); await page.keyboard.press('Escape'); await page.keyboard.press('KeyQ');
  check('learned key toggles pause', (await text(page, '#hud-mode')).includes('PAUSED'));
  check('bindings persist', await page.evaluate(() => localStorage.getItem('midimap.bindings.v1').includes('KeyQ')));

  // ---- Arturia MiniLab 3 (byte sequences recorded from the real hardware) ----
  // Pads send bank select (CC0, CC32) then a program change; the main knob is endless (64 ± steps).
  const pad = (n) => page.evaluate((p) => { window.__midi(0xb0, 0, 0); window.__midi(0xb0, 32, 0); window.__midi(0xc0, p); }, n);
  await page.keyboard.press('Escape'); await page.keyboard.press('Backquote');

  await pad(7); await page.waitForTimeout(700);
  check('MiniLab pad 8 jumps to place 8 out of the box', (await text(page, '#hud-location')) === 'Karl-Marx-Allee, Berlin');
  await pad(0); await page.waitForTimeout(700);
  check('MiniLab pad 1 jumps to place 1 out of the box', (await text(page, '#hud-location')) === 'Times Square, New York');

  await learn(page, 'Tilt (mod wheel');
  await pad(2); await page.waitForTimeout(100);
  check('MiniLab pad: knob action refuses a program change', (await text(page, '#toast')).includes('single press'));
  await page.keyboard.press('Escape'); // cancels the learn; the panel stays open

  await learn(page, 'Go to 3');
  await pad(2); await page.waitForTimeout(100);
  check('MiniLab pad: learns as Program 3, not bank select', (await text(page, '#toast')).includes('Program 3 (ch 1)'));
  await pad(2); await page.waitForTimeout(700);
  check('MiniLab pad: jumps to slot 3', (await text(page, '#hud-location')) === 'Pripyat, Ukraine');
  await page.keyboard.press('Digit4'); await page.waitForTimeout(700);
  await pad(2); await page.waitForTimeout(700);
  check('MiniLab pad: fires again on the next press', (await text(page, '#hud-location')) === 'Pripyat, Ukraine');

  await learn(page, 'Direction');
  await page.evaluate(() => { for (const v of [65, 65, 66, 65]) window.__midi(0xb0, 114, v); });
  await page.waitForTimeout(500);
  check('MiniLab main knob: recognised as endless', (await text(page, '#toast')).includes('CC 114 (ch 1), endless knob'));
  check('MiniLab main knob: marked ∞ in the panel', (await page.locator('.chip.endless', { hasText: 'CC 114' }).count()) === 1);
  if (!(await text(page, '#hud-mode')).includes('PAUSED')) await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const e0 = (await pov(page)).heading;
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.__midi(0xb0, 114, 65); });
  await page.waitForTimeout(100);
  const e1 = ((await pov(page)).heading - e0 + 360) % 360;
  check('MiniLab main knob: 10 steps right turn 30°', Math.abs(e1 - 30) < 1, e1.toFixed(1));
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__midi(0xb0, 114, 63); });
  await page.waitForTimeout(100);
  const e2 = ((await pov(page)).heading - e0 + 360) % 360;
  check('MiniLab main knob: 5 steps left turn back 15°', Math.abs(e2 - 15) < 1, e2.toFixed(1));

  await learn(page, 'Tilt (mod wheel');
  await page.evaluate(() => { for (const v of [60, 61, 62, 63]) window.__midi(0xb0, 82, v); });
  await page.waitForTimeout(500);
  check('MiniLab fader: an ordinary knob near the middle is not taken for endless',
    (await text(page, '#toast')).includes('CC 82 (ch 1) →'));

  check('no script errors', page.errors.length === 0, page.errors.join('; '));
  await page.close();
}

// ---- keyboard stand-in controller -------------------------------------------------
{
  const page = await open(`${base}/?key=TESTabcd`, { device: false });
  const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };

  check('stand-in: on when no controller', (await text(page, '#hud-midi')) === 'input: keyboard controller');

  await hold('KeyT', 500); await page.waitForTimeout(800);
  const tilt = (await pov(page)).pitch;
  check('stand-in: holding T tilts up (mod wheel)', tilt > 30, tilt.toFixed(1));

  await hold('KeyW', 1000);
  const speed = parseFloat((await text(page, '#hud-speed')).replace('speed ', ''));
  check('stand-in: holding W raises speed', speed >= 8, String(speed));

  await page.keyboard.press('Space'); // pause drift so only the knob turns the view
  const h0 = (await pov(page)).heading;
  await hold('KeyD', 1000); await page.waitForTimeout(100);
  const turned = ((await pov(page)).heading - h0 + 360) % 360;
  check('stand-in: holding D turns right ~90°', turned > 65 && turned < 115, turned.toFixed(1));
  await hold('KeyA', 500); await page.waitForTimeout(100);
  const back = ((await pov(page)).heading - h0 + 360) % 360;
  check('stand-in: A turns back left', back < turned - 25, back.toFixed(1));

  await page.keyboard.press('Backquote');
  await learn(page, 'Tilt (mod wheel');
  await page.keyboard.press('KeyX'); await page.waitForTimeout(100);
  check('stand-in: knob action refuses a pad', (await text(page, '#toast')).includes('not a note'));
  await page.keyboard.press('Escape');

  await learn(page, 'Go to 5');
  await page.keyboard.press('KeyZ'); await page.waitForTimeout(100);
  check('stand-in: pad learns as a MIDI note', (await text(page, '#toast')).includes('Note C2 (ch 1)'));
  await page.keyboard.press('KeyZ'); await page.waitForTimeout(700);
  check('stand-in: learned pad jumps to slot 5', (await text(page, '#hud-location')) === 'Piazza San Marco, Venice');
  check('stand-in: last input marked [keyboard]', (await text(page, '#activity')).includes('[keyboard]'));

  await page.evaluate(() => window.__plug(true)); await page.waitForTimeout(100);
  check('stand-in: off when a controller is plugged in', (await text(page, '#hud-midi')) === 'input: Fake controller');
  const before = await text(page, '#hud-speed');
  await hold('KeyS', 400);
  check('stand-in: keys inert while off', (await text(page, '#hud-speed')) === before);

  await page.keyboard.press('KeyP');
  check('stand-in: P turns it back on', (await text(page, '#hud-midi')) === 'input: Fake controller + keyboard controller');
  await page.keyboard.press('KeyP');
  await page.evaluate(() => window.__plug(false)); await page.waitForTimeout(100);
  check('stand-in: on again after unplugging', (await text(page, '#hud-midi')) === 'input: keyboard controller');

  check('stand-in: no script errors', page.errors.length === 0, page.errors.join('; '));
  await page.close();
}

// ---- imagery source: Google's car imagery first, contributed photos only as a fallback ----
{
  const page = await open(`${base}/?key=TESTabcd`, {
    setup: (p) => p.addInitScript(() => localStorage.setItem('midimap.locations.v1',
      JSON.stringify({ 9: { name: 'Polar test', lat: 85, lng: 0, heading: 0, pitch: 0 } }))),
  });
  const first = await page.evaluate(() => [window.__svRequests[0], window.__setPanoCalls[0]]);
  check('imagery: asks for Google car imagery first', first[0] === 'google', first[0]);
  check('imagery: shows car imagery when there is some', first[1] === 'car-start', first[1]);
  await page.keyboard.press('Digit9'); await page.waitForTimeout(700);
  const last = await page.evaluate(() => [window.__svRequests.slice(-2).join(' then '), window.__setPanoCalls.at(-1)]);
  check('imagery: falls back to contributed photos where no car imagery', last[1] === 'photo-start', last.join(' / '));
  check('imagery: fallback still arrives', (await text(page, '#hud-location')) === 'Polar test');
  await page.close();
}

// ---- mappings saved by the first version gain the new defaults -------------------------
{
  const page = await open(`${base}/?key=TESTabcd`, {
    setup: (p) => p.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('midimap.bindings.v1', JSON.stringify({ 'key:Space': 'pause', 'midi:cc:1:74': 'pause' }));
    }),
  });
  const b = await page.evaluate(() => JSON.parse(localStorage.getItem('midimap.bindings.v1')));
  check('upgrade: adds the direction knob default', b['midi:cc:1:71'] === 'heading.set');
  check('upgrade: keeps an input already in use', b['midi:cc:1:74'] === 'pause');
  check('upgrade: adds the MiniLab pads', b['midi:pc:*:0'] === 'goto.1' && b['midi:pc:*:7'] === 'goto.8');
  await page.close();
}

// ---- key from config.local.json -----------------------------------------------------
{
  const page = await open(`${base}/`, {
    setup: (p) => p.route('**/config.local.json', (r) => r.fulfill({ contentType: 'application/json', body: '{"mapsApiKey":"FILEwxyz"}' })),
  });
  const steps = await page.$$eval('#checklist-items li', (l) => l.map((x) => x.className));
  check('key file: startup checklist all green', steps.every((s) => s === 'ok'), steps.join(','));
  check('key file: checklist says where the key came from', (await text(page, '#checklist-items')).includes('…wxyz (from the server)'));
  await page.close();
}

// ---- no key ------------------------------------------------------------------
{
  const page = await open(`${base}/`, { mock: false });
  const steps = await page.$$eval('#checklist-items li', (l) => l.map((x) => x.className));
  check('no key: checklist flags the key step', steps[1] === 'fail', steps.join(','));
  check('no key: settings panel opens', await page.isVisible('#panel'));
  await page.close();
}

// ---- Cloudflare Worker: serves the key from a secret, never from a file ------------------
{
  const { default: worker } = await import('../src/worker.js');
  const assets = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) };
  const get = (p, env) => worker.fetch(new Request(`https://midimap.example${p}`), env);

  const res = await get('/config.local.json', { ASSETS: assets, MAPS_API_KEY: 'SECRETkey1' });
  const body = await res.json();
  check('worker: key file comes from the secret', body.mapsApiKey === 'SECRETkey1');
  check('worker: key file is never cached', res.headers.get('cache-control') === 'no-store');
  const none = await get('/config.local.json', { ASSETS: assets });
  check('worker: no secret set → 404, so the page falls back to the browser key', none.status === 404);
  check('worker: other paths are the site files', (await (await get('/js/main.js', { ASSETS: assets })).text()) === 'asset /js/main.js');

  const ignore = fs.readFileSync(path.join(root, '.assetsignore'), 'utf8');
  check('worker: local key file is never uploaded', /^\*\.local\.json$/m.test(ignore));
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
