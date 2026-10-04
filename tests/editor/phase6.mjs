import { fileURLToPath } from 'node:url';
// Phase 6: Street View as layer A, against the instrument's Google Maps stand-in (no real Google calls).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const MOCK = fs.readFileSync(new URL('../google-maps-mock.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const server = { projects: {}, presets: {}, profiles: {} };
let mapsRequests = 0;
await ctx.route('https://maps.googleapis.com/**', (r) => { mapsRequests++; return r.fulfill({ contentType: 'text/javascript', body: MOCK }); });
await ctx.route(/\/api\/(projects|presets|midi)/, (route) => {
  const req = route.request();
  const [, coll, raw] = new URL(req.url()).pathname.match(/\/api\/(projects|presets|midi)\/?(.*)/);
  const field = coll === 'midi' ? 'profiles' : coll;
  const name = decodeURIComponent(raw || '');
  if (req.method() === 'GET') return route.fulfill({ json: { [field]: server[field], updated: {} } });
  if (req.method() === 'PUT') { server[field][name] = JSON.parse(req.postData()); return route.fulfill({ json: {} }); }
  return route.fulfill({ json: {} });
});
await ctx.addInitScript(() => {
  const inp = { id: 'm', name: 'Minilab3 MIDI', state: 'connected', onmidimessage: null };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['m', inp]]), onstatechange: null });
  window.__midi = (...b) => inp.onmidimessage({ data: new Uint8Array(b), timeStamp: performance.now() });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8000/editor/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 5, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const S = (k) => ev((k) => window.blend.S[k], k);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
await page.click('#view', { position: { x: 300, y: 200 } });

check('Google is not loaded until Street View is used', mapsRequests === 0);
await key('g');
await page.waitForFunction(() => window.blend.sv.ready && window.__pano, null, { timeout: 20000 });
await wait(700);
check('G: layer A is Street View; its picture shows', (await S('source')) === 'sv' && (await ev(() => !document.querySelector('#sv-stage').hidden)) && (await ev(() => document.querySelector('#source [data-src="sv"]').classList.contains('on'))));
check('asks for Google car imagery first', (await ev(() => window.__svRequests[0])) === 'google');
check('arrives at a panorama', (await ev(() => window.__pano.getPano())) === 'car-start' && (await page.textContent('#hud-a')).includes('street view'));
check('greyed: layer B, blend, echo, recall, hold the sun', await ev(() => ['#layer-b-frame', '#blend-frame', '#sun'].every((s) => document.querySelector(s).classList.contains('na'))
  && [...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('echo')).classList.contains('na')
  && [...document.querySelectorAll('.fx-row')].find((r) => r.textContent.startsWith('recall')).classList.contains('na')));
check('not greyed: brightness, tint, grain', await ev(() => ['brightness', 'tint', 'grain'].every((n) => !document.querySelector(`[data-learn="fx.${n}"]`).classList.contains('na'))));
await ev(() => { window.blend.look.brightness = 1.5; window.blend.look.hue = 90; window.blend.look.tint = 0.6; window.blend.look.posterize = 0.5; });
await wait(200);
const css = await ev(() => document.querySelector('#sv-pano').style.filter);
check('effects reach Google\'s picture (CSS filters, posterize filter, tint overlay)', css.includes('brightness(1.5)') && css.includes('hue-rotate(90deg)') && css.includes('url(') && (await ev(() => +document.querySelector('.sv-tint').style.opacity)) === 0.6, css);
await ev(() => { Object.assign(window.blend.look, { brightness: 1, hue: 0, tint: 0, posterize: 0 }); });

// Travel on the tempo: hops, never closer than 0.9 s.
const calls0 = await ev(() => window.__setPanoCalls.length);
await key('b'); await key('Period'); // 120 BPM, 2 steps per beat = a step every 250 ms
await key('Space');
await wait(4000);
await key('Space');
const hops = (await ev(() => window.__setPanoCalls.slice())).slice(calls0);
check('travel: hops along the road on the beat, at most every 0.9 s', hops.length >= 3 && hops.length <= 5 && hops.every((p) => p.startsWith('fwd')), `${hops.length} hops in 4 s: ${hops.join(' ')}`);
await key('Comma');
// Drift.
await page.click('#sv-motion [data-motion="drift"]');
const h0 = await ev(() => window.__pano.getPov().heading);
await key('Space'); await wait(1500); await key('Space');
const h1 = await ev(() => window.__pano.getPov().heading);
check('drift: turns in place', Math.abs(((h1 - h0 + 540) % 360) - 180) > 5, `${h0.toFixed(1)} → ${h1.toFixed(1)}`);
await ev(() => window.__midi(0xb0, 114, 74)); await wait(300);
const h2 = await ev(() => window.__pano.getPov().heading);
check('the endless main knob turns Street View', Math.abs(((h2 - h1 + 540) % 360) - 180) > 20, `${h1.toFixed(1)} → ${h2.toFixed(1)}`);
await ev(() => window.__midi(0xb0, 1, 127)); await wait(1200);
check('the mod strip looks up', (await ev(() => window.__pano.getPov().pitch)) > 60, await ev(() => window.__pano.getPov().pitch));
await ev(() => window.__midi(0xb0, 1, 0));

// Places.
await key('Alt+Digit7');
const slot7 = await ev(() => JSON.parse(localStorage.getItem('midimap.fx.slots.v1'))[6]);
check('Option+7 stores this Street View on pad 7', slot7.source === 'sv' && !!slot7.pano && (await page.textContent('#slots .slot:nth-child(7) .src')).includes('street view'), JSON.stringify(slot7).slice(0, 90));
await key('g');
await wait(500);
check('G again: back to Mapillary (picture hidden)', (await S('source')) === 'mapillary' && (await ev(() => document.querySelector('#sv-stage').hidden)));
await key('Digit7');
await page.waitForFunction((p) => window.blend.S.source === 'sv' && window.__pano.getPano() === p, slot7.pano, { timeout: 10000 }).catch(() => {});
check('pad 7 brings Street View back at that panorama', (await S('source')) === 'sv' && (await ev(() => window.__pano.getPano())) === slot7.pano);

// Output window follows, and fades.
const out = await ctx.newPage();
out.on('pageerror', (e) => errors.push(`output: ${e.message}`));
await out.goto('http://localhost:8000/editor/?output');
await out.waitForFunction(() => window.blend?.sv?.ready, null, { timeout: 20000 }).catch(() => {});
await out.waitForTimeout(1500);
check('output window shows the same panorama', (await out.evaluate(() => window.__pano?.getPano())) === (await ev(() => window.__pano.getPano())));
await key('l'); await out.waitForTimeout(900);
check('live off fades the output\'s Street View to black', +(await out.evaluate(() => document.querySelector('.sv-fade').style.opacity)) === 1);
check('… while the editor\'s monitor keeps the picture', +(await ev(() => document.querySelector('.sv-fade').style.opacity)) === 0);
await key('l');
await out.close();

// Things that need Mapillary say so.
await key('v'); await wait(200);
check('V explains that Street View can\'t be recorded here', (await page.textContent('#status')).includes("can't be recorded"));
await key('s');
check('S explains hold the sun needs Mapillary', (await page.textContent('#status')).includes('Hold the sun needs Mapillary') && !(await S('sun')));

// Map click goes to Street View there.
const reqs = await ev(() => window.__svRequests.length);
await page.mouse.click(120, 200); await wait(800);
check('clicking the map goes to Street View there', (await ev(() => window.__svRequests.length)) > reqs);

// Projects keep Street View.
await key('Meta+s'); await page.fill('#project-name-input', 'sv test'); await key('Enter'); await wait(400);
check('a project keeps Street View (source, panorama, motion)', server.projects['sv test']?.layers.source === 'sv' && !!server.projects['sv test'].streetview?.pano);
const savedPano = server.projects['sv test'].streetview.pano;
await page.reload();
await page.waitForFunction(() => window.blend?.sv?.ready, null, { timeout: 30000 }).catch(() => {});
await wait(1200);
check('after a reload: back in Street View at that panorama', (await S('source')) === 'sv' && (await ev(() => window.__pano?.getPano())) === savedPano);

check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: `${OUT}phase6.png` });
console.log(results.every(Boolean) ? `\nall ${results.length} street view checks passed` : '\nSOME CHECKS FAILED');
await browser.close();
