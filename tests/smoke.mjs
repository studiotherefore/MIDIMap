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
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
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

async function open(url, { mock = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(() => {
    const input = { name: 'Fake controller', id: 'x', onmidimessage: null };
    window.__midi = (...bytes) => input.onmidimessage({ data: new Uint8Array(bytes) });
    navigator.requestMIDIAccess = async () => ({ inputs: new Map([['x', input]]), onstatechange: null });
  });
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
  await page.evaluate(() => { window.__midi(0xb0, 74, 100); window.__midi(0xb0, 74, 0); });
  await page.waitForTimeout(50);
  check('learned CC74 sets speed', (await text(page, '#hud-speed')) === 'speed -10');

  await learn(page, 'Go to 5');
  await page.evaluate(() => { window.__midi(0x90, 60, 90); window.__midi(0x80, 60, 0); window.__midi(0x90, 60, 90); });
  await page.waitForTimeout(700);
  check('learned note jumps to slot 5', (await text(page, '#hud-location')) === 'Piazza San Marco, Venice');

  await learn(page, 'Pause');
  await page.keyboard.press('KeyQ'); await page.keyboard.press('Escape'); await page.keyboard.press('KeyQ');
  check('learned key toggles pause', (await text(page, '#hud-mode')).includes('PAUSED'));
  check('bindings persist', await page.evaluate(() => localStorage.getItem('midimap.bindings.v1').includes('KeyQ')));

  check('no script errors', page.errors.length === 0, page.errors.join('; '));
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

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
