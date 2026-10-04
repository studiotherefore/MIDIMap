import { fileURLToPath } from 'node:url';
// Street View in the MIDIMap app: is the key accepted on localhost:8765, does Syphon's output follow?
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { _electron: electron } = require('playwright');
const APPDIR = fileURLToPath(new URL('../../app', import.meta.url)).replace(/\/$/, '');
const app = await electron.launch({ executablePath: `${APPDIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, args: [APPDIR], cwd: APPDIR });
await app.firstWindow();
let page = null;
for (let i = 0; i < 40 && !page; i++) { page = app.windows().find((w) => w.url().endsWith('/editor/')); if (!page) await new Promise((r) => setTimeout(r, 250)); }
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); }); page.on('pageerror', (e) => console.log('PAGEERROR', e.stack.slice(0, 400)));
await page.waitForFunction(() => window.blend?.S.runA, null, { timeout: 90000 });
await page.click('#view', { position: { x: 300, y: 200 } });
await page.keyboard.press('g');
await page.waitForFunction(() => window.blend.sv.ready && window.blend.sv.where()?.lat !== undefined, null, { timeout: 30000 }).catch(() => errors.push('street view not ready after 30 s'));
await page.waitForTimeout(15000);
console.log('editor:', JSON.stringify(await page.evaluate(() => window.blend.sv.where())), '|', await page.textContent('#status'));
const outs = app.windows().filter((w) => w.url().includes('?output'));
for (const w of outs) console.log('output window:', w.url(), await w.evaluate(() => ({ source: window.blend.S.source, where: window.blend.sv?.where(), ready: window.blend.sv?.ready, svState: !!document, google: !!window.google?.maps?.importLibrary, panoKids: document.querySelector('#sv-pano')?.children.length, scripts: [...document.scripts].map((x) => x.src).filter((x) => x.includes('maps')).length, status: document.querySelector('#status').textContent })));
const png = await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('?output') && !x.isVisible()); const img = await w.webContents.capturePage(); return img.resize({ width: 960 }).toPNG().toString('base64'); });
(await import('node:fs')).writeFileSync(fileURLToPath(new URL('output/syphon-out.png', import.meta.url)), Buffer.from(png, 'base64'));
const sy = await page.evaluate(() => window.midimapApp.syphon());
console.log('syphon:', JSON.stringify(sy));
console.log('errors:', errors.length ? errors : 'none');
await page.keyboard.press('g');
await app.close();
