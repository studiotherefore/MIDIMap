import { fileURLToPath } from 'node:url';
// Real Google Street View in a visible Chrome: does the picture render, do hops and effects work?
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const url = process.argv[2] || 'http://localhost:8000/editor/';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, args: ['--mute-audio'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route(/\/api\/(projects|presets|midi)/, (r) => r.fulfill({ json: { presets: {}, projects: {}, profiles: {}, updated: {} } }));
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && /google|maps|Map/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
let tiles = 0;
p.on('response', (r) => { if (/streetviewpixels|cbk|geo\d\.ggpht|lh3\.googleusercontent/.test(r.url())) { tiles++; if (r.status() >= 400) errors.push(`${r.status()} ${r.url().slice(0, 80)}`); } });
await p.goto(url);
await p.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 3, null, { timeout: 90000 });
await p.click('#view', { position: { x: 300, y: 200 } });
await p.keyboard.press('g');
await p.waitForFunction(() => window.blend.sv.ready && window.blend.sv.where()?.pano, null, { timeout: 30000 }).catch(() => errors.push('street view never ready'));
await p.waitForTimeout(5000);
const w = await p.evaluate(() => window.blend.sv.where());
console.log('arrived:', JSON.stringify(w), '| status:', await p.textContent('#status'), '| tiles loaded:', tiles);
await p.screenshot({ path: `${OUT}sv-real-1.png` });
// Travel: a few hops on the tempo.
const before = w?.pano;
await p.keyboard.press('b'); await p.keyboard.press('Space');
await p.waitForTimeout(4000);
await p.keyboard.press('Space');
const after = await p.evaluate(() => window.blend.sv.where());
console.log('after 4 s of travel:', after?.pano !== before ? 'moved' : 'did not move', JSON.stringify(after));
// A look on Google's picture.
await p.evaluate(() => Object.assign(window.blend.look, { contrast: 1.6, saturation: 0.3, tint: 0.5, grain: 0.3 }));
await p.waitForTimeout(1500);
await p.screenshot({ path: `${OUT}sv-real-2.png` });
console.log('errors:', errors.length ? errors : 'none');
await b.close();
