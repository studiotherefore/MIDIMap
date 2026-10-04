import { fileURLToPath } from 'node:url';
// Phase 2 (browser): live + fade, output window, recording follows the output, mirror latency.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.route('**/api/presets**', (r) => r.fulfill({ json: { presets: {} } }));
// Record when the photo changes, in absolute time, in every page.
await ctx.addInitScript(() => {
  window.__changes = [];
  let last = null;
  const watch = () => {
    const i = window.blend?.S.index;
    if (i !== undefined && i !== last) { if (last !== null) window.__changes.push({ i, t: performance.timeOrigin + performance.now() }); last = i; }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  // Mean brightness of the canvas, read in the same frame it was drawn.
  window.__bright = () => new Promise((res) => requestAnimationFrame(() => {
    const v = document.querySelector('#view');
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 36 });
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    res(Math.round(s / (64 * 36 * 3)));
  }));
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`editor: ${e.message}`));
await page.goto('http://localhost:8000/editor/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer').textContent) && +RegExp.$1 >= 25, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
await page.click('#view', { position: { x: 300, y: 200 } });

check('starts live; top bar live button red', (await ev(() => window.blend.S.live)) && (await ev(() => document.querySelector('#live').classList.contains('on'))));
await page.click('#insp-tabs [data-tab="output"]');
await page.click('#out-mode [data-full="0"]');
const popupP = ctx.waitForEvent('page');
await page.click('#output-window');
const out = await popupP;
out.on('pageerror', (e) => errors.push(`output: ${e.message}`));
await out.waitForLoadState();
await out.waitForFunction(() => window.blend?.S.runA, null, { timeout: 60000 });
await out.waitForTimeout(4000);
check('open output: a picture-only window', (await out.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display)) === 'none');
await wait(1100);
check('status bar: output open, live', (await page.textContent('#status-output')).includes('live'), await page.textContent('#status-output'));
const b1 = await out.evaluate(() => window.__bright());
check('output shows the picture when live', b1 > 40, `brightness ${b1}`);

await key('l');
await wait(900);
const b2 = await out.evaluate(() => window.__bright());
const m2 = await ev(() => window.__bright());
check('L: output fades to black', b2 <= 2, `brightness ${b2}`);
check('editor monitor keeps the picture, dimmed and marked', m2 > 40 && (await ev(() => document.querySelector('#monitor').classList.contains('offair'))) && (await page.textContent('#live-badge')).includes('not live'), `monitor ${m2}`);
// Fade timing: sample the output's fade value as it comes back.
await key('l');
const ramp = [];
for (let i = 0; i < 8; i++) { ramp.push(+(await out.evaluate(() => window.blend.fade)).toFixed(2)); await out.waitForTimeout(100); }
check('L again: fades back in about 0.6 s', ramp[0] < 0.4 && ramp.at(-1) === 1, ramp.join(' '));
const b3 = await out.evaluate(() => window.__bright());
check('output picture back', b3 > 40, `brightness ${b3}`);

// Photo changes reach the output quickly (locked to tempo, 120 BPM, 2 steps per beat).
await out.evaluate(() => {
  window.__changes = [];
  let last = window.blend.S.index;
  const watch = () => { const i = window.blend.S.index; if (i !== last) { window.__changes.push({ i, t: performance.timeOrigin + performance.now() }); last = i; } requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
});
await key('b'); await key('Period');
await key('Space');
await wait(5000);
await key('Space');
const ed = await ev(() => window.__changes);
const oc = await out.evaluate(() => window.__changes);
console.log('editor', ed.slice(-4), 'output', oc.slice(-4), oc.length, await out.evaluate(async () => [window.blend.S.index, document.visibilityState, await new Promise((r) => { let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); setTimeout(() => r('raf stalled ' + n), 2000); })]));
const lags = ed.slice(-8).map((e) => { const o = oc.find((x) => x.i === e.i); return o ? Math.round(o.t - e.t) : null; });
check('output shows each photo change within ~2 frames of the editor', lags.every((l) => l !== null && l < 40), lags.join(' ') + ' ms');

// A recording follows the output: live for 2 s, then faded.
const dl = page.waitForEvent('download');
await key('Space');
await key('v'); await wait(2000); await key('l'); await wait(1800); await key('v');
const file = `${OUT}phase2-rec${(await dl).suggestedFilename().slice(-4)}`;
await (await dl).saveAs(file);
await key('Space'); await key('l');
const b64 = fs.readFileSync(file).toString('base64');
const frames = await ev(async (data) => {
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'video/mp4' }));
  v.muted = true;
  const c = new OffscreenCanvas(32, 18); const g = c.getContext('2d', { willReadFrequently: true });
  const out = [];
  await new Promise((res) => {
    const f = (_, m) => { g.drawImage(v, 0, 0, 32, 18); const d = g.getImageData(0, 0, 32, 18).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; out.push([+m.mediaTime.toFixed(2), Math.round(s / (32 * 18 * 3))]); if (!v.ended) v.requestVideoFrameCallback(f); };
    v.requestVideoFrameCallback(f); v.onended = res; v.play(); setTimeout(res, 8000);
  });
  return out;
}, b64);
const early = frames.filter(([t]) => t < 1.8).map(([, b]) => b);
const late = frames.filter(([t]) => t > frames.at(-1)[0] - 0.6).map(([, b]) => b);
check('recording: picture while live', Math.min(...early) > 40, `min ${Math.min(...early)}`);
check('recording: black after live off (it records the output)', Math.max(...late) <= 3, `max ${Math.max(...late)} over ${late.length} frames`);

await page.click('#output-close');
await wait(500);
check('close output', out.isClosed() && (await page.textContent('#output-window')) === 'open output');
check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: `${OUT}phase2-editor.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} phase 2 browser checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
