import { fileURLToPath } from 'node:url';
// Video recording (V) in the editor and experiment 4: the settings (size, frame
// rate, quality), and the file itself: an ordinary, non-fragmented MP4 (what
// QuickTime needs to trim and export), H.264 + AAC, the chosen size, the
// pictures on a steady 1/fps grid. Real Mapillary, the installed Chrome.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1512, height: 860 }, acceptDownloads: true });
await ctx.route(/\/api\/(projects|presets|midi)/, (r) => r.fulfill({ json: { presets: {}, projects: {}, profiles: {}, updated: {} } }));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };

// ---- reading the file's boxes -------------------------------------------------------------
function boxes(b, start = 0, end = b.length) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const kid = (b, bx, type) => boxes(b, bx.body, bx.end).find((x) => x.type === type);
const path = (b, bx, ...types) => types.reduce((x, t) => x && kid(b, x, t), bx);
function inspect(file) {
  const b = fs.readFileSync(file);
  const top = boxes(b);
  const moov = top.find((x) => x.type === 'moov');
  const mvhd = kid(b, moov, 'mvhd');
  const v = b[mvhd.body];
  const mScale = b.readUInt32BE(mvhd.body + (v ? 20 : 12));
  const mDur = v ? Number(b.readBigUInt64BE(mvhd.body + 24)) : b.readUInt32BE(mvhd.body + 16);
  const tracks = boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak').map((trak) => {
    const tkhd = kid(b, trak, 'tkhd');
    const mdhd = path(b, trak, 'mdia', 'mdhd');
    const scale = b.readUInt32BE(mdhd.body + (b[mdhd.body] ? 20 : 12));
    const stbl = path(b, trak, 'mdia', 'minf', 'stbl');
    const stsd = kid(b, stbl, 'stsd');
    const codec = b.toString('latin1', stsd.body + 12, stsd.body + 16);
    const stts = kid(b, stbl, 'stts');
    const durs = [];
    for (let i = 0, n = b.readUInt32BE(stts.body + 4); i < n; i++) {
      const c = b.readUInt32BE(stts.body + 8 + i * 8);
      const d = b.readUInt32BE(stts.body + 12 + i * 8);
      for (let k = 0; k < c; k++) durs.push(d);
    }
    let profile = null;
    if (codec === 'avc1') {
      const avcC = boxes(b, stsd.body + 16 + 78, kid(b, stbl, 'stsd').end).find((x) => x.type === 'avcC');
      profile = avcC && b[avcC.body + 1];
    }
    return { codec, profile, w: b.readUInt32BE(tkhd.end - 8) / 65536, h: b.readUInt32BE(tkhd.end - 4) / 65536, scale, durs, edts: !!kid(b, trak, 'edts') };
  });
  return { order: top.map((x) => x.type), seconds: mDur / mScale, tracks };
}

async function record(page, seconds) {
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.keyboard.press('v');
  await page.waitForTimeout(400);
  const during = await page.evaluate(() => ({ w: document.querySelector('#view').width, h: document.querySelector('#view').height, locked: [...document.querySelectorAll('#video-size button, #video-fps button')].every((b) => b.disabled) }));
  await page.waitForTimeout(seconds * 1000 - 400);
  const t0 = Date.now();
  await page.keyboard.press('v');
  const d = await dl;
  const file = `${OUT}${d.suggestedFilename()}`;
  await d.saveAs(file);
  return { file, during, prepMs: Date.now() - t0, name: d.suggestedFilename() };
}

function checkFile(label, r, want) {
  const f = inspect(r.file);
  const vt = f.tracks.find((t) => t.codec === 'avc1');
  const at = f.tracks.find((t) => t.codec === 'mp4a');
  check(`${label}: ftyp, moov, mdat, no fragments (QuickTime can edit it)`, f.order.join(' ') === 'ftyp moov mdat', f.order.join(' '));
  check(`${label}: H.264 High profile video + AAC sound`, !!vt && vt.profile === 100 && !!at, f.tracks.map((t) => t.codec).join(' + '));
  check(`${label}: exactly ${want.w}×${want.h}`, vt?.w === want.w && vt?.h === want.h, `${vt?.w}×${vt?.h}`);
  const step = Math.round(vt.scale / want.fps);
  const onGrid = vt.durs.slice(0, -1).every((d) => Math.abs(d / (vt.scale / want.fps) - Math.round(d / (vt.scale / want.fps))) < 0.01);
  const single = vt.durs.filter((d) => Math.abs(d - step) <= 1).length / vt.durs.length;
  check(`${label}: every picture on the 1/${want.fps} s grid`, onGrid, `timescale ${vt.scale}, step ${step}`);
  check(`${label}: a steady ${want.fps} fps (≥ 95% of pictures one step long)`, single >= 0.95, `${(single * 100).toFixed(1)}%, ${vt.durs.length} pictures`);
  const fps = vt.durs.length / (vt.durs.reduce((n, d) => n + d, 0) / vt.scale);
  check(`${label}: ${want.fps} fps on average`, Math.abs(fps - want.fps) < want.fps * 0.05, fps.toFixed(2));
  check(`${label}: as long as the recording`, Math.abs(f.seconds - want.seconds) < 0.6, `${f.seconds.toFixed(2)} s`);
  check(`${label}: named midimap-….mp4`, /^midimap-[\d-]+\.mp4$/.test(r.name), r.name);
  return f;
}

// ---- 1. the editor: settings, then a 1080p 30 fps recording ----------------------------------
let page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8000/editor/');
await page.evaluate(() => localStorage.removeItem('midimap.video.v1'));
await page.reload();
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 15, null, { timeout: 90000 });
await page.click('#insp-tabs [data-tab="output"]');
const on = (sel) => page.evaluate((s) => document.querySelector(`${s} .on`)?.textContent, sel);
check('defaults: 1080p · 30 fps · high', (await on('#video-size')) === '1080p' && (await on('#video-fps')) === '30 fps' && (await on('#video-quality')) === 'high');
check('the output tab says what a recording will be', (await page.textContent('#video-desc')).includes('1920×1080 · 30 fps steady'), await page.textContent('#video-desc'));
await page.click('#video-quality [data-quality="standard"]');
await page.reload();
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 15, null, { timeout: 90000 });
await page.click('#insp-tabs [data-tab="output"]');
check('settings are kept (after a reload)', (await on('#video-quality')) === 'standard');
await page.click('#video-quality [data-quality="high"]');
await page.click('#view', { position: { x: 300, y: 200 } });
await page.keyboard.press('k'); // the kick: a real sound track
await page.keyboard.press('Space');
const monitor = await page.evaluate(() => document.querySelector('#view').width);
const r1 = await record(page, 5);
check('while recording, the picture is drawn at 1920×1080', r1.during.w === 1920 && r1.during.h === 1080, `${r1.during.w}×${r1.during.h}`);
check('… and the settings are locked', r1.during.locked);
check('after: back to the monitor\'s own size', (await page.evaluate(() => document.querySelector('#view').width)) === monitor, `${monitor} px`);
check('saving takes moments, not a conversion', r1.prepMs < 3000, `${r1.prepMs} ms`);
check('the status line says it was saved', (await page.textContent('#status')).includes('Saved'), await page.textContent('#status'));
checkFile('editor 1080p 30', r1, { w: 1920, h: 1080, fps: 30, seconds: 5 });
await page.keyboard.press('Space');
check('editor: no page errors', errors.length === 0, errors.join(' | '));
await page.close();

// ---- 2. experiment 4: 720p 60 fps (the setting is shared) ------------------------------------
page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8000/experiments/record/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 15, null, { timeout: 90000 });
await page.click('#insp-tabs [data-tab="output"]');
check('experiment 4 shares the settings', (await on('#video-size')) === '1080p' && (await on('#video-quality')) === 'high');
await page.click('#video-size [data-size="720"]');
await page.click('#video-fps [data-fps="60"]');
check('720p · 60 fps described', (await page.textContent('#video-desc')).includes('1280×720 · 60 fps steady'), await page.textContent('#video-desc'));
await page.click('#view', { position: { x: 300, y: 200 } });
await page.keyboard.press('Space');
const r2 = await record(page, 4);
checkFile('experiment 4 720p 60', r2, { w: 1280, h: 720, fps: 60, seconds: 4 });
await page.keyboard.press('Space');
await page.click('#video-size [data-size="1080"]');
await page.click('#video-fps [data-fps="30"]');
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`files: ${r1.file} · ${r2.file}`);
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} video checks failed` : `\nall ${results.length} video checks passed`);
process.exit(failed ? 1 : 0);
